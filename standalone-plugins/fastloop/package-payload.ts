import { createHash } from "node:crypto";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const fileSchema = z.union([
  z.strictObject({
    path: z.string(),
    sha256: digestSchema,
    bytes: z.number().int().nonnegative(),
    mode: z.number().int().min(0).max(511),
  }),
  z.strictObject({ path: z.string(), link: z.string() }),
]);

export const runtimeManifestSchema = z.strictObject({
  schema: z.literal(1),
  packageVersion: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  sourceRevision: z.string().min(1),
  sourceDirty: z.boolean(),
  sourceHash: digestSchema,
  packagerSha256: digestSchema,
  compatibilityLockHash: digestSchema,
  node: z.literal(">=24 <25"),
  qualifiedPlatforms: z.array(z.strictObject({ platform: z.string(), arch: z.string() })).min(1),
  entries: z.strictObject({
    sdk: z.string(),
    cli: z.string(),
    service: z.string(),
    mcp: z.string(),
  }),
  native: z.strictObject({
    package: z.literal("agent-browser"),
    version: z.string(),
    binaryName: z.string(),
    binarySha256: digestSchema,
    archive: z.string(),
    archiveSha256: digestSchema,
  }),
  browser: z.strictObject({
    install: z.literal("explicit-existing-Chrome"),
    sandboxRequired: z.literal(true),
  }),
  files: z.array(fileSchema).min(1).max(20000),
});

export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;

export const runtimeLockSchema = z.strictObject({
  schema: z.literal(1),
  packageVersion: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  packageSha256: digestSchema,
  manifestSha256: digestSchema,
  compatibilityLockHash: digestSchema,
  nativeArchiveSha256: digestSchema,
});

export type RuntimeLock = z.infer<typeof runtimeLockSchema>;

export interface ArchiveMember {
  path: string;
  kind: "file" | "directory" | "symlink" | "hardlink";
  mode: number;
  data: Buffer;
  link: string;
}

export class PayloadError extends Error {
  readonly code: string;
  readonly path: string | undefined;
  constructor(code: string, path?: string) {
    super(code);
    this.name = "PayloadError";
    this.code = code;
    this.path = path;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasControl(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function path(value: string): string {
  const normalized = value.replace(/\/$/, "");

  if (
    !normalized ||
    normalized.length > 4096 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\\") ||
    hasControl(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new PayloadError("ARCHIVE_PATH_INVALID");

  return normalized;
}

function number(bytes: Buffer): number {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();

  if (text && !/^[0-7]+$/.test(text)) throw new PayloadError("ARCHIVE_NUMBER_INVALID");
  const value = text ? Number.parseInt(text, 8) : 0;

  if (!Number.isSafeInteger(value) || value < 0) throw new PayloadError("ARCHIVE_NUMBER_INVALID");

  return value;
}

function linkTarget(member: ArchiveMember): string {
  if (
    !member.link ||
    posix.isAbsolute(member.link) ||
    /^[A-Za-z]:/.test(member.link) ||
    member.link.includes("\\") ||
    hasControl(member.link)
  )
    throw new PayloadError("ARCHIVE_LINK_ESCAPE");

  let namedComponent = false;

  for (const component of member.link.split("/")) {
    if (component === ".." && namedComponent) throw new PayloadError("ARCHIVE_LINK_ESCAPE");

    if (component && component !== "." && component !== "..") namedComponent = true;
  }

  const target =
    member.kind === "hardlink"
      ? member.link
      : posix.normalize(posix.join(posix.dirname(member.path), member.link));

  if (target.split("/")[0] !== member.path.split("/")[0])
    throw new PayloadError("ARCHIVE_LINK_ESCAPE");

  return path(target);
}

export function inspectTar(compressed: Buffer): Map<string, ArchiveMember> {
  if (compressed.byteLength > 64 * 1024 * 1024) throw new PayloadError("ARCHIVE_BYTES_EXCEEDED");
  let bytes: Buffer;

  try {
    bytes = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  } catch {
    throw new PayloadError("ARCHIVE_DECOMPRESSION_INVALID");
  }

  const members = new Map<string, ArchiveMember>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pax = new Map<string, string>();
  let ended = false;

  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || !bytes.subarray(offset).every((byte) => byte === 0))
        throw new PayloadError("ARCHIVE_TRAILING_DATA");
      ended = true;
      break;
    }

    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );

    if (checksum !== number(header.subarray(148, 156)))
      throw new PayloadError("ARCHIVE_HEADER_INVALID");
    const size = number(header.subarray(124, 136));
    const mode = number(header.subarray(100, 108));

    if (mode & 0o7000) throw new PayloadError("ARCHIVE_PRIVILEGED_MODE");
    const start = offset + 512;

    if (start + size > bytes.length) throw new PayloadError("ARCHIVE_TRUNCATED");
    const data = bytes.subarray(start, start + size);
    const type = String.fromCharCode(header[156] ?? 0);

    const text = (from: number, to: number) =>
      decoder.decode(header.subarray(from, to)).replace(/\0.*$/, "");

    if (type === "x") {
      if (size > 65536 || pax.size) throw new PayloadError("ARCHIVE_PAX_INVALID");

      for (let position = 0; position < data.length;) {
        const space = data.indexOf(32, position);
        const length = Number(data.subarray(position, space).toString("ascii"));

        if (
          space < 0 ||
          !Number.isSafeInteger(length) ||
          length < 4 ||
          position + length > data.length ||
          data[position + length - 1] !== 10
        )
          throw new PayloadError("ARCHIVE_PAX_INVALID");
        const record = decoder.decode(data.subarray(space + 1, position + length - 1));
        const equals = record.indexOf("=");

        if (equals < 1) throw new PayloadError("ARCHIVE_PAX_INVALID");
        const key = record.slice(0, equals);

        if (pax.has(key) || key.startsWith("GNU.sparse") || key === "size")
          throw new PayloadError("ARCHIVE_PAX_UNSUPPORTED");
        pax.set(key, record.slice(equals + 1));
        position += length;
      }
    } else {
      const prefix = text(345, 500);
      const name = path(pax.get("path") ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100)));

      if (members.has(name)) throw new PayloadError("ARCHIVE_DUPLICATE_PATH");
      let kind: ArchiveMember["kind"];

      if (type === "0" || type === "\0") kind = "file";
      else if (type === "5") kind = "directory";
      else if (type === "2") kind = "symlink";
      else if (type === "1") kind = "hardlink";
      else throw new PayloadError("ARCHIVE_ENTRY_UNSUPPORTED");

      if (kind !== "file" && size !== 0) throw new PayloadError("ARCHIVE_ENTRY_INVALID");

      const member = {
        path: name,
        kind,
        mode: mode & 0o777,
        data,
        link: pax.get("linkpath") ?? text(157, 257),
      };

      if (kind === "symlink" || kind === "hardlink") linkTarget(member);
      members.set(name, member);

      if (members.size > 25000) throw new PayloadError("ARCHIVE_FILES_EXCEEDED");
      pax = new Map();
    }

    offset = start + Math.ceil(size / 512) * 512;
  }

  if (!ended || pax.size) throw new PayloadError("ARCHIVE_TRUNCATED");

  for (const member of members.values()) {
    for (let parent = posix.dirname(member.path); parent !== "."; parent = posix.dirname(parent)) {
      const ancestor = members.get(parent);

      if (ancestor && ancestor.kind !== "directory") throw new PayloadError("ARCHIVE_LINK_PARENT");
    }
  }

  return members;
}

function lookup(members: Map<string, ArchiveMember>, initial: string): ArchiveMember {
  let current = path(initial);
  const seen = new Set<string>();

  for (let depth = 0; depth < 64; depth += 1) {
    if (seen.has(current)) throw new PayloadError("ARCHIVE_LINK_CYCLE");
    seen.add(current);
    const segments = current.split("/");
    let followed = false;

    for (let count = 1; count <= segments.length; count += 1) {
      const member = members.get(segments.slice(0, count).join("/"));

      if (member?.kind === "symlink" || member?.kind === "hardlink") {
        current = path([linkTarget(member), ...segments.slice(count)].join("/"));
        followed = true;
        break;
      }
    }

    if (followed) continue;
    const member = members.get(current);

    if (!member) throw new PayloadError("RUNTIME_DEPENDENCY_MISSING");

    return member;
  }

  throw new PayloadError("ARCHIVE_LINK_CYCLE");
}

const packageSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  engines: z.object({ node: z.string() }).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

const lifecycle = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
]);

export interface ValidatedRuntimePackage {
  manifest: RuntimeManifest;
  members: Map<string, ArchiveMember>;
  archiveSha256: string;
}

export function validateRuntimePackage(input: {
  archive: Buffer;
  expectedSha256: string;
  lock: RuntimeLock;
}): ValidatedRuntimePackage {
  const lock = runtimeLockSchema.parse(input.lock);

  if (sha256(input.archive) !== input.expectedSha256 || input.expectedSha256 !== lock.packageSha256)
    throw new PayloadError("RUNTIME_PACKAGE_HASH_MISMATCH");
  const members = inspectTar(input.archive);
  const manifestMember = members.get("package/runtime-manifest.json");

  if (
    manifestMember?.kind !== "file" ||
    manifestMember.data.byteLength > 4 * 1024 * 1024 ||
    sha256(manifestMember.data) !== lock.manifestSha256
  )
    throw new PayloadError("RUNTIME_MANIFEST_HASH_MISMATCH");
  const manifest = runtimeManifestSchema.parse(JSON.parse(manifestMember.data.toString("utf8")));

  if (
    manifest.packageVersion !== lock.packageVersion ||
    manifest.protocolVersion !== lock.protocolVersion ||
    manifest.compatibilityLockHash !== lock.compatibilityLockHash ||
    manifest.native.archiveSha256 !== lock.nativeArchiveSha256
  )
    throw new PayloadError("RUNTIME_LOCK_MISMATCH");
  const expected = new Map(manifest.files.map((file) => [path(`package/${file.path}`), file]));

  if (expected.size !== manifest.files.length || expected.has("package/runtime-manifest.json"))
    throw new PayloadError("RUNTIME_MANIFEST_DUPLICATE_PATH");
  const allowedDirectories = new Set(["package"]);
  let expandedBytes = 0;

  for (const [name, file] of expected) {
    for (let parent = posix.dirname(name); parent !== "."; parent = posix.dirname(parent))
      allowedDirectories.add(parent);
    const member = members.get(name);

    if (!member) throw new PayloadError("RUNTIME_FILE_MISSING");

    if ("link" in file) {
      if (member.kind !== "symlink" || member.link !== file.link)
        throw new PayloadError("RUNTIME_LINK_MISMATCH");
      lookup(members, name);
    } else {
      const resolved = member.kind === "hardlink" ? lookup(members, name) : member;

      if (
        resolved.kind !== "file" ||
        resolved.data.byteLength !== file.bytes ||
        sha256(resolved.data) !== file.sha256 ||
        member.mode !== file.mode
      )
        throw new PayloadError("RUNTIME_FILE_HASH_MISMATCH");
      expandedBytes += file.bytes;

      if (expandedBytes > 96 * 1024 * 1024)
        throw new PayloadError("RUNTIME_EXPANDED_BYTES_EXCEEDED");

      if (name.endsWith("/package.json")) {
        const metadata = packageSchema.parse(JSON.parse(resolved.data.toString("utf8")));

        if (Object.keys(metadata.scripts ?? {}).some((script) => lifecycle.has(script)))
          throw new PayloadError("RUNTIME_LIFECYCLE_SCRIPT", name);
      }
    }
  }

  for (const member of members.values())
    if (
      member.kind === "directory"
        ? !allowedDirectories.has(member.path)
        : member.path !== "package/runtime-manifest.json" && !expected.has(member.path)
    )
      throw new PayloadError("RUNTIME_FILE_UNDECLARED");

  const metadata = packageSchema.parse(
    JSON.parse(lookup(members, "package/package.json").data.toString("utf8")),
  );

  if (
    metadata.name !== "fastloop" ||
    metadata.version !== lock.packageVersion ||
    metadata.engines?.node !== manifest.node
  )
    throw new PayloadError("RUNTIME_PACKAGE_IDENTITY_MISMATCH");

  for (const entry of Object.values(manifest.entries))
    if (lookup(members, path(`package/${entry}`)).kind !== "file")
      throw new PayloadError("RUNTIME_ENTRY_MISSING");

  if (
    sha256(lookup(members, "package/compatibility.lock.json").data) !== lock.compatibilityLockHash
  )
    throw new PayloadError("RUNTIME_COMPATIBILITY_MISMATCH");

  for (const dependency of Object.keys(metadata.dependencies ?? {}))
    if (lookup(members, path(`package/node_modules/${dependency}/package.json`)).kind !== "file")
      throw new PayloadError("RUNTIME_DEPENDENCY_MISSING");

  return { manifest, members, archiveSha256: input.expectedSha256 };
}

export function validateNativeArchive(archive: Buffer, manifest: RuntimeManifest): void {
  if (sha256(archive) !== manifest.native.archiveSha256)
    throw new PayloadError("RUNTIME_NATIVE_HASH_MISMATCH");
  const members = inspectTar(archive);

  for (const member of members.values())
    if (
      (member.kind !== "file" && member.kind !== "directory") ||
      !(
        member.path === manifest.native.binaryName ||
        member.path === "LICENSE" ||
        member.path === "LICENSES" ||
        member.path.startsWith("LICENSES/")
      )
    )
      throw new PayloadError("RUNTIME_NATIVE_FILE_UNDECLARED");
  const binary = members.get(manifest.native.binaryName);

  if (
    binary?.kind !== "file" ||
    sha256(binary.data) !== manifest.native.binarySha256 ||
    !members.has("LICENSE")
  )
    throw new PayloadError("RUNTIME_NATIVE_HASH_MISMATCH");
}
