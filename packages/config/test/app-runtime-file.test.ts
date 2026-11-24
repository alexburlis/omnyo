import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimAppRuntimeFile,
  clearOwnAppRuntimeFile,
  formatAppRuntimeFilePath,
  readAppRuntimeFile,
} from "../src/app-runtime-file.js";
import {
  stopVerifiedProcess,
  type VerifiedProcessOps,
} from "../src/verified-process-stop.js";

const tempDirs: string[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-runtime-file-"));
  tempDirs.push(dataDir);

  return dataDir;
}

function recordFor(dataDir: string, pid: number) {
  return {
    dataDir,
    entryPath: "/opt/omnyo/omnyo-app.js",
    pid,
    serverUrl: "http://127.0.0.1:38886",
    startedAt: "2026-08-03T10:00:00.000Z",
    surface: "web",
    version: "0.34.0",
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dataDir = tempDirs.pop();

    if (dataDir !== undefined) {
      await rm(dataDir, { force: true, recursive: true });
    }
  }
});

describe("claimAppRuntimeFile", () => {
  it.each(["{broken", '{"pid":1111}'])(
    "refuses an unknown runtime owner without replacing %s",
    async (bytes) => {
      const dataDir = await createDataDir();
      const path = formatAppRuntimeFilePath(dataDir);
      await writeFile(path, bytes);
      await expect(
        claimAppRuntimeFile({
          ...recordFor(dataDir, 2222),
          isRunning: () => false,
        }),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(bytes);
    },
  );

  it("refuses an unreadable runtime owner and preserves its bytes", async () => {
    const dataDir = await createDataDir();
    const path = formatAppRuntimeFilePath(dataDir);
    const bytes = JSON.stringify(recordFor(dataDir, 1111));
    await writeFile(path, bytes, { mode: 0o600 });
    await chmod(path, 0);

    try {
      await expect(
        claimAppRuntimeFile({
          ...recordFor(dataDir, 2222),
          isRunning: () => false,
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(path, 0o600);
    }

    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("refuses to overwrite a record whose launcher still runs", async () => {
    const dataDir = await createDataDir();
    await claimAppRuntimeFile({
      ...recordFor(dataDir, 1_111),
      isRunning: () => true,
    });

    await expect(
      claimAppRuntimeFile({
        ...recordFor(dataDir, 2_222),
        isRunning: () => true,
      }),
    ).resolves.toBe(false);
    await expect(readAppRuntimeFile(dataDir)).resolves.toMatchObject({
      pid: 1_111,
    });
  });

  it("replaces a record whose launcher is gone", async () => {
    const dataDir = await createDataDir();
    await claimAppRuntimeFile({
      ...recordFor(dataDir, 1_111),
      isRunning: () => true,
    });

    await expect(
      claimAppRuntimeFile({
        ...recordFor(dataDir, 2_222),
        isRunning: () => false,
      }),
    ).resolves.toBe(true);
    await expect(readAppRuntimeFile(dataDir)).resolves.toMatchObject({
      pid: 2_222,
    });
  });
});

describe("clearOwnAppRuntimeFile", () => {
  it("leaves a record that belongs to another launcher", async () => {
    const dataDir = await createDataDir();
    await claimAppRuntimeFile({
      ...recordFor(dataDir, 1_111),
      isRunning: () => true,
    });

    await expect(clearOwnAppRuntimeFile({ dataDir, pid: 2_222 })).resolves.toBe(
      false,
    );
    await expect(readAppRuntimeFile(dataDir)).resolves.not.toBeNull();
  });

  it("removes its own record", async () => {
    const dataDir = await createDataDir();
    await claimAppRuntimeFile({
      ...recordFor(dataDir, 1_111),
      isRunning: () => true,
    });

    await expect(clearOwnAppRuntimeFile({ dataDir, pid: 1_111 })).resolves.toBe(
      true,
    );
    await expect(readAppRuntimeFile(dataDir)).resolves.toBeNull();
  });
});

describe("stopVerifiedProcess", () => {
  function createOps(
    overrides: Partial<VerifiedProcessOps> = {},
  ): VerifiedProcessOps {
    return {
      isRunning: () => true,
      kill: () => undefined,
      readIdentity: async () => ({
        command: "node /opt/omnyo/omnyo-app.js start",
        startedAt: Date.now() - 60_000,
      }),
      waitForExit: async () => true,
      ...overrides,
    };
  }

  const startedAt = new Date(Date.now() - 60_000).toISOString();

  it("reports still-running when the process survives SIGKILL", async () => {
    await expect(
      stopVerifiedProcess({
        killTimeoutMs: 10,
        pid: 4_242,
        processOps: createOps({ waitForExit: async () => false }),
        signal: "SIGTERM",
        startedAt,
        timeoutMs: 10,
        verifyTokens: ["omnyo-app.js"],
      }),
    ).resolves.toEqual({ kind: "still-running" });
  });

  it("refuses a process whose start time contradicts the record", async () => {
    const result = await stopVerifiedProcess({
      killTimeoutMs: 10,
      pid: 4_242,
      processOps: createOps({
        readIdentity: async () => ({
          command: "node /opt/omnyo/omnyo-app.js start",
          startedAt: Date.now() - 172_800_000,
        }),
      }),
      signal: "SIGTERM",
      startedAt,
      timeoutMs: 10,
      verifyTokens: ["omnyo-app.js"],
    });

    expect(result).toMatchObject({ kind: "unverified", reason: "start-time" });
  });

  it("refuses when the start time cannot be read at all", async () => {
    const result = await stopVerifiedProcess({
      killTimeoutMs: 10,
      pid: 4_242,
      processOps: createOps({
        readIdentity: async () => ({
          command: "node /opt/omnyo/omnyo-app.js start",
          startedAt: null,
        }),
      }),
      signal: "SIGTERM",
      startedAt,
      timeoutMs: 10,
      verifyTokens: ["omnyo-app.js"],
    });

    expect(result).toMatchObject({ kind: "unverified", reason: "start-time" });
  });
});
