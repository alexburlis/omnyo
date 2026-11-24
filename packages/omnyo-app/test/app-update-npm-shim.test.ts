import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_UPDATE_RESTART_EXIT_CODE,
  formatAppUpdateStatePath,
  mutateAppUpdateState,
  readAppUpdateState,
  type InstalledNpmAppRevision,
  type NpmAppRevision,
} from "@omnyo/config/app-update";
import type { ChildProcessExitResult } from "@omnyo/config/child-process-exit";
import { runNpmShim, selectNpmRevision } from "../src/app-update/npm-shim.js";
import type {
  LauncherRun,
  LauncherUpdateMode,
  ShimOutput,
} from "../src/app-update/shim-support.js";

const NODE_ABI = "137";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-app-update-shim-"));
  scratchDirs.push(dir);

  return dir;
}

function revision(version: string): NpmAppRevision {
  return {
    kind: "npm",
    packageRoot: `/versions/${version}/omnyo-app`,
    version,
  };
}

function installed(
  version: string,
  nodeAbi = NODE_ABI,
): InstalledNpmAppRevision {
  return { ...revision(version), nodeAbi };
}

type LaunchStep = () => Promise<ChildProcessExitResult>;

function scriptedLauncher(steps: LaunchStep[]) {
  const launches: string[] = [];
  const modes: LauncherUpdateMode[] = [];

  const spawnLauncher = (
    launched: NpmAppRevision,
    mode: LauncherUpdateMode,
  ): LauncherRun => {
    launches.push(launched.version);
    modes.push(mode);
    const step = steps.shift();

    if (step === undefined) {
      throw new Error(`Unexpected launch of ${launched.version}`);
    }

    return { exit: step(), kill: () => undefined };
  };

  return { launches, modes, spawnLauncher };
}

function output(): ShimOutput & { lines: string[] } {
  const lines: string[] = [];

  return {
    error: (message) => lines.push(`error: ${message}`),
    info: (message) => lines.push(`info: ${message}`),
    lines,
    warn: (message) => lines.push(`warn: ${message}`),
  };
}

function exit(code: number | null): Promise<ChildProcessExitResult> {
  return Promise.resolve({ code, signal: null });
}

async function recordSwitch(dataDir: string, version: string): Promise<void> {
  await mutateAppUpdateState(dataDir, (state) => ({
    ...state,
    current: installed(version),
    pending: {
      from: revision("1.0.0"),
      id: "update-1",
      requestedAt: "2026-09-23T00:00:00.000Z",
      to: revision(version),
    },
  }));
}

function shimArgs(args: {
  dataDir: string;
  output?: ShimOutput;
  spawnLauncher: (
    revision: NpmAppRevision,
    mode: LauncherUpdateMode,
  ) => LauncherRun;
  isUsable?: (revision: NpmAppRevision) => boolean;
  useBundled?: boolean;
  acquireLock?: Parameters<typeof runNpmShim>[0]["acquireLock"];
}) {
  return {
    ...(args.acquireLock === undefined
      ? {}
      : { acquireLock: args.acquireLock }),
    bundled: revision("1.0.0"),
    dataDir: args.dataDir,
    isUsable: args.isUsable ?? (() => true),
    nodeAbi: NODE_ABI,
    output: args.output ?? output(),
    spawnLauncher: args.spawnLauncher,
    updateMode: "private" as const,
    useBundled: args.useBundled ?? false,
  };
}

describe("selectNpmRevision", () => {
  const select = (current: InstalledNpmAppRevision | null, bundled = "1.0.0") =>
    selectNpmRevision({
      bundled: revision(bundled),
      current,
      isUsable: () => true,
      nodeAbi: NODE_ABI,
    });

  it("runs an installed version newer than the npx copy", () => {
    expect(select(installed("1.1.0"))).toMatchObject({
      reason: "installed-newer",
      revision: { version: "1.1.0" },
    });
  });

  it("runs a newer npx copy over an older installed version", () => {
    expect(select(installed("1.1.0"), "1.2.0").revision.version).toBe("1.2.0");
  });

  it("orders nightly prereleases after their stable base", () => {
    expect(select(installed("1.0.1-nightly.123.1")).revision.version).toBe(
      "1.0.1-nightly.123.1",
    );
  });

  it("refuses a downgrade when the newer install needs another Node.js", () => {
    expect(() => select(installed("1.1.0", "127"))).toThrow(/Node.js/u);
  });

  it("refuses a downgrade when the newer install is missing from disk", () => {
    expect(() =>
      selectNpmRevision({
        bundled: revision("1.0.0"),
        current: installed("1.1.0"),
        isUsable: () => false,
        nodeAbi: NODE_ABI,
      }),
    ).toThrow(/1\.1\.0/u);
  });

  it.each(["1.1.0", "1.2.0"])(
    "allows bundled %s despite an unusable older or equal install",
    (bundled) => {
      expect(
        selectNpmRevision({
          bundled: revision(bundled),
          current: installed("1.1.0", "127"),
          isUsable: () => false,
          nodeAbi: NODE_ABI,
        }).revision.version,
      ).toBe(bundled);
    },
  );

  it.each([
    ["1.0.0+private.10", "1.0.0+private.9", "1.0.0+private.10"],
    ["1.0.0+private.9", "1.0.0+private.10", "1.0.0+private.10"],
    ["1.0.0+private.10", "1.0.0+private.10", "1.0.0+private.10"],
    ["1.0.1", "0.46.260+private.1", "1.0.1"],
    ["1.0.0+private.1", "0.46.260+private.1", "1.0.0+private.1"],
    ["1.0.0+private.1", "1.0.0", "1.0.0+private.1"],
    ["1.0.0", "1.0.0+private.1", "1.0.0+private.1"],
  ])("orders installed %s against bundled %s", (current, bundled, expected) => {
    expect(select(installed(current), bundled).revision.version).toBe(expected);
  });

  it.each([
    ["invalid", "1.0.0"],
    ["1.1.0", "invalid"],
  ])(
    "refuses uncertain ordering for installed %s and bundled %s",
    (current, bundled) => {
      expect(() => select(installed(current), bundled)).toThrow(/version/u);
    },
  );
});

describe("runNpmShim", () => {
  it("keeps the selected runtime across newer diagnostic outcomes and restarts", async () => {
    const dataDir = scratchDir();
    const statePath = formatAppUpdateStatePath(dataDir);

    const state = (version: string) =>
      `${JSON.stringify({
        schemaVersion: 1,
        current: installed(version),
        pending: null,
        lastResult: {
          acknowledged: true,
          finishedAt: "2026-10-24T07:30:53.000Z",
          from: revision("1.0.0"),
          id: "newer-result",
          logTail: [],
          message: null,
          outcome: "superseded",
          phase: null,
          to: revision(version),
        },
      })}\n`;

    writeFileSync(statePath, state("1.1.0"));

    const launcher = scriptedLauncher([
      () => {
        writeFileSync(statePath, state("1.2.0"));

        return exit(APP_UPDATE_RESTART_EXIT_CODE);
      },
      () => exit(0),
    ]);

    const code = await runNpmShim(
      shimArgs({
        dataDir,
        spawnLauncher: launcher.spawnLauncher,
      }),
    );

    expect(code).toBe(0);
    expect(launcher.launches).toEqual(["1.1.0", "1.2.0"]);
    expect(launcher.modes).toEqual(["private", "private"]);
    expect(readFileSync(statePath, "utf8")).toBe(state("1.2.0"));
  });

  it("passes a normal launcher exit through", async () => {
    const dataDir = scratchDir();
    const launcher = scriptedLauncher([() => exit(0)]);

    const code = await runNpmShim(
      shimArgs({ dataDir, spawnLauncher: launcher.spawnLauncher }),
    );

    expect(code).toBe(0);
    expect(launcher.launches).toEqual(["1.0.0"]);
    expect(launcher.modes).toEqual(["private"]);
  });

  it("relaunches the version the launcher recorded when it asks for a restart", async () => {
    const dataDir = scratchDir();

    const launcher = scriptedLauncher([
      async () => {
        await recordSwitch(dataDir, "1.1.0");

        return { code: APP_UPDATE_RESTART_EXIT_CODE, signal: null };
      },
      () => exit(0),
    ]);

    const code = await runNpmShim(
      shimArgs({ dataDir, spawnLauncher: launcher.spawnLauncher }),
    );

    expect(code).toBe(0);
    expect(launcher.launches).toEqual(["1.0.0", "1.1.0"]);
    expect(launcher.modes).toEqual(["private", "private"]);
  });

  it("keeps passive runs passive for private updates", async () => {
    const locked = scriptedLauncher([() => exit(0)]);
    await runNpmShim(
      shimArgs({
        acquireLock: async () => null,
        dataDir: scratchDir(),
        spawnLauncher: locked.spawnLauncher,
      }),
    );

    expect(locked.modes).toEqual(["passive"]);
  });

  it("passes a failed start of the new version through without switching back", async () => {
    const dataDir = scratchDir();

    const launcher = scriptedLauncher([
      async () => {
        await recordSwitch(dataDir, "1.1.0");

        return { code: APP_UPDATE_RESTART_EXIT_CODE, signal: null };
      },
      () => exit(1),
    ]);

    const code = await runNpmShim(
      shimArgs({ dataDir, spawnLauncher: launcher.spawnLauncher }),
    );

    expect(code).toBe(1);
    expect(launcher.launches).toEqual(["1.0.0", "1.1.0"]);
    expect((await readAppUpdateState(dataDir)).current).toEqual(
      installed("1.1.0"),
    );
  });

  it("exits without relaunching when Omnyo is stopped during the restart", async () => {
    const dataDir = scratchDir();

    const launcher = scriptedLauncher([
      async () => {
        await recordSwitch(dataDir, "1.1.0");
        process.emit("SIGTERM");

        return { code: APP_UPDATE_RESTART_EXIT_CODE, signal: null };
      },
    ]);

    const code = await runNpmShim(
      shimArgs({ dataDir, spawnLauncher: launcher.spawnLauncher }),
    );

    expect(code).toBe(0);
    expect(launcher.launches).toEqual(["1.0.0"]);
  });

  it("restarts into the new version after an update started with --bundled", async () => {
    const dataDir = scratchDir();

    const launcher = scriptedLauncher([
      async () => {
        await recordSwitch(dataDir, "1.1.0");

        return { code: APP_UPDATE_RESTART_EXIT_CODE, signal: null };
      },
      () => exit(0),
    ]);

    await runNpmShim(
      shimArgs({
        dataDir,
        spawnLauncher: launcher.spawnLauncher,
        useBundled: true,
      }),
    );

    expect(launcher.launches).toEqual(["1.0.0", "1.1.0"]);
  });

  it("runs passive without touching the state file when another shim manages the data directory", async () => {
    const dataDir = scratchDir();
    await recordSwitch(dataDir, "1.1.0");
    const before = readFileSync(formatAppUpdateStatePath(dataDir), "utf8");
    const launcher = scriptedLauncher([() => exit(1)]);

    const code = await runNpmShim(
      shimArgs({
        acquireLock: async () => null,
        dataDir,
        spawnLauncher: launcher.spawnLauncher,
      }),
    );

    expect(code).toBe(1);
    expect(launcher.launches).toEqual(["1.1.0"]);
    expect(launcher.modes).toEqual(["passive"]);
    expect(readFileSync(formatAppUpdateStatePath(dataDir), "utf8")).toBe(
      before,
    );
  });

  it.each([
    ["future schema", '{"schemaVersion":2,"current":null}\n'],
    ["corrupt JSON", "{broken\n"],
  ])(
    "refuses unreadable %s across initial, passive and restart paths",
    async (_name, bytes) => {
      for (const phase of ["initial", "passive", "restart"] as const) {
        const dataDir = scratchDir();
        const statePath = formatAppUpdateStatePath(dataDir);
        const messages = output();
        let released = false;

        const signalsBefore = [
          process.listenerCount("SIGINT"),
          process.listenerCount("SIGTERM"),
        ];

        if (phase === "restart") {
          await recordSwitch(dataDir, "1.1.0");
        } else {
          writeFileSync(statePath, bytes);
        }

        const launcher = scriptedLauncher([
          () => {
            if (phase === "restart") {
              writeFileSync(statePath, bytes);

              return exit(APP_UPDATE_RESTART_EXIT_CODE);
            }

            return exit(0);
          },
          () => exit(0),
        ]);

        const code = await runNpmShim(
          shimArgs({
            acquireLock: async () =>
              phase === "passive"
                ? null
                : {
                    release: async () => {
                      released = true;
                    },
                  },
            dataDir,
            output: messages,
            spawnLauncher: launcher.spawnLauncher,
          }),
        );

        expect(code, phase).toBe(1);
        expect(launcher.launches, phase).toEqual(
          phase === "restart" ? ["1.1.0"] : [],
        );
        expect(
          messages.lines.filter((line) => line.startsWith("error:")),
        ).toHaveLength(1);
        expect(readFileSync(statePath, "utf8")).toBe(bytes);
        expect(released).toBe(phase !== "passive");
        expect([
          process.listenerCount("SIGINT"),
          process.listenerCount("SIGTERM"),
        ]).toEqual(signalsBefore);
      }
    },
  );

  it.each([false, true])(
    "allows explicit bundled recovery with unreadable state and passive lock=%s",
    async (passive) => {
      const dataDir = scratchDir();
      const statePath = formatAppUpdateStatePath(dataDir);
      const bytes = '{"schemaVersion":2,"current":null}\n';
      writeFileSync(statePath, bytes);
      const launcher = scriptedLauncher([() => exit(0)]);

      const code = await runNpmShim(
        shimArgs({
          ...(passive ? { acquireLock: async () => null } : {}),
          dataDir,
          spawnLauncher: launcher.spawnLauncher,
          useBundled: true,
        }),
      );

      expect(code).toBe(0);
      expect(launcher.launches).toEqual(["1.0.0"]);
      expect(launcher.modes).toEqual(["passive"]);
      expect(readFileSync(statePath, "utf8")).toBe(bytes);
    },
  );

  it.each(["missing", "abi", "invalid"] as const)(
    "refuses an unsafe selected %s runtime without changing state",
    async (failure) => {
      for (const passive of [false, true]) {
        const dataDir = scratchDir();
        await mutateAppUpdateState(dataDir, (state) => ({
          ...state,
          current: installed(
            failure === "invalid" ? "invalid" : "1.1.0",
            failure === "abi" ? "127" : NODE_ABI,
          ),
        }));
        const statePath = formatAppUpdateStatePath(dataDir);
        const before = readFileSync(statePath, "utf8");
        const messages = output();
        const launcher = scriptedLauncher([() => exit(0)]);

        const code = await runNpmShim(
          shimArgs({
            ...(passive ? { acquireLock: async () => null } : {}),
            dataDir,
            isUsable: () => failure !== "missing",
            output: messages,
            spawnLauncher: launcher.spawnLauncher,
          }),
        );

        expect(code).toBe(1);
        expect(launcher.launches).toEqual([]);
        expect(
          messages.lines.filter((line) => line.startsWith("error:")),
        ).toHaveLength(1);
        expect(readFileSync(statePath, "utf8")).toBe(before);
      }
    },
  );

  it.each([null, "1.1.0"])(
    "refuses a restart below the launched version when current becomes %s",
    async (current) => {
      const dataDir = scratchDir();
      await recordSwitch(dataDir, "1.2.0");
      const statePath = formatAppUpdateStatePath(dataDir);
      let afterSwitch = "";
      const messages = output();

      const launcher = scriptedLauncher([
        async () => {
          await mutateAppUpdateState(dataDir, (state) => ({
            ...state,
            current: current === null ? null : installed(current),
          }));
          afterSwitch = readFileSync(statePath, "utf8");

          return exit(APP_UPDATE_RESTART_EXIT_CODE);
        },
        () => exit(0),
      ]);

      const code = await runNpmShim(
        shimArgs({
          dataDir,
          output: messages,
          spawnLauncher: launcher.spawnLauncher,
        }),
      );

      expect(code).toBe(1);
      expect(launcher.launches).toEqual(["1.2.0"]);
      expect(
        messages.lines.filter((line) => line.startsWith("error:")),
      ).toHaveLength(1);
      expect(readFileSync(statePath, "utf8")).toBe(afterSwitch);
    },
  );

  it("runs the npx copy with --bundled even when a newer version is installed", async () => {
    const dataDir = scratchDir();
    await mutateAppUpdateState(dataDir, (state) => ({
      ...state,
      current: installed("1.1.0"),
    }));
    const launcher = scriptedLauncher([() => exit(0)]);

    await runNpmShim(
      shimArgs({
        dataDir,
        spawnLauncher: launcher.spawnLauncher,
        useBundled: true,
      }),
    );

    expect(launcher.launches).toEqual(["1.0.0"]);
  });
});
