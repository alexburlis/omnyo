import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_UPDATE_RESTART_EXIT_CODE,
  formatAppUpdateShimLockPath,
  formatAppUpdateStatePath,
  formatAppUpdateVersionsDir,
  formatPrivateServerUpdateManifestPath,
  launcherToServerMessageSchema,
  serverToLauncherMessageSchema,
  mutateAppUpdateState,
  readAppUpdateState,
  type AppRevision,
  type AppUpdateLauncherRequest,
  type AppUpdateMode,
  type AppUpdatePending,
  type LauncherToServerMessage,
  type NpmAppRevision,
} from "@omnyo/config/app-update";
import {
  createLauncherAppUpdateController,
  type LauncherAppUpdateController,
  type LauncherServerPort,
} from "../src/app-update/launcher-controller.js";
import {
  formatNpmRevisionPackageRoot,
  NPM_REVISION_REQUIRED_FILES,
} from "../src/app-update/npm-revision.js";
import type { RunCommand } from "../src/app-update/run-command.js";

const scratchDirs: string[] = [];

const controllers: LauncherAppUpdateController[] = [];

afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map((controller) => controller.dispose()),
  );

  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-app-update-controller-"));
  scratchDirs.push(dir);

  return dir;
}

function stagePackage(args: {
  packageRoot: string;
  version: string;
}): NpmAppRevision {
  for (const file of NPM_REVISION_REQUIRED_FILES) {
    mkdirSync(dirname(join(args.packageRoot, file)), { recursive: true });
    writeFileSync(join(args.packageRoot, file), "");
  }

  writeFileSync(
    join(args.packageRoot, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: args.version }),
  );

  writeFileSync(
    join(args.packageRoot, "dist", "runtime-identity.json"),
    JSON.stringify({ runtimeSha256: PRIVATE_DIGEST }),
  );

  return { kind: "npm", packageRoot: args.packageRoot, version: args.version };
}

function holdShimLock(dataDir: string, packageRoot: string): void {
  writeFileSync(
    formatAppUpdateShimLockPath(dataDir),
    JSON.stringify({
      entryPath: join(packageRoot, "dist", "omnyo-app.js"),
      pid: process.pid,
      startedAt: "2026-10-31T00:00:00.000Z",
    }),
  );
}

class FakeServerPort extends EventEmitter implements LauncherServerPort {
  connected = true;
  readonly sent: LauncherToServerMessage[] = [];

  send(
    message: LauncherToServerMessage,
    callback: (error: Error | null) => void,
  ): boolean {
    this.sent.push(launcherToServerMessageSchema.parse(message));
    callback(null);

    return true;
  }

  request(requestId: string, request: unknown): void {
    this.emit("message", {
      channel: "omnyo-app-update/request",
      request,
      requestId,
    });
  }

  async response(requestId: string) {
    await vi.waitFor(() => {
      expect(
        this.sent.some(
          (message) =>
            message.channel === "omnyo-app-update/response" &&
            message.requestId === requestId,
        ),
      ).toBe(true);
    });

    return this.sent.find(
      (message) =>
        message.channel === "omnyo-app-update/response" &&
        message.requestId === requestId,
    );
  }

  statuses() {
    return this.sent.flatMap((message) =>
      message.channel === "omnyo-app-update/status" ? [message.status] : [],
    );
  }
}

const failingRunner: RunCommand = async () => ({
  code: 1,
  outputTail: ["Unexpected external command"],
  signal: null,
  stdout: "",
});

function createController(args: {
  current: AppRevision;
  dataDir: string;
  mode?: AppUpdateMode;
  runner?: RunCommand | undefined;
  shutdowns?: string[];
}) {
  const controller = createLauncherAppUpdateController({
    current: args.current,
    dataDir: args.dataDir,
    log: () => undefined,
    mode: args.mode ?? "private",
    repoRoot: null,
    requestShutdown: (message) => args.shutdowns?.push(message),
    restartNoticeMs: 0,
    runner: args.runner ?? failingRunner,
  });

  controllers.push(controller);

  return controller;
}

function setUp(args: { runner?: RunCommand; stageTarget?: boolean } = {}) {
  const dataDir = scratchDir();

  const current = stagePackage({
    packageRoot: join(dataDir, "npx", "omnyo-app"),
    version: "1.0.0",
  });

  if (args.stageTarget !== false) {
    stagePackage({
      packageRoot: formatNpmRevisionPackageRoot(dataDir, "1.1.0"),
      version: "1.1.0",
    });
  }

  const shutdowns: string[] = [];

  const controller = createController({
    current,
    dataDir,
    runner: args.runner,
    shutdowns,
  });

  const port = new FakeServerPort();
  controller.attachServer(port);

  return { controller, current, dataDir, port, shutdowns };
}

function applyRequest(): AppUpdateLauncherRequest {
  return {
    target: {
      kind: "private",
      version: "1.1.0",
      runtimeSha256: PRIVATE_DIGEST,
    },
    targetVersion: "1.1.0",
    type: "apply",
  };
}

async function stageAndRestart(
  port: FakeServerPort,
  request: AppUpdateLauncherRequest = applyRequest(),
): Promise<void> {
  port.request("apply", request);
  await vi.waitFor(() =>
    expect(port.statuses().at(-1)?.activity.phase).toBe("ready"),
  );
  port.request("restart", { type: "restart" });
  expect(await port.response("restart")).toMatchObject({ error: null });
}

const PRIVATE_VERSION = "1.1.0+private.2";

const PRIVATE_DIGEST = "a".repeat(64);

function setUpPrivate(args: { stagedSha256: string }) {
  const dataDir = scratchDir();

  const current = stagePackage({
    packageRoot: join(dataDir, "npm", "lib", "node_modules", "omnyo-app"),
    version: "1.0.0+private.1",
  });

  const staged = stagePackage({
    packageRoot: formatNpmRevisionPackageRoot(dataDir, PRIVATE_VERSION),
    version: PRIVATE_VERSION,
  });

  writeFileSync(
    join(staged.packageRoot, "dist", "runtime-identity.json"),
    JSON.stringify({ runtimeSha256: args.stagedSha256 }),
  );
  const runner = vi.fn(failingRunner);
  const shutdowns: string[] = [];

  const controller = createController({
    current,
    dataDir,
    mode: "private",
    runner,
    shutdowns,
  });

  const port = new FakeServerPort();
  controller.attachServer(port);

  return { controller, current, dataDir, port, runner, shutdowns, staged };
}

function privateApplyRequest(): AppUpdateLauncherRequest {
  return {
    target: {
      kind: "private",
      runtimeSha256: PRIVATE_DIGEST,
      version: PRIVATE_VERSION,
    },
    targetVersion: PRIVATE_VERSION,
    type: "apply",
  };
}

describe("launcher app update controller", () => {
  it("stages, waits for the restart decision, and switches versions only after stopping", async () => {
    const { controller, current, dataDir, port, shutdowns } = setUp();

    const target = {
      kind: "npm",
      packageRoot: formatNpmRevisionPackageRoot(dataDir, "1.1.0"),
      version: "1.1.0",
    };

    await stageAndRestart(port);
    await vi.waitFor(() => expect(shutdowns).toHaveLength(1));

    expect(port.statuses().map((status) => status.activity.phase)).toEqual(
      expect.arrayContaining(["preparing", "ready", "restarting"]),
    );
    expect(await readAppUpdateState(dataDir)).toMatchObject({
      current: null,
      pending: null,
    });
    expect(await controller.finalizeExit()).toBe(75);
    expect(await readAppUpdateState(dataDir)).toMatchObject({
      current: { ...target, nodeAbi: process.versions.modules },
      pending: { from: current, to: target },
    });
  });

  it("keeps the current version when the switch cannot be recorded", async () => {
    const { controller, dataDir, port, shutdowns } = setUp();

    await stageAndRestart(port);
    await vi.waitFor(() => expect(shutdowns).toHaveLength(1));
    writeFileSync(formatAppUpdateStatePath(dataDir), "{");

    expect(await controller.finalizeExit()).toBe(75);
    expect(readFileSync(formatAppUpdateStatePath(dataDir), "utf8")).toBe("{");
  });

  it("records nothing pending when Omnyo stops before the restart decision", async () => {
    const { controller, dataDir, port, shutdowns } = setUp();

    port.request("apply", applyRequest());
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("ready"),
    );
    expect(await controller.finalizeExit()).toBeNull();
    await controller.dispose();

    port.request("late", { type: "restart" });
    expect(await port.response("late")).toMatchObject({
      error: "No update is waiting to restart.",
    });
    expect(shutdowns).toEqual([]);
    expect((await readAppUpdateState(dataDir)).pending).toBeNull();
  });

  it("records a guarded restart refusal as a failed update with a durable error code", async () => {
    const { dataDir, port, shutdowns } = setUp();
    port.request("apply", applyRequest());
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("ready"),
    );
    port.request("refused", {
      type: "cancel",
      message: "Worker activity prevents a safe restart. Chats resumed.",
      errorCode: "runtime_update_busy",
    });
    await port.response("refused");
    await vi.waitFor(async () =>
      expect((await readAppUpdateState(dataDir)).lastResult).toMatchObject({
        outcome: "failed",
        errorCode: "runtime_update_busy",
        phase: "prepare",
      }),
    );
    expect(shutdowns).toEqual([]);
  });

  it("cancels the restart when the server reports new threads", async () => {
    const { controller, dataDir, port, shutdowns } = setUp();

    port.request("apply", applyRequest());
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("ready"),
    );
    port.request("cancel", {
      message: "2 threads started while Omnyo was downloading the update.",
      type: "cancel",
    });
    await port.response("cancel");

    await vi.waitFor(async () =>
      expect((await readAppUpdateState(dataDir)).lastResult).toMatchObject({
        message: "2 threads started while Omnyo was downloading the update.",
        outcome: "cancelled",
        phase: null,
      }),
    );
    expect(shutdowns).toEqual([]);
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("idle"),
    );
    port.request("retry", applyRequest());
    expect(await port.response("retry")).toMatchObject({ error: null });
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("ready"),
    );
    expect(await controller.finalizeExit()).toBeNull();
  });

  it("waits for an in-flight source check to stop before finalizing shutdown", async () => {
    const dataDir = scratchDir();
    const commands: { aborted: boolean; exit: () => void }[] = [];

    const runner: RunCommand = async (call) => {
      if (call.args[0] !== "fetch") {
        return {
          code: 0,
          outputTail: [],
          signal: null,
          stdout:
            call.args[0] === "rev-parse"
              ? "commit-1"
              : call.args[0] === "show"
                ? JSON.stringify({ version: "1.0.0" })
                : call.args[0] === "symbolic-ref"
                  ? "main"
                  : "",
        };
      }

      return new Promise((resolvePromise) => {
        const command = {
          aborted: false,
          exit: () =>
            resolvePromise({
              code: null,
              outputTail: ["Cancelled"],
              signal: "SIGTERM",
              stdout: "",
            }),
        };

        call.signal?.addEventListener("abort", () => {
          command.aborted = true;
        });
        commands.push(command);
      });
    };

    const controller = createLauncherAppUpdateController({
      current: { commit: "commit-1", kind: "source", version: "1.0.0" },
      dataDir,
      log: () => undefined,
      mode: "source",
      repoRoot: dataDir,
      requestShutdown: () => undefined,
      runner,
    });

    controllers.push(controller);
    const port = new FakeServerPort();
    controller.attachServer(port);
    port.request("check", { type: "check-source" });
    await vi.waitFor(() => expect(commands).toHaveLength(1));

    let exited = false;

    const exiting = controller.finalizeExit().then((code) => {
      exited = true;

      return code;
    });

    try {
      expect(commands[0]?.aborted).toBe(true);
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(exited).toBe(false);
    } finally {
      commands[0]?.exit();
    }

    expect(await exiting).toBeNull();
    expect(await port.response("check")).toMatchObject({
      error: null,
      result: { blocked: { reason: "fetch-failed" } },
    });
  });

  it("keeps running and records the failure when the staged private runtime is missing", async () => {
    const { controller, dataDir, port, shutdowns } = setUp({
      stageTarget: false,
    });

    port.request("r1", applyRequest());
    await vi.waitFor(async () =>
      expect((await readAppUpdateState(dataDir)).lastResult?.outcome).toBe(
        "failed",
      ),
    );

    const state = await readAppUpdateState(dataDir);
    expect(state.pending).toBeNull();
    expect(state.lastResult).toMatchObject({ phase: "prepare" });
    expect(state.lastResult?.message).toMatch(/missing or incomplete/);
    expect(shutdowns).toEqual([]);
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("idle"),
    );
    expect(await controller.finalizeExit()).toBeNull();
  });

  it("refuses a second update while one is in flight", async () => {
    const { port } = setUp();

    port.request("r1", applyRequest());
    port.request("r2", applyRequest());

    expect(await port.response("r2")).toMatchObject({
      error: "An update is already in progress.",
    });
  });

  it("records the healthy update and preserves legacy installs without producer ownership", async () => {
    const dataDir = scratchDir();

    const from = stagePackage({
      packageRoot: join(dataDir, "npx", "omnyo-app"),
      version: "1.0.0",
    });

    const stale = formatNpmRevisionPackageRoot(dataDir, "1.0.5");
    stagePackage({ packageRoot: stale, version: "1.0.5" });

    const current = stagePackage({
      packageRoot: formatNpmRevisionPackageRoot(dataDir, "1.1.0"),
      version: "1.1.0",
    });

    const pending: AppUpdatePending = {
      from,
      id: "update-1",
      requestedAt: "2026-09-23T00:00:00.000Z",
      to: current,
    };

    await mutateAppUpdateState(dataDir, (state) => ({ ...state, pending }));
    holdShimLock(dataDir, from.packageRoot);
    const port = new FakeServerPort();
    const controller = createController({ current, dataDir });
    controller.attachServer(port);

    await controller.onFullStackReady();

    const state = await readAppUpdateState(dataDir);
    expect(state.pending).toBeNull();
    expect(state.lastResult).toMatchObject({
      id: "update-1",
      message: null,
      outcome: "updated",
    });
    expect(port.statuses().at(-1)?.lastResult?.outcome).toBe("updated");
    expect(readdirSync(formatAppUpdateVersionsDir(dataDir)).sort()).toEqual([
      "1.0.5",
      "1.1.0",
    ]);
  });

  it("keeps every install when no live shim identifies its bootstrap runtime", async () => {
    const dataDir = scratchDir();

    const install = (version: string) =>
      stagePackage({
        packageRoot: formatNpmRevisionPackageRoot(dataDir, version),
        version,
      });

    install("1.0.0");
    const from = install("1.1.0");
    const current = install("1.2.0");
    await mutateAppUpdateState(dataDir, (state) => ({
      ...state,
      pending: {
        from,
        id: "update-1",
        requestedAt: "2026-09-23T00:00:00.000Z",
        to: current,
      },
    }));

    await createController({ current, dataDir }).onFullStackReady();

    expect((await readAppUpdateState(dataDir)).lastResult?.outcome).toBe(
      "updated",
    );
    expect(readdirSync(formatAppUpdateVersionsDir(dataDir)).sort()).toEqual([
      "1.0.0",
      "1.1.0",
      "1.2.0",
    ]);
  });

  it("keeps unknown fields a newer Omnyo added to the state file", async () => {
    const dataDir = scratchDir();

    const current = stagePackage({
      packageRoot: formatNpmRevisionPackageRoot(dataDir, "1.1.0"),
      version: "1.1.0",
    });

    writeFileSync(
      formatAppUpdateStatePath(dataDir),
      JSON.stringify({
        current: null,
        futureField: { keep: true },
        lastResult: null,
        pending: {
          from: current,
          id: "update-1",
          requestedAt: "2026-09-23T00:00:00.000Z",
          to: current,
        },
        schemaVersion: 1,
      }),
    );

    await createController({ current, dataDir }).onFullStackReady();

    expect(
      JSON.parse(readFileSync(formatAppUpdateStatePath(dataDir), "utf8")),
    ).toMatchObject({ futureField: { keep: true }, pending: null });
  });

  it("records a failure when Omnyo starts a different version than the pending update", async () => {
    const dataDir = scratchDir();

    const current = stagePackage({
      packageRoot: join(dataDir, "npx", "omnyo-app"),
      version: "1.0.0",
    });

    const target = stagePackage({
      packageRoot: formatNpmRevisionPackageRoot(dataDir, "1.1.0"),
      version: "1.1.0",
    });

    await mutateAppUpdateState(dataDir, (state) => ({
      ...state,
      pending: {
        from: current,
        id: "update-1",
        requestedAt: "2026-09-23T00:00:00.000Z",
        to: target,
      },
    }));
    const controller = createController({ current, dataDir });

    await controller.onFullStackReady();

    const state = await readAppUpdateState(dataDir);
    expect(state.pending).toBeNull();
    expect(state.lastResult).toMatchObject({
      message: "Omnyo started 1.0.0 instead of 1.1.0.",
      outcome: "failed",
      phase: "startup",
    });
    expect(readdirSync(formatAppUpdateVersionsDir(dataDir)).sort()).toEqual([
      "1.1.0",
    ]);
  });

  it("acknowledges the last result on request", async () => {
    const { dataDir, port, current } = setUp();
    await mutateAppUpdateState(dataDir, (state) => ({
      ...state,
      lastResult: {
        acknowledged: false,
        finishedAt: "2026-09-23T00:00:00.000Z",
        from: current,
        id: "result-1",
        logTail: [],
        message: "boom",
        outcome: "failed",
        phase: "install",
        to: current,
      },
    }));

    port.request("r1", { id: "result-1", type: "acknowledge-result" });
    await port.response("r1");

    expect((await readAppUpdateState(dataDir)).lastResult?.acknowledged).toBe(
      true,
    );
    expect(port.statuses().at(-1)?.lastResult?.acknowledged).toBe(true);
  });

  it.each(["failed", "cancelled"] as const)(
    "resolves a historical %s result only after the exact target is healthy",
    async (outcome) => {
      const { controller, current, dataDir, port } = setUp();
      const from = { ...current, version: "0.9.0" };

      const result = {
        acknowledged: false,
        finishedAt: "2026-09-23T00:00:00.000Z",
        from,
        id: "historical-result",
        logTail: ["original diagnostic"],
        message: "original result",
        outcome,
        phase: null,
        to: current,
      };

      await mutateAppUpdateState(dataDir, (state) => ({
        ...state,
        lastResult: result,
      }));
      port.emit("message", { channel: "omnyo-app-update/hello" });
      await vi.waitFor(() =>
        expect(port.statuses().at(-1)?.lastResult).toEqual(result),
      );

      await controller.onFullStackReady();
      const resolved = { ...result, acknowledged: true };
      expect((await readAppUpdateState(dataDir)).lastResult).toEqual(resolved);
      expect(port.statuses().at(-1)?.lastResult).toEqual(resolved);
      await controller.dispose();

      const replacement = createController({ current, dataDir });
      await replacement.onFullStackReady();
      expect((await readAppUpdateState(dataDir)).lastResult).toEqual(resolved);
    },
  );

  it.each(["different-package", "different-commit", "same-revision"])(
    "keeps a failure actionable for %s even after healthy startup",
    async (scenario) => {
      const { current: installed, dataDir } = setUp();

      const current: AppRevision =
        scenario === "different-commit"
          ? { kind: "source", commit: "a".repeat(40), version: "1.0.0" }
          : installed;

      const target: AppRevision =
        current.kind === "source"
          ? { ...current, commit: "b".repeat(40) }
          : scenario === "different-package"
            ? { ...current, packageRoot: join(dataDir, "other-package") }
            : current;

      const result = {
        acknowledged: false,
        finishedAt: "2026-09-23T00:00:00.000Z",
        from: current,
        id: "unresolved-result",
        logTail: ["diagnostic"],
        message: "installation failed",
        outcome: "failed" as const,
        phase: "install" as const,
        to: target,
      };

      await mutateAppUpdateState(dataDir, (state) => ({
        ...state,
        lastResult: result,
      }));

      await createController({ current, dataDir }).onFullStackReady();

      expect((await readAppUpdateState(dataDir)).lastResult).toEqual(result);
    },
  );

  it("does not acknowledge a newer failure when an old result is dismissed", async () => {
    const { current, dataDir, port } = setUp();

    const newer = {
      acknowledged: false,
      finishedAt: "2026-09-23T00:00:00.000Z",
      from: current,
      id: "newer-failure",
      logTail: ["new diagnostic"],
      message: "new failure",
      outcome: "failed" as const,
      phase: "install" as const,
      to: { ...current, version: "1.2.0" },
    };

    await mutateAppUpdateState(dataDir, (state) => ({
      ...state,
      lastResult: newer,
    }));

    port.request("dismiss-old", {
      id: "old-result",
      type: "acknowledge-result",
    });
    expect(await port.response("dismiss-old")).toMatchObject({ error: null });
    expect((await readAppUpdateState(dataDir)).lastResult).toEqual(newer);
    expect(port.statuses().at(-1)?.lastResult).toEqual(newer);
  });
});

describe("launcher app update controller in private mode", () => {
  it("verifies the staged runtime without npm, then waits for the restart decision", async () => {
    const { port, runner } = setUpPrivate({ stagedSha256: PRIVATE_DIGEST });

    port.request("apply", privateApplyRequest());
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("ready"),
    );

    expect(
      port
        .statuses()
        .flatMap((status) =>
          status.activity.phase === "preparing" ? [status.activity.step] : [],
        ),
    ).toContain("Verifying staged runtime");
    expect(runner).not.toHaveBeenCalled();
  });

  it("switches to the staged runtime only after stopping", async () => {
    const { controller, current, dataDir, port, shutdowns, staged } =
      setUpPrivate({ stagedSha256: PRIVATE_DIGEST });

    await stageAndRestart(port, privateApplyRequest());
    await vi.waitFor(() => expect(shutdowns).toHaveLength(1));

    expect(await controller.finalizeExit()).toBe(APP_UPDATE_RESTART_EXIT_CODE);
    expect(await readAppUpdateState(dataDir)).toMatchObject({
      current: { ...staged, nodeAbi: process.versions.modules },
      pending: { from: current, to: staged },
    });
  });

  it("keeps the approved runtime and unknown legacy installs during startup retention", async () => {
    const dataDir = scratchDir();

    const install = (version: string) =>
      stagePackage({
        packageRoot: formatNpmRevisionPackageRoot(dataDir, version),
        version,
      });

    install("1.0.0+private.1");
    const from = install("1.1.0+private.1");
    const current = install("1.2.0+private.1");
    install("1.3.0+private.1");
    const manifestPath = formatPrivateServerUpdateManifestPath(dataDir);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        protocolVersion: 237,
        runtimeSha256: PRIVATE_DIGEST,
        schema: 1,
        sourceCommit: "c".repeat(40),
        stagedAt: "2026-10-18T10:00:00.000Z",
        version: "1.3.0+private.1",
      }),
    );
    await mutateAppUpdateState(dataDir, (state) => ({
      ...state,
      pending: {
        from,
        id: "update-1",
        requestedAt: "2026-10-18T10:00:00.000Z",
        to: current,
      },
    }));
    holdShimLock(dataDir, join(dataDir, "bundled", "omnyo-app"));
    const controller = createController({ current, dataDir, mode: "private" });
    controller.attachServer(new FakeServerPort());

    await controller.onFullStackReady();

    expect(readdirSync(formatAppUpdateVersionsDir(dataDir)).sort()).toEqual([
      "1.0.0+private.1",
      "1.1.0+private.1",
      "1.2.0+private.1",
      "1.3.0+private.1",
    ]);
  });

  it("keeps the shim's bootstrap runtime in app-versions across two updates", async () => {
    const dataDir = scratchDir();

    const install = (version: string) =>
      stagePackage({
        packageRoot: formatNpmRevisionPackageRoot(dataDir, version),
        version,
      });

    const bootstrap = install("1.0.0+private.1");
    holdShimLock(dataDir, bootstrap.packageRoot);
    let from = bootstrap;

    for (const [index, version] of [
      "1.1.0+private.1",
      "1.2.0+private.1",
    ].entries()) {
      const to = install(version);
      await mutateAppUpdateState(dataDir, (state) => ({
        ...state,
        pending: {
          from,
          id: `update-${String(index)}`,
          requestedAt: "2026-10-31T00:00:00.000Z",
          to,
        },
      }));

      const controller = createController({
        current: to,
        dataDir,
        mode: "private",
      });

      controller.attachServer(new FakeServerPort());
      await controller.onFullStackReady();
      expect((await readAppUpdateState(dataDir)).lastResult?.outcome).toBe(
        "updated",
      );
      from = to;
    }

    expect(readdirSync(formatAppUpdateVersionsDir(dataDir)).sort()).toEqual([
      "1.0.0+private.1",
      "1.1.0+private.1",
      "1.2.0+private.1",
    ]);
  });

  it("keeps waiting past a minute while the server drains, then restarts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const { controller, dataDir, port, shutdowns, staged } = setUpPrivate({
        stagedSha256: PRIVATE_DIGEST,
      });

      port.request("apply", privateApplyRequest());
      await vi.waitFor(() =>
        expect(port.statuses().at(-1)?.activity.phase).toBe("ready"),
      );
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect((await readAppUpdateState(dataDir)).lastResult).toBeNull();
      expect(port.statuses().at(-1)?.activity.phase).toBe("ready");

      port.request("restart", { type: "restart" });
      expect(await port.response("restart")).toMatchObject({ error: null });
      await vi.waitFor(() => expect(shutdowns).toHaveLength(1));
      expect(await controller.finalizeExit()).toBe(
        APP_UPDATE_RESTART_EXIT_CODE,
      );
      expect((await readAppUpdateState(dataDir)).pending).toMatchObject({
        to: staged,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a draining update when the server exits before deciding", async () => {
    const { controller, dataDir, port, shutdowns } = setUpPrivate({
      stagedSha256: PRIVATE_DIGEST,
    });

    port.request("apply", privateApplyRequest());
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("ready"),
    );
    port.connected = false;
    port.emit("exit");

    await vi.waitFor(async () =>
      expect((await readAppUpdateState(dataDir)).lastResult).toMatchObject({
        message:
          "The server stopped before confirming the restart. Update again to retry.",
        outcome: "failed",
        phase: "prepare",
      }),
    );
    expect(shutdowns).toEqual([]);
    expect(await controller.finalizeExit()).toBeNull();
  });

  it("keeps running and records a prepare failure when the staged digest differs", async () => {
    const { controller, dataDir, port, shutdowns, staged } = setUpPrivate({
      stagedSha256: "b".repeat(64),
    });

    port.request("apply", privateApplyRequest());
    await vi.waitFor(async () =>
      expect((await readAppUpdateState(dataDir)).lastResult?.outcome).toBe(
        "failed",
      ),
    );

    const state = await readAppUpdateState(dataDir);
    expect(state).toMatchObject({ current: null, pending: null });
    expect(state.lastResult).toMatchObject({ phase: "prepare", to: staged });
    expect(state.lastResult?.message).toContain("approved digest");
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("idle"),
    );
    expect(shutdowns).toEqual([]);
    expect(await controller.finalizeExit()).toBeNull();
  });
});

describe("unpublished Omnyo registry admission", () => {
  it("refuses an npm target before staging, pending changes, or installer calls", async () => {
    const runner = vi.fn(failingRunner);
    const dataDir = realpathSync(scratchDir());

    const current = stagePackage({
      packageRoot: join(dataDir, "current-runtime"),
      version: "1.0.0",
    });

    const shutdowns: string[] = [];

    const controller = createController({
      current,
      dataDir,
      mode: "npm",
      runner,
      shutdowns,
    });

    const port = new FakeServerPort();
    controller.attachServer(port);
    port.emit("message", { channel: "omnyo-app-update/hello" });
    await vi.waitFor(() =>
      expect(port.statuses().at(-1)?.activity.phase).toBe("idle"),
    );
    writeFileSync(join(dataDir, "user-work.txt"), "opaque user bytes");
    const beforeFiles = readdirSync(dataDir, { recursive: true }).sort();
    const beforeState = await readAppUpdateState(dataDir);
    port.request("unsupported-registry", {
      target: { kind: "npm", version: "1.1.0" },
      targetVersion: "1.1.0",
      type: "apply",
    });
    expect(await port.response("unsupported-registry")).toMatchObject({
      error: expect.stringMatching(
        /public registry updates.*unavailable.*private/i,
      ),
    });
    expect(runner).not.toHaveBeenCalled();
    expect(readdirSync(dataDir, { recursive: true }).sort()).toEqual(
      beforeFiles,
    );
    expect(readFileSync(join(dataDir, "user-work.txt"), "utf8")).toBe(
      "opaque user bytes",
    );
    expect(await readAppUpdateState(dataDir)).toEqual(beforeState);
    expect(port.statuses().at(-1)?.activity.phase).toBe("idle");
    expect(shutdowns).toEqual([]);
  });
});

describe("canonical launcher update channels", () => {
  it.each([
    { name: "hello", schema: serverToLauncherMessageSchema, fields: {} },
    {
      name: "request",
      schema: serverToLauncherMessageSchema,
      fields: { request: { type: "check-source" }, requestId: "req-1" },
    },
    {
      name: "response",
      schema: launcherToServerMessageSchema,
      fields: { error: null, requestId: "req-1", result: null },
    },
    {
      name: "status",
      schema: launcherToServerMessageSchema,
      fields: {
        status: {
          activity: { phase: "idle" },
          current: {
            kind: "npm",
            packageRoot: "/fixture/current",
            version: "1.0.0+private.1",
          },
          lastResult: null,
          mode: "private",
        },
      },
    },
  ])(
    "accepts only the canonical $name contract",
    ({ name, schema, fields }) => {
      expect(
        schema.safeParse({ ...fields, channel: `omnyo-app-update/${name}` })
          .success,
      ).toBe(true);
      expect(
        schema.safeParse({ ...fields, channel: `bb-app-update/${name}` })
          .success,
      ).toBe(false);
    },
  );
});
