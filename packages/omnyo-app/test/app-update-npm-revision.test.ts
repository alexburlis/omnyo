import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimePublicationTreeDigest } from "../../process-utils/src/publication-retention.mjs";
import { formatAppUpdateVersionsDir } from "@omnyo/config/app-update";
import {
  formatNpmRevisionPackageRoot,
  NPM_REVISION_REQUIRED_FILES,
  pruneNpmRevisions,
} from "../src/app-update/npm-revision.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-app-update-storage-"));
  scratchDirs.push(dir);

  return dir;
}

function writePackage(
  packageRoot: string,
  version: string,
  files: readonly string[] = NPM_REVISION_REQUIRED_FILES,
): void {
  for (const file of files) {
    mkdirSync(dirname(join(packageRoot, file)), { recursive: true });
    writeFileSync(join(packageRoot, file), "");
  }

  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version }));
}

describe("pruneNpmRevisions", () => {
  it("keeps unknown legacy revisions and staging entries without producer ownership", async () => {
    const dataDir = scratchDir();

    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      writePackage(formatNpmRevisionPackageRoot(dataDir, version), version);
    }

    mkdirSync(join(formatAppUpdateVersionsDir(dataDir), ".staging-1.3.0-1"));

    await pruneNpmRevisions({
      bootstrapEntryPath: join(dataDir, "bundled", "dist", "omnyo-app.js"),
      dataDir,
      keepPackageRoots: [
        formatNpmRevisionPackageRoot(dataDir, "1.1.0"),
        formatNpmRevisionPackageRoot(dataDir, "1.2.0"),
      ],
    });

    expect(readdirSync(formatAppUpdateVersionsDir(dataDir)).sort()).toEqual([
      ".staging-1.3.0-1",
      "1.0.0",
      "1.1.0",
      "1.2.0",
    ]);
  });

  it("leaves a runtime being offered or newer than the kept versions in place", async () => {
    const dataDir = scratchDir();

    for (const version of [
      "1.0.0+private.1",
      "1.1.0+private.1",
      "1.2.0+private.1",
      "1.3.0+private.1",
    ]) {
      writePackage(formatNpmRevisionPackageRoot(dataDir, version), version);
    }

    mkdirSync(
      join(formatAppUpdateVersionsDir(dataDir), ".offer-1.4.0+private.1-abc"),
    );

    await pruneNpmRevisions({
      bootstrapEntryPath: join(dataDir, "bundled", "dist", "omnyo-app.js"),
      dataDir,
      keepPackageRoots: [
        formatNpmRevisionPackageRoot(dataDir, "1.1.0+private.1"),
        formatNpmRevisionPackageRoot(dataDir, "1.2.0+private.1"),
      ],
    });

    expect(readdirSync(formatAppUpdateVersionsDir(dataDir)).sort()).toEqual([
      ".offer-1.4.0+private.1-abc",
      "1.0.0+private.1",
      "1.1.0+private.1",
      "1.2.0+private.1",
      "1.3.0+private.1",
    ]);
  });

  it("keeps the revision that holds the shim's bootstrap entry", async () => {
    const dataDir = scratchDir();

    for (const version of [
      "1.0.0+private.1",
      "1.1.0+private.1",
      "1.2.0+private.1",
    ]) {
      writePackage(formatNpmRevisionPackageRoot(dataDir, version), version);
    }

    await pruneNpmRevisions({
      bootstrapEntryPath: join(
        formatNpmRevisionPackageRoot(dataDir, "1.0.0+private.1"),
        "dist",
        "omnyo-app.js",
      ),
      dataDir,
      keepPackageRoots: [
        formatNpmRevisionPackageRoot(dataDir, "1.2.0+private.1"),
      ],
    });

    expect(readdirSync(formatAppUpdateVersionsDir(dataDir)).sort()).toEqual([
      "1.0.0+private.1",
      "1.1.0+private.1",
      "1.2.0+private.1",
    ]);
  });
  it("retires an owned superseded future candidate only after its publisher and exact contents close", async () => {
    const dataDir = scratchDir();
    const version = "1.3.0";
    const installDir = join(formatAppUpdateVersionsDir(dataDir), version);
    const packageRoot = formatNpmRevisionPackageRoot(dataDir, version);
    writePackage(packageRoot, version);
    writeFileSync(
      join(packageRoot, "dist", "runtime-identity.json"),
      JSON.stringify({ runtimeSha256: "a".repeat(64) }),
    );
    const receiptPath = join(dataDir, "publisher-receipt.json");

    const receipt = {
      id: "job",
      status: "complete",
      sourceCommit: "b".repeat(40),
    };

    const marker = {
      schema: 1,
      owner: "omnyo-runtime-publication",
      jobId: "job",
      sourceCommit: receipt.sourceCommit,
      version,
      runtimeSha256: "a".repeat(64),
      receiptPath,
      treeSha256: await runtimePublicationTreeDigest(installDir),
      activated: false,
    };

    writeFileSync(
      join(installDir, ".publication.json"),
      JSON.stringify(marker),
    );
    mkdirSync(join(dataDir, "private-server-update"));
    writeFileSync(
      join(dataDir, "private-server-update", "approved.json"),
      JSON.stringify({
        schema: 2,
        activation: "idle-only",
        version: "1.4.0",
        protocolVersion: 1,
        sourceCommit: "c".repeat(40),
        runtimeSha256: "d".repeat(64),
        stagedAt: new Date().toISOString(),
      }),
    );

    const args = {
      bootstrapEntryPath: join(dataDir, "bundled", "dist", "omnyo-app.js"),
      dataDir,
      keepPackageRoots: [formatNpmRevisionPackageRoot(dataDir, "1.2.0")],
    };

    expect(await pruneNpmRevisions(args)).toEqual({
      removed: [],
      held: [{ entry: version, reason: "publisher receipt is unavailable" }],
    });
    writeFileSync(
      receiptPath,
      JSON.stringify({ ...receipt, status: "ambiguous" }),
    );
    expect((await pruneNpmRevisions(args)).removed).toEqual([]);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(installDir, "user-data.txt"), "unique");
    await expect(pruneNpmRevisions(args)).rejects.toThrow(
      "unique or unknown data",
    );
    expect(existsSync(join(installDir, "user-data.txt"))).toBe(true);
    rmSync(join(installDir, "user-data.txt"));
    expect((await pruneNpmRevisions(args)).removed).toEqual([version]);
    expect(existsSync(installDir)).toBe(false);
  });
});
