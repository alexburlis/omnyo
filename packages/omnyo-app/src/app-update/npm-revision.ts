import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "@omnyo/config/release-version";
import { z } from "zod";
import {
  formatAppUpdateVersionsDir,
  readAppUpdateState,
  readPrivateServerUpdateManifest,
  type NpmAppRevision,
} from "@omnyo/config/app-update";
import { isPathWithin, isSamePath } from "./shim-support.js";

const packageJsonSchema = z
  .object({ version: z.string().min(1) })
  .passthrough();

export const NPM_REVISION_REQUIRED_FILES = [
  join("dist", "omnyo-app.js"),
  join("server", "dist", "index.js"),
  join("host-daemon", "dist", "daemon-bundle.mjs"),
  join("app", "dist", "index.html"),
] as const;

export function readPackageVersion(packageRoot: string): string | null {
  try {
    const parsed = packageJsonSchema.safeParse(
      JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
    );

    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

export function isUsableNpmRevision(revision: NpmAppRevision): boolean {
  return (
    readPackageVersion(revision.packageRoot) === revision.version &&
    NPM_REVISION_REQUIRED_FILES.every((file) =>
      existsSync(join(revision.packageRoot, file)),
    )
  );
}

export function formatNpmRevisionInstallDir(
  dataDir: string,
  version: string,
): string {
  return join(formatAppUpdateVersionsDir(dataDir), version);
}

export function formatNpmRevisionPackageRoot(
  dataDir: string,
  version: string,
): string {
  return join(
    formatNpmRevisionInstallDir(dataDir, version),
    "node_modules",
    "omnyo-app",
  );
}

const publicationSchema = z
  .object({
    schema: z.literal(1),
    owner: z.literal("omnyo-runtime-publication"),
    jobId: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    version: z.string().min(1),
    runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    receiptPath: z.string().refine(isAbsolute),
    treeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    activated: z.boolean(),
  })
  .strict();

async function resolvePublisherReceipt(path: string): Promise<string> {
  const supportDirectory = join(homedir(), "Library", "Application Support");
  const legacyStore = join(supportDirectory, "bb-private-releases");
  const legacyPrefix = legacyStore + sep;
  const normalized = normalize(path);

  if (process.platform !== "darwin" || !normalized.startsWith(legacyPrefix))
    return path;

  try {
    await lstat(legacyStore);

    return path;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }

  return join(
    supportDirectory,
    "omnyo-private-releases",
    normalized.slice(legacyPrefix.length),
  );
}

export async function markNpmRevisionActivated(
  dataDir: string,
  revision: NpmAppRevision,
): Promise<void> {
  const installDir = formatNpmRevisionInstallDir(dataDir, revision.version);

  if (
    !isSamePath(
      revision.packageRoot,
      formatNpmRevisionPackageRoot(dataDir, revision.version),
    )
  )
    return;

  const path = join(installDir, ".publication.json");

  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });

  if (raw === null) return;

  const marker = publicationSchema.parse(JSON.parse(raw));

  if (marker.version !== revision.version)
    throw new Error("Running runtime ownership changed.");

  if (marker.activated) return;
  const pending = join(installDir, ".publication-pending-" + randomUUID());

  try {
    await writeFile(pending, JSON.stringify({ ...marker, activated: true }), {
      flag: "wx",
    });

    if ((await readFile(path, "utf8")) !== raw)
      throw new Error("Running runtime ownership changed during activation.");
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

async function runtimeTreeDigest(root: string): Promise<string> {
  const records: Array<
    | { path: string; link: string }
    | { path: string; directory: true }
    | { path: string; bytes: number; sha256: string }
  > = [];

  async function walk(relative: string): Promise<void> {
    for (const name of (
      await readdir(relative ? join(root, relative) : root)
    ).sort()) {
      if (!relative && name === ".publication.json") continue;
      const path = relative ? relative + "/" + name : name;
      const entry = await lstat(join(root, path));

      if (entry.isSymbolicLink())
        records.push({ path, link: await readlink(join(root, path)) });
      else if (entry.isDirectory()) {
        records.push({ path, directory: true });
        await walk(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(root, path));
        records.push({
          path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else
        throw new Error("Runtime publication contains an unsupported file.");
    }
  }

  await walk("");

  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function saveNpmRetentionJournal(
  dataDir: string,
  journal: object,
): Promise<void> {
  const pending = join(dataDir, ".app-version-retention-" + randomUUID());

  try {
    await writeFile(pending, JSON.stringify(journal), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(pending, join(dataDir, "app-version-retention.json"));
  } finally {
    await rm(pending, { force: true });
  }
}

export async function pruneNpmRevisions(args: {
  bootstrapEntryPath: string;
  dataDir: string;
  keepPackageRoots: readonly string[];
}): Promise<{
  removed: string[];
  held: Array<{ entry: string; reason: string }>;
}> {
  const versionsDir = formatAppUpdateVersionsDir(args.dataDir);
  let entries: string[];

  try {
    entries = await readdir(versionsDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { removed: [], held: [] };
    throw error;
  }

  const priorJournal = await readFile(
    join(args.dataDir, "app-version-retention.json"),
    "utf8",
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });

  if (priorJournal !== null) {
    const prior = z
      .object({
        schema: z.literal(1),
        owner: z.literal("omnyo-runtime-retention"),
        status: z.string(),
      })
      .parse(JSON.parse(priorJournal));

    if (prior.status !== "complete")
      throw new Error(
        "Runtime retention has an unresolved app-version-retention.json journal; existing inputs were preserved.",
      );
  }

  const state = await readAppUpdateState(args.dataDir);
  const offer = await readPrivateServerUpdateManifest(args.dataDir);

  if (offer.kind === "invalid") throw new Error(offer.message);
  const bindings = JSON.stringify({ state, offer });
  const protectedRoots = [...args.keepPackageRoots];

  for (const revision of [
    state.current,
    state.pending?.from,
    state.pending?.to,
    state.lastResult?.from,
    state.lastResult?.to,
  ]) {
    if (revision?.kind === "npm") protectedRoots.push(revision.packageRoot);
  }

  if (offer.kind === "available")
    protectedRoots.push(
      formatNpmRevisionPackageRoot(args.dataDir, offer.manifest.version),
    );
  const removed: string[] = [];
  const held: Array<{ entry: string; reason: string }> = [];

  for (const entry of entries.sort()) {
    const installDir = join(versionsDir, entry);
    const packageRoot = join(installDir, "node_modules", "omnyo-app");
    const hold = (reason: string) => held.push({ entry, reason });

    if (
      protectedRoots.some((root) => isSamePath(root, packageRoot)) ||
      isPathWithin(args.bootstrapEntryPath, installDir)
    ) {
      hold("current, rollback, bootstrap, approved offer or recovery binding");
      continue;
    }

    const info = await lstat(installDir);

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      parseReleaseVersion(entry) === null
    ) {
      hold("unknown entry or in-flight staging directory");
      continue;
    }

    const marker = await readFile(
      join(installDir, ".publication.json"),
      "utf8",
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (marker === null) {
      hold("legacy runtime has no producer ownership");
      continue;
    }

    const publication = publicationSchema.parse(JSON.parse(marker));

    if (
      publication.version !== entry ||
      !isUsableNpmRevision({ kind: "npm", version: entry, packageRoot })
    )
      throw new Error("Runtime publication ownership changed.");

    if (publication.activated) {
      hold("previously activated runtime has unknown packaged-web clients");
      continue;
    }

    const runtime = z
      .object({ runtimeSha256: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            join(packageRoot, "dist", "runtime-identity.json"),
            "utf8",
          ),
        ),
      );

    if (runtime.runtimeSha256 !== publication.runtimeSha256)
      throw new Error("Runtime publication identity changed.");

    if (
      offer.kind !== "available" ||
      compareReleaseVersions(entry, offer.manifest.version) > 0
    ) {
      hold("runtime is not superseded by an approved offer");
      continue;
    }

    const receiptPath = await resolvePublisherReceipt(publication.receiptPath);

    const receiptRaw = await readFile(receiptPath, "utf8").catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      },
    );

    if (receiptRaw === null) {
      hold("publisher receipt is unavailable");
      continue;
    }

    const receipt = z
      .object({
        id: z.string(),
        sourceCommit: z.string(),
        status: z.string(),
        owner: z
          .object({ pid: z.number().int().positive() })
          .passthrough()
          .nullish(),
      })
      .parse(JSON.parse(receiptRaw));

    if (
      receipt.id !== publication.jobId ||
      receipt.sourceCommit !== publication.sourceCommit ||
      receipt.status !== "complete"
    ) {
      hold("publisher job has active or unresolved recovery inputs");
      continue;
    }

    if (receipt.owner != null) {
      let active = true;

      try {
        process.kill(receipt.owner.pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          active = false;
      }

      if (active) {
        hold("publisher process still owns its recovery inputs");
        continue;
      }
    }

    const fresh = JSON.stringify({
      state: await readAppUpdateState(args.dataDir),
      offer: await readPrivateServerUpdateManifest(args.dataDir),
    });

    if (fresh !== bindings)
      throw new Error(
        "Runtime retention bindings changed; retry after the update settles.",
      );

    if (
      (await readFile(join(installDir, ".publication.json"), "utf8")) !== marker
    )
      throw new Error("Runtime publication ownership changed before removal.");

    if ((await runtimeTreeDigest(installDir)) !== publication.treeSha256)
      throw new Error(
        "Runtime publication contents changed; unique or unknown data was preserved.",
      );

    if (
      JSON.stringify({
        state: await readAppUpdateState(args.dataDir),
        offer: await readPrivateServerUpdateManifest(args.dataDir),
      }) !== bindings ||
      (await readFile(receiptPath, "utf8")) !== receiptRaw
    )
      throw new Error("Runtime retention ownership changed during inspection.");

    const journal = {
      schema: 1,
      owner: "omnyo-runtime-retention",
      status: "removing",
      entry,
      packageRoot,
      treeSha256: publication.treeSha256,
      markerSha256: createHash("sha256").update(marker).digest("hex"),
      bindingsSha256: createHash("sha256").update(bindings).digest("hex"),
      receiptSha256: createHash("sha256").update(receiptRaw).digest("hex"),
    };

    await saveNpmRetentionJournal(args.dataDir, journal);

    try {
      await rm(installDir, { recursive: true });
      await saveNpmRetentionJournal(args.dataDir, {
        ...journal,
        status: "complete",
      });
    } catch (error) {
      await saveNpmRetentionJournal(args.dataDir, {
        ...journal,
        status: "ambiguous",
      });
      throw error;
    }

    removed.push(entry);
  }

  return { removed, held };
}
