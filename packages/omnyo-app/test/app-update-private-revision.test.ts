import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRIVATE_SERVER_UPDATE_DIR_NAME } from "@omnyo/config/app-update";
import {
  formatNpmRevisionPackageRoot,
  NPM_REVISION_REQUIRED_FILES,
} from "../src/app-update/npm-revision.js";
import {
  adoptPrivateRevision,
  isPrivateServerUpdateEnabled,
} from "../src/app-update/private-revision.js";

const VERSION = "1.1.0+private.2";

const DIGEST = "a".repeat(64);

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-app-update-private-"));
  scratchDirs.push(dir);

  return dir;
}

function stageRuntime(args: {
  dataDir: string;
  identity?: string | null;
  packageVersion?: string;
}): string {
  const packageRoot = formatNpmRevisionPackageRoot(args.dataDir, VERSION);

  for (const file of NPM_REVISION_REQUIRED_FILES) {
    mkdirSync(dirname(join(packageRoot, file)), { recursive: true });
    writeFileSync(join(packageRoot, file), "");
  }

  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "omnyo-app",
      version: args.packageVersion ?? VERSION,
    }),
  );

  const identity =
    args.identity === undefined
      ? JSON.stringify({
          runtimeSha256: DIGEST,
          runtimeVersion: VERSION,
          schemaVersion: 1,
        })
      : args.identity;

  if (identity !== null) {
    writeFileSync(join(packageRoot, "dist", "runtime-identity.json"), identity);
  }

  return packageRoot;
}

function adopt(dataDir: string, runtimeSha256 = DIGEST) {
  return adoptPrivateRevision({ dataDir, runtimeSha256, version: VERSION });
}

function dataDirWithUpdateDir(): string {
  const dataDir = scratchDir();
  mkdirSync(join(dataDir, PRIVATE_SERVER_UPDATE_DIR_NAME));

  return dataDir;
}

describe("adoptPrivateRevision", () => {
  it("adopts a staged runtime that matches the approved digest", () => {
    const dataDir = scratchDir();
    const packageRoot = stageRuntime({ dataDir });

    expect(adopt(dataDir)).toEqual({
      kind: "npm",
      packageRoot,
      version: VERSION,
    });
  });

  it("refuses a runtime that was never staged", () => {
    expect(() => adopt(scratchDir())).toThrow("missing or incomplete");
  });

  it("refuses a staged runtime whose package reports another version", () => {
    const dataDir = scratchDir();
    stageRuntime({ dataDir, packageVersion: "1.0.9+private.1" });

    expect(() => adopt(dataDir)).toThrow(
      `reports omnyo-app 1.0.9+private.1, not ${VERSION}`,
    );
  });

  it.each([
    { identity: null, problem: "missing" },
    { identity: "{", problem: "not JSON" },
    { identity: JSON.stringify({ schemaVersion: 1 }), problem: "digestless" },
  ])("refuses a staged runtime whose identity is $problem", ({ identity }) => {
    const dataDir = scratchDir();
    stageRuntime({ dataDir, identity });

    expect(() => adopt(dataDir)).toThrow("no readable runtime identity");
  });

  it("refuses a staged runtime whose digest differs from the approved one", () => {
    const dataDir = scratchDir();
    stageRuntime({ dataDir });

    expect(() => adopt(dataDir, "b".repeat(64))).toThrow(
      "does not match the approved digest",
    );
  });
});

describe("isPrivateServerUpdateEnabled", () => {
  it("stays off on a host without the update directory", () => {
    expect(isPrivateServerUpdateEnabled({ dataDir: scratchDir() })).toBe(false);
  });

  it("turns on for a host with the update directory, whatever the runtime version form", () => {
    expect(
      isPrivateServerUpdateEnabled({ dataDir: dataDirWithUpdateDir() }),
    ).toBe(true);
  });
});
