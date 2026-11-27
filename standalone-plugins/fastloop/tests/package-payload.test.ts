import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  inspectTar,
  runtimeManifestSchema,
  sha256,
  validateNativeArchive,
  validateRuntimePackage,
  type RuntimeLock,
  type RuntimeManifest,
} from "../package-payload.js";

interface Member {
  path: string;
  data?: Buffer;
  type?: string;
  link?: string;
  mode?: number;
}

function archive(members: Member[]): Buffer {
  const chunks: Buffer[] = [];

  for (const member of members) {
    const data = member.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(member.path, 0, 100);
    header.write((member.mode ?? 0o644).toString(8).padStart(7, "0") + "\0", 100, 8);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.fill(32, 148, 156);
    header.write(member.type ?? "0", 156, 1);
    header.write(member.link ?? "", 157, 100);
    header.write("ustar\0", 257, 6);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }

  chunks.push(Buffer.alloc(1024));

  return gzipSync(Buffer.concat(chunks));
}

function fixture(
  options: {
    scripts?: Record<string, string>;
    nestedScripts?: Record<string, string>;
    missingDependency?: boolean;
    version?: string;
  } = {},
) {
  const compatibility = Buffer.from('{"schema":1}');

  const members: Member[] = [
    {
      path: "package/package.json",
      data: Buffer.from(
        JSON.stringify({
          name: "fastloop",
          version: options.version ?? "0.1.0",
          engines: { node: ">=24 <25" },
          scripts: options.scripts,
          dependencies: options.missingDependency ? { absent: "1.0.0" } : { example: "1.0.0" },
        }),
      ),
    },
    { path: "package/compatibility.lock.json", data: compatibility },
    {
      path: "package/node_modules/example/package.json",
      data: Buffer.from(
        JSON.stringify({ name: "example", version: "1.0.0", scripts: options.nestedScripts }),
      ),
    },
    ...["sdk", "cli", "service", "mcp"].map((name) => ({
      path: `package/dist/${name}.js`,
      data: Buffer.from("export const fixture = true;\n"),
    })),
  ];

  const nativeBinary = Buffer.from("synthetic archive validation data, never executable");

  const native = archive([
    { path: "agent-browser-darwin-arm64", data: nativeBinary, mode: 0o755 },
    { path: "LICENSE", data: Buffer.from("Synthetic license fixture") },
  ]);

  const manifest = runtimeManifestSchema.parse({
    schema: 1,
    packageVersion: "0.1.0",
    protocolVersion: 1,
    sourceRevision: "fixture",
    sourceDirty: false,
    sourceHash: "a".repeat(64),
    packagerSha256: "b".repeat(64),
    compatibilityLockHash: sha256(compatibility),
    node: ">=24 <25",
    qualifiedPlatforms: [{ platform: "darwin", arch: "arm64" }],
    entries: {
      sdk: "dist/sdk.js",
      cli: "dist/cli.js",
      service: "dist/service.js",
      mcp: "dist/mcp.js",
    },
    native: {
      package: "agent-browser",
      version: "0.39.1",
      binaryName: "agent-browser-darwin-arm64",
      binarySha256: sha256(nativeBinary),
      archive: "native.tgz",
      archiveSha256: sha256(native),
    },
    browser: { install: "explicit-existing-Chrome", sandboxRequired: true },
    files: members.map((member) => ({
      path: member.path.slice(8),
      sha256: sha256(member.data ?? Buffer.alloc(0)),
      bytes: member.data?.length ?? 0,
      mode: 0o644,
    })),
  });

  const metadata = Buffer.from(JSON.stringify(manifest));
  const all = [...members, { path: "package/runtime-manifest.json", data: metadata }];
  const compressed = archive(all);

  const lock: RuntimeLock = {
    schema: 1,
    packageVersion: "0.1.0",
    protocolVersion: 1,
    packageSha256: sha256(compressed),
    manifestSha256: sha256(metadata),
    compatibilityLockHash: manifest.compatibilityLockHash,
    nativeArchiveSha256: sha256(native),
  };

  return { archive: compressed, lock, manifest, members: all, native };
}

function repack(input: ReturnType<typeof fixture>, members: Member[]) {
  const compressed = archive(members);

  return {
    archive: compressed,
    expectedSha256: sha256(compressed),
    lock: { ...input.lock, packageSha256: sha256(compressed) },
  };
}

it("validates declared package bytes, dependency inventory and separately pinned native archive without execution", () => {
  const input = fixture();
  const result = validateRuntimePackage({ ...input, expectedSha256: input.lock.packageSha256 });
  expect(result.manifest.entries.service).toBe("dist/service.js");
  expect(result.members.size).toBe(8);
  expect(() => validateNativeArchive(input.native, result.manifest)).not.toThrow();
});

it("refuses a corrupted archive before inspecting or replacing anything", () => {
  const input = fixture();
  const corrupt = Buffer.from(input.archive);
  corrupt[0] = (corrupt[0] ?? 0) ^ 1;
  expect(() =>
    validateRuntimePackage({
      ...input,
      archive: corrupt,
      expectedSha256: input.lock.packageSha256,
    }),
  ).toThrow("RUNTIME_PACKAGE_HASH_MISMATCH");
});

for (const member of [
  { path: "package/../escape", data: Buffer.from("bad") },
  { path: "/outside", data: Buffer.from("bad") },
  { path: "package\\escape", data: Buffer.from("bad") },
])
  it(`rejects unsafe archive path ${member.path}`, () => {
    expect(() => inspectTar(archive([member]))).toThrow("ARCHIVE_PATH_INVALID");
  });

it("rejects escaping symlinks, including absolute targets", () => {
  for (const link of ["../../escape", "/tmp/escape"])
    expect(() => inspectTar(archive([{ path: "package/link", type: "2", link }]))).toThrow(
      "ARCHIVE_LINK_ESCAPE",
    );
});

it("rejects a symlink parent even when the child appeared first", () => {
  expect(() =>
    inspectTar(
      archive([
        { path: "package/dir/file", data: Buffer.from("data") },
        { path: "package/dir", type: "2", link: "." },
      ]),
    ),
  ).toThrow("ARCHIVE_LINK_PARENT");
});

it("rejects duplicate paths, privileged modes and malformed compression", () => {
  expect(() => inspectTar(archive([{ path: "package/a" }, { path: "package/a" }]))).toThrow(
    "ARCHIVE_DUPLICATE_PATH",
  );
  expect(() => inspectTar(archive([{ path: "package/a", mode: 0o4755 }]))).toThrow(
    "ARCHIVE_PRIVILEGED_MODE",
  );
  expect(() => inspectTar(Buffer.from("not gzip"))).toThrow("ARCHIVE_DECOMPRESSION_INVALID");
});

it("rejects undeclared files and changes to declared content", () => {
  const input = fixture();
  expect(() =>
    validateRuntimePackage(
      repack(input, [...input.members, { path: "package/extra", data: Buffer.from("extra") }]),
    ),
  ).toThrow("RUNTIME_FILE_UNDECLARED");
  expect(() =>
    validateRuntimePackage(
      repack(
        input,
        input.members.map((member) =>
          member.path === "package/dist/service.js"
            ? { ...member, data: Buffer.from("changed") }
            : member,
        ),
      ),
    ),
  ).toThrow("RUNTIME_FILE_HASH_MISMATCH");
});

it("refuses missing declared files and missing dependency packages", () => {
  const input = fixture();
  expect(() =>
    validateRuntimePackage(
      repack(
        input,
        input.members.filter((member) => member.path !== "package/dist/service.js"),
      ),
    ),
  ).toThrow("RUNTIME_FILE_MISSING");
  const missing = fixture({ missingDependency: true });
  expect(() =>
    validateRuntimePackage({ ...missing, expectedSha256: missing.lock.packageSha256 }),
  ).toThrow("RUNTIME_DEPENDENCY_MISSING");
});

for (const options of [
  { scripts: { postinstall: "never run this" } },
  { nestedScripts: { prepare: "never run this" } },
])
  it("rejects lifecycle hooks in root and dependency metadata without executing them", () => {
    const input = fixture(options);
    expect(() =>
      validateRuntimePackage({ ...input, expectedSha256: input.lock.packageSha256 }),
    ).toThrow("RUNTIME_LIFECYCLE_SCRIPT");
  });

it("rejects package, protocol, compatibility and manifest identity mismatches", () => {
  const input = fixture();
  expect(() =>
    validateRuntimePackage({
      ...input,
      expectedSha256: input.lock.packageSha256,
      lock: { ...input.lock, protocolVersion: 2 },
    }),
  ).toThrow("RUNTIME_LOCK_MISMATCH");
  expect(() =>
    validateRuntimePackage({
      ...input,
      expectedSha256: input.lock.packageSha256,
      lock: { ...input.lock, manifestSha256: "d".repeat(64) },
    }),
  ).toThrow("RUNTIME_MANIFEST_HASH_MISMATCH");
  const wrongVersion = fixture({ version: "0.2.0" });
  expect(() =>
    validateRuntimePackage({ ...wrongVersion, expectedSha256: wrongVersion.lock.packageSha256 }),
  ).toThrow("RUNTIME_PACKAGE_IDENTITY_MISMATCH");
});

it("rejects native hash mismatch and undeclared native archive files", () => {
  const input = fixture();
  expect(() => validateNativeArchive(Buffer.from("corrupt"), input.manifest)).toThrow(
    "RUNTIME_NATIVE_HASH_MISMATCH",
  );
  const native = archive([{ path: "unexpected", data: Buffer.from("no") }]);

  const metadata: RuntimeManifest = {
    ...input.manifest,
    native: { ...input.manifest.native, archiveSha256: sha256(native) },
  };

  expect(() => validateNativeArchive(native, metadata)).toThrow("RUNTIME_NATIVE_FILE_UNDECLARED");
});

it("rejects parent traversal after a named symlink component", () => {
  expect(() =>
    inspectTar(
      archive([
        { path: "package", type: "5", mode: 0o755 },
        { path: "package/alias", type: "2", link: "." },
        { path: "package/link", type: "2", link: "alias/../outside" },
      ]),
    ),
  ).toThrow("ARCHIVE_LINK_ESCAPE");
});
