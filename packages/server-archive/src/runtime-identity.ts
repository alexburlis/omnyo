import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  LEGACY_INSTALLED_RUNTIME_V1,
  legacyInstalledRuntimeVersionV1Schema,
  legacyWorkerPackageRoleV1,
  legacyFullPackageRoleV1,
} from "./legacy-runtime-identity-v1.js";

const roots = [
  "dist",
  "server/dist",
  "host-daemon/dist",
  "app/dist",
  "package.json",
] as const;

const identityPath = "dist/runtime-identity.json";

const workerPackageRole = {
  files: ["dist", "host-daemon", "README.md"],
  bin: {
    omnyo: "dist/omnyo.js",
    "omnyo-app": "dist/omnyo-app.js",
    "omnyo-host-daemon": "dist/omnyo-host-daemon.js",
  },
} as const;

const inventoryFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const filesSchema = z
  .array(inventoryFileSchema)
  .min(1)
  .superRefine((files, context) => {
    let previous = "";

    for (const file of files) {
      const parts = file.path.split("/");

      if (
        file.path <= previous ||
        parts.some((part) => part === "" || part === "." || part === "..") ||
        file.path.includes("\\") ||
        file.path.includes("\0") ||
        !roots.some(
          (root) =>
            file.path === root ||
            (root !== "package.json" && file.path.startsWith(root + "/")),
        ) ||
        file.path === identityPath ||
        file.path.endsWith(".map")
      )
        context.addIssue({
          code: "custom",
          message: "Invalid, duplicate or unsorted runtime inventory path",
        });
      previous = file.path;
    }
  });

export const runtimeIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeVersion: z.string().min(1),
    hostDaemonProtocolVersion: z.number().int().positive(),
    files: filesSchema,
    runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      createHash("sha256")
        .update(JSON.stringify(identity.files))
        .digest("hex") !== identity.runtimeSha256
    )
      context.addIssue({
        code: "custom",
        message: "Runtime inventory digest mismatch",
      });
  });

export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;

export function parseRuntimeIdentity(
  value: Parameters<typeof runtimeIdentitySchema.parse>[0],
): RuntimeIdentity {
  return runtimeIdentitySchema.parse(value);
}

export function runtimeIdentityDigest(files: RuntimeIdentity["files"]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        filesSchema.parse(
          [...files].sort((a, b) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
          ),
        ),
      ),
    )
    .digest("hex");
}

async function inventory(
  root: string,
  selectedRoots: readonly string[] = roots,
): Promise<RuntimeIdentity["files"]> {
  const files: RuntimeIdentity["files"] = [];

  async function visit(path: string) {
    if (path === identityPath || path.endsWith(".map")) return;
    const absolute = join(root, path);
    const info = await lstat(absolute);

    if (info.isSymbolicLink())
      throw new Error(`Runtime inventory forbids symlink: ${path}`);

    if (info.isDirectory()) {
      for (const entry of await readdir(absolute))
        await visit(`${path}/${entry}`);
    } else if (info.isFile()) {
      const hash = createHash("sha256");

      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      files.push({ path, sha256: hash.digest("hex") });
    } else throw new Error(`Runtime inventory forbids special file: ${path}`);
  }

  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Runtime root forbids symlink");

  for (const path of selectedRoots) {
    const parts = path.split("/");

    for (let index = 1; index < parts.length; index++)
      if ((await lstat(join(root, ...parts.slice(0, index)))).isSymbolicLink())
        throw new Error("Runtime inventory forbids ancestor symlink");
    await visit(path);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return filesSchema.parse(files);
}

async function installedLegacyRuntimeRootsV1(
  root: string,
  value: unknown,
): Promise<readonly string[]> {
  const metadata = z
    .object({
      files: z.array(z.string()),
      bin: z.record(z.string(), z.string()),
    })
    .parse(value);

  const declared = JSON.stringify({
    files: [...metadata.files].sort(),
    bin: Object.entries(metadata.bin).sort(([a], [b]) => a.localeCompare(b)),
  });

  const matches = (
    role: typeof legacyWorkerPackageRoleV1 | typeof legacyFullPackageRoleV1,
  ) =>
    declared ===
    JSON.stringify({
      files: [...role.files].sort(),
      bin: Object.entries(role.bin).sort(([a], [b]) => a.localeCompare(b)),
    });

  async function directory(name: string): Promise<boolean> {
    const info = await lstat(join(root, name)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (info === null) return false;

    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Legacy runtime role has a nonordinary directory");

    return true;
  }

  const server = await directory("server");
  const app = await directory("app");

  if (matches(legacyWorkerPackageRoleV1)) {
    if (server || app)
      throw new Error("Legacy worker runtime has mixed product roots");

    return ["dist", "host-daemon/dist", "package.json"];
  }

  if (matches(legacyFullPackageRoleV1)) {
    if (!server || !app)
      throw new Error("Legacy full runtime has missing product roots");

    return roots;
  }

  throw new Error("Unsupported legacy runtime product role");
}

async function assertWorkerPackageRole(
  root: string,
  value: unknown,
): Promise<void> {
  const metadata = z
    .object({
      files: z.array(z.string()),
      bin: z.record(z.string(), z.string()),
    })
    .parse(value);

  if (
    JSON.stringify([...metadata.files].sort()) !==
      JSON.stringify([...workerPackageRole.files].sort()) ||
    JSON.stringify(
      Object.entries(metadata.bin).sort(([a], [b]) => a.localeCompare(b)),
    ) !==
      JSON.stringify(
        Object.entries(workerPackageRole.bin).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      )
  )
    throw new Error(
      "Runtime package does not declare the canonical worker role",
    );

  for (const name of ["server", "app"]) {
    const info = await lstat(join(root, name)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (info !== null)
      throw new Error("Canonical worker runtime has mixed product roots");
  }

  for (const name of [
    "dist/omnyo-app.js",
    "dist/omnyo.js",
    "dist/omnyo-host-daemon.js",
    "dist/machine-state.mjs",
    "host-daemon/dist/daemon-bundle.mjs",
  ]) {
    const info = await lstat(join(root, name));

    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(
        "Canonical worker runtime is missing its ordinary required entry",
      );
  }

  const manifestPath = join(root, "dist/plugin-sdk/manifest.json");
  const manifestInfo = await lstat(manifestPath);

  if (
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    manifestInfo.size > 4096
  )
    throw new Error(
      "Canonical worker SDK manifest is not an ordinary bounded file",
    );

  const manifest = z
    .object({
      schema: z.literal(1),
      packageName: z.literal("@omnyo/plugin-sdk"),
      version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u),
      file: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict()
    .parse(JSON.parse(await readFile(manifestPath, "utf8")));

  if (
    manifest.file !==
    `omnyo-plugin-sdk-${manifest.version}-${manifest.sha256.slice(0, 12)}.tgz`
  )
    throw new Error(
      "Canonical worker SDK archive path differs from its manifest",
    );
  const archivePath = join(root, "dist/plugin-sdk", manifest.file);
  const archiveInfo = await lstat(archivePath);

  if (
    !archiveInfo.isFile() ||
    archiveInfo.isSymbolicLink() ||
    archiveInfo.size === 0 ||
    archiveInfo.size > 10 * 1024 * 1024 ||
    createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex") !== manifest.sha256
  )
    throw new Error(
      "Canonical worker SDK archive differs from its verified manifest",
    );
}

export async function readRuntimeIdentity(
  root: string,
): Promise<RuntimeIdentity> {
  if ((await lstat(join(root, identityPath))).isSymbolicLink())
    throw new Error("Runtime identity forbids symlink");

  return parseRuntimeIdentity(
    JSON.parse(await readFile(join(root, identityPath), "utf8")),
  );
}

async function inventoryRuntimeIdentity(
  root: string,
  labels: Pick<RuntimeIdentity, "runtimeVersion" | "hostDaemonProtocolVersion">,
  legacyInputV1: boolean,
  worker: boolean = false,
): Promise<RuntimeIdentity> {
  const actual = z
    .object({ name: z.string(), version: z.string().min(1) })
    .passthrough()
    .parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));

  if (
    actual.name !==
      (legacyInputV1 ? LEGACY_INSTALLED_RUNTIME_V1.packageName : "omnyo-app") ||
    (legacyInputV1 &&
      !legacyInstalledRuntimeVersionV1Schema.safeParse(actual.version)
        .success) ||
    (legacyInputV1 && labels.hostDaemonProtocolVersion !== 252) ||
    labels.runtimeVersion !== actual.version
  )
    throw new Error("Runtime package version mismatch");

  if (worker) await assertWorkerPackageRole(root, actual);

  const files = await inventory(
    root,
    legacyInputV1
      ? await installedLegacyRuntimeRootsV1(root, actual)
      : worker
        ? ["dist", "host-daemon/dist", "package.json"]
        : roots,
  );

  return parseRuntimeIdentity({
    schemaVersion: 1,
    ...labels,
    files,
    runtimeSha256: runtimeIdentityDigest(files),
  });
}

const driftExampleLimit = 5;

function inventoryDigestMismatch(
  message: string,
  expected: RuntimeIdentity["files"],
  actual: RuntimeIdentity["files"],
): Error {
  const expectedHashes = new Map(expected.map((f) => [f.path, f.sha256]));
  const actualHashes = new Map(actual.map((f) => [f.path, f.sha256]));
  const missing = expected.filter((f) => !actualHashes.has(f.path));
  const extra = actual.filter((f) => !expectedHashes.has(f.path));

  const changed = expected.filter((f) => {
    const hash = actualHashes.get(f.path);

    return hash !== undefined && hash !== f.sha256;
  });

  const describe = (label: string, entries: RuntimeIdentity["files"]) =>
    entries.length === 0
      ? null
      : `${label}: ${entries
          .slice(0, driftExampleLimit)
          .map((f) => f.path)
          .join(", ")}${entries.length > driftExampleLimit ? ", ..." : ""}`;

  const examples = [
    describe("missing", missing),
    describe("extra", extra),
    describe("changed", changed),
  ].filter((part) => part !== null);

  return new Error(
    `${message} (missing ${missing.length}, extra ${extra.length}, changed ${changed.length}${examples.length === 0 ? "" : `; ${examples.join("; ")}`})`,
  );
}

export async function createRuntimeIdentity(
  root: string,
  labels: Pick<RuntimeIdentity, "runtimeVersion" | "hostDaemonProtocolVersion">,
): Promise<RuntimeIdentity> {
  return inventoryRuntimeIdentity(root, labels, false);
}

export async function createWorkerRuntimeIdentity(
  root: string,
  labels: Pick<RuntimeIdentity, "runtimeVersion" | "hostDaemonProtocolVersion">,
): Promise<RuntimeIdentity> {
  return inventoryRuntimeIdentity(root, labels, false, true);
}

export async function verifyWorkerRuntimeIdentity(
  root: string,
  value: Parameters<typeof runtimeIdentitySchema.parse>[0],
): Promise<RuntimeIdentity> {
  const expected = parseRuntimeIdentity(value);
  const actual = await createWorkerRuntimeIdentity(root, expected);

  if (actual.runtimeSha256 !== expected.runtimeSha256)
    throw inventoryDigestMismatch(
      "Worker runtime inventory digest mismatch",
      expected.files,
      actual.files,
    );

  return actual;
}

export async function verifyInstalledLegacyRuntimeIdentityV1(
  root: string,
  value: Parameters<typeof runtimeIdentitySchema.parse>[0],
): Promise<RuntimeIdentity> {
  const identity = parseRuntimeIdentity(value);

  if (
    !legacyInstalledRuntimeVersionV1Schema.safeParse(identity.runtimeVersion)
      .success
  )
    throw new Error("Unsupported legacy installed runtime version");
  const actual = await inventoryRuntimeIdentity(root, identity, true);

  if (
    JSON.stringify(actual.files) !== JSON.stringify(identity.files) ||
    actual.runtimeSha256 !== identity.runtimeSha256
  )
    throw inventoryDigestMismatch(
      "Legacy runtime identity inventory digest mismatch",
      identity.files,
      actual.files,
    );

  return identity;
}

export async function readInstalledLegacyRuntimeIdentityV1(
  root: string,
  labels: Pick<RuntimeIdentity, "hostDaemonProtocolVersion"> &
    Partial<Pick<RuntimeIdentity, "runtimeVersion">>,
): Promise<RuntimeIdentity> {
  return inventoryRuntimeIdentity(
    root,
    { runtimeVersion: LEGACY_INSTALLED_RUNTIME_V1.version, ...labels },
    true,
  );
}

export async function verifyRuntimeIdentity(
  root: string,
  value: Parameters<typeof runtimeIdentitySchema.parse>[0],
): Promise<RuntimeIdentity> {
  const identity = parseRuntimeIdentity(value);
  const actual = await createRuntimeIdentity(root, identity);

  if (
    JSON.stringify(actual.files) !== JSON.stringify(identity.files) ||
    actual.runtimeSha256 !== identity.runtimeSha256
  )
    throw inventoryDigestMismatch(
      "Runtime identity inventory digest mismatch",
      identity.files,
      actual.files,
    );

  return identity;
}
