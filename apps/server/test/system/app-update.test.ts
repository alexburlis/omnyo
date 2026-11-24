import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatPrivateServerUpdateManifestPath,
  type AppUpdateLauncherRequest,
  type LauncherAppUpdateStatus,
  type ServerToLauncherMessage,
  type SourceUpdateCheck,
} from "@omnyo/config/app-update";
import { ApiError } from "../../src/errors.js";
import { createAppUpdateService } from "../../src/services/system/app-update.js";
import type { PrivateDeliveryGuard } from "../../src/services/system/private-delivery-guard.js";
import {
  createLauncherChannel,
  LauncherRequestRejectedError,
  type LauncherChannel,
} from "../../src/services/system/launcher-channel.js";

const testLogger = {
  debug(): void {},
  error(): void {},
  info(): void {},
  warn(): void {},
};

const COMMIT_A = "a".repeat(40);

const COMMIT_B = "b".repeat(40);

class FakeLauncher implements LauncherChannel {
  readonly requests: AppUpdateLauncherRequest[] = [];
  private listeners = new Set<(status: LauncherAppUpdateStatus) => void>();
  private disconnectListeners = new Set<() => void>();
  respond: (request: AppUpdateLauncherRequest) => Promise<unknown> = async () =>
    null;

  dispose(): void {
    this.listeners.clear();
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);

    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) listener();
  }

  onStatus(listener: (status: LauncherAppUpdateStatus) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  request(request: AppUpdateLauncherRequest): Promise<unknown> {
    this.requests.push(request);

    return this.respond(request);
  }

  push(status: Partial<LauncherAppUpdateStatus>): void {
    for (const listener of this.listeners) {
      listener({
        activity: { phase: "idle" },
        current: { kind: "npm", packageRoot: "/pkg/1.0.0", version: "1.0.0" },
        lastResult: null,
        mode: "npm",
        ...status,
      });
    }
  }
}

function sourceCheck(
  overrides: Partial<SourceUpdateCheck> = {},
): SourceUpdateCheck {
  return {
    blocked: null,
    current: { commit: COMMIT_A, kind: "source", version: "1.0.0" },
    incoming: {
      commit: COMMIT_B,
      commitCount: 2,
      subjects: ["Fix bug", "Add feature"],
      version: "1.0.0",
    },
    ...overrides,
  };
}

function createService(args: {
  appSurface?: "desktop" | "web";
  isDevelopment?: boolean;
  launcher?: FakeLauncher | null;
  mode?: "npm" | "source" | null;
  now?: () => number;
  runningThreads?: number;
}) {
  const notifyChanged = vi.fn();

  const launcher =
    args.launcher === undefined ? new FakeLauncher() : args.launcher;

  const service = createAppUpdateService({
    currentCommit: null,
    appSurface: args.appSurface ?? "web",
    config: { appVersion: "1.0.0", isDevelopment: args.isDevelopment ?? false },
    countRunningThreads: () => args.runningThreads ?? 0,
    dataDir: "/unused-data-dir",
    launcher,
    logger: testLogger,
    mode: args.mode === undefined ? "npm" : args.mode,
    notifyChanged,
    ...(args.now === undefined ? {} : { now: args.now }),
    setDraining: vi.fn(),
    stopRunningThreads: async () => undefined,
  });

  launcher?.push({});

  return { launcher, notifyChanged, service };
}

async function expectApiError(
  promise: Promise<unknown>,
  code: string,
): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(ApiError);

  if (!(error instanceof ApiError)) throw new Error("expected ApiError");
  expect(error.body.code).toBe(code);

  return error;
}

describe("app update service", () => {
  it.each([
    [{ isDevelopment: true }, "development"],
    [{ appSurface: "desktop" as const }, "desktop"],
    [{ appSurface: "desktop" as const, isDevelopment: true }, "desktop"],
    [{ mode: null }, "unmanaged"],
    [{ launcher: null }, "unmanaged"],
  ])("reports updates as unsupported for %o", async (overrides, reason) => {
    const { service } = createService(overrides);

    const status = await service.getStatus({ forceRefresh: false });

    expect(status.support).toEqual({ kind: "unsupported", reason });
    expect(status.available).toBeNull();
    await expectApiError(
      service.apply({ confirmInterruptingThreads: true }),
      "app_update_unsupported",
    );
  });

  it("does not report a source checkout as current before its first check completes", async () => {
    const launcher = new FakeLauncher();
    const { service } = createService({ launcher, mode: "source" });
    const status = await service.getStatus({ forceRefresh: false });
    expect(status.available).toBeNull();
    expect(status.blocked).toMatchObject({ reason: "fetch-failed" });
  });

  it("rejects an update while one is running", async () => {
    const { launcher, service } = createService({ mode: "source" });
    launcher?.push({
      activity: {
        output: [],
        phase: "preparing",
        startedAt: "2026-09-23T00:00:00.000Z",
        step: "Downloading omnyo-app 1.1.0",
        target: { kind: "npm", version: "1.1.0" },
        targetVersion: "1.1.0",
      },
    });
    await expectApiError(
      service.apply({ confirmInterruptingThreads: true }),
      "app_update_in_progress",
    );
  });

  it("surfaces launcher rejections as conflicts", async () => {
    const launcher = new FakeLauncher();
    launcher.respond = async (request) => {
      if (request.type === "check-source") return sourceCheck();
      throw new Error("The source update owner rejected this fixture.");
    };

    const { service } = createService({ launcher, mode: "source" });

    const error = await expectApiError(
      service.apply({ confirmInterruptingThreads: true }),
      "app_update_rejected",
    );

    expect(error.body.message).toContain("source update owner rejected");
  });

  it.each([
    { kind: "npm" as const, version: "1.1.0" },
    { kind: "source" as const, commit: "b".repeat(40) },
  ])("maps $kind launcher status into activity and result", async (target) => {
    const { launcher, notifyChanged, service } = createService({});
    notifyChanged.mockClear();

    launcher?.push({
      activity: {
        phase: "restarting",
        startedAt: "2026-09-23T00:00:00.000Z",
        target,
        targetVersion: "1.1.0",
      },
      lastResult: {
        acknowledged: false,
        finishedAt: "2026-09-23T00:00:00.000Z",
        from: { kind: "npm", packageRoot: "/pkg/0.9.0", version: "0.9.0" },
        id: "result-1",
        logTail: ["boom"],
        message: "npm install failed",
        outcome: "failed",
        phase: "install",
        to: { kind: "npm", packageRoot: "/pkg/1.0.0", version: "1.0.0" },
      },
    });
    const status = await service.getStatus({ forceRefresh: false });

    expect(notifyChanged).toHaveBeenCalledOnce();
    expect(status.activity).toEqual({
      phase: "restarting",
      startedAt: "2026-09-23T00:00:00.000Z",
      targetCommit: target.kind === "source" ? "b".repeat(40) : null,
      targetVersion: "1.1.0",
    });
    expect(status.lastResult).toMatchObject({
      from: { commit: null, version: "0.9.0" },
      outcome: "failed",
    });
  });

  it("offers origin/main in source mode and reports why it is blocked", async () => {
    const launcher = new FakeLauncher();
    launcher.respond = async () =>
      sourceCheck({
        blocked: {
          message: "The working tree has uncommitted changes.",
          reason: "uncommitted-changes",
        },
      });
    const { service } = createService({ launcher, mode: "source" });
    launcher.push({
      current: { commit: COMMIT_A, kind: "source", version: "1.0.0" },
      mode: "source",
    });

    const status = await service.getStatus({ forceRefresh: true });

    expect(status.current).toEqual({ commit: COMMIT_A, version: "1.0.0" });
    expect(status.available).toMatchObject({
      channel: "main",
      commit: COMMIT_B,
      commitCount: 2,
    });
    expect(status.blocked?.reason).toBe("uncommitted-changes");
    await expectApiError(
      service.apply({ confirmInterruptingThreads: true }),
      "app_update_blocked",
    );
  });

  it("checks origin/main in the background without blocking unforced reads", async () => {
    const launcher = new FakeLauncher();
    let resolveCheck: (value: SourceUpdateCheck) => void = () => undefined;
    launcher.respond = () =>
      new Promise((resolvePromise) => {
        resolveCheck = resolvePromise;
      });
    let now = 0;

    const { notifyChanged, service } = createService({
      launcher,
      mode: "source",
      now: () => now,
    });

    notifyChanged.mockClear();

    const first = await service.getStatus({ forceRefresh: false });
    expect(first.available).toBeNull();
    expect(launcher.requests).toHaveLength(1);

    resolveCheck(sourceCheck());
    await vi.waitFor(() => expect(notifyChanged).toHaveBeenCalledOnce());
    const second = await service.getStatus({ forceRefresh: false });
    expect(second.available?.commit).toBe(COMMIT_B);
    expect(launcher.requests).toHaveLength(1);

    now = 61 * 60 * 1000;
    await service.getStatus({ forceRefresh: false });
    expect(launcher.requests).toHaveLength(2);
  });

  it("does not loop background checks when the launcher check keeps failing", async () => {
    const launcher = new FakeLauncher();
    launcher.respond = async () => {
      throw new Error("git fetch failed");
    };

    const { notifyChanged, service } = createService({
      launcher,
      mode: "source",
    });

    await service.getStatus({ forceRefresh: false });
    await vi.waitFor(() => expect(notifyChanged).toHaveBeenCalled());
    await service.getStatus({ forceRefresh: false });
    await service.getStatus({ forceRefresh: false });

    expect(launcher.requests).toHaveLength(1);
  });

  it("restarts a staged update once no unconfirmed threads are running", async () => {
    let runningThreads = 0;
    const launcher = new FakeLauncher();
    launcher.respond = async (request) =>
      request.type === "check-source"
        ? sourceCheck({
            incoming: {
              commit: COMMIT_B,
              commitCount: 2,
              subjects: [],
              version: "1.1.0",
            },
          })
        : null;

    const service = createAppUpdateService({
      currentCommit: null,
      appSurface: "web",
      config: { appVersion: "1.0.0", isDevelopment: false },
      countRunningThreads: () => runningThreads,
      dataDir: "/unused-data-dir",
      launcher,
      logger: testLogger,
      mode: "source",
      notifyChanged: vi.fn(),
      setDraining: vi.fn(),
      stopRunningThreads: async () => undefined,
    });

    launcher.push({});
    await service.apply({ confirmInterruptingThreads: false });

    runningThreads = 1;
    launcher.push({
      activity: {
        phase: "ready",
        startedAt: "2026-09-23T00:00:00.000Z",
        target: { kind: "source", commit: COMMIT_B },
        targetVersion: "1.1.0",
      },
    });
    launcher.push({
      activity: {
        phase: "ready",
        startedAt: "2026-09-23T00:00:00.000Z",
        target: { kind: "source", commit: COMMIT_B },
        targetVersion: "1.1.0",
      },
    });

    expect(
      launcher.requests
        .filter((request) => request.type !== "check-source")
        .slice(1),
    ).toEqual([
      {
        message:
          "1 thread started while Omnyo was downloading the update. Update again to restart.",
        type: "cancel",
      },
    ]);

    launcher.push({});
    await service.apply({ confirmInterruptingThreads: true });
    launcher.push({
      activity: {
        phase: "ready",
        startedAt: "2026-09-23T00:05:00.000Z",
        target: { kind: "source", commit: COMMIT_B },
        targetVersion: "1.1.0",
      },
    });
    expect(launcher.requests.at(-1)).toEqual({ type: "restart" });
  });

  it("stops offering updates once the launcher disconnects", async () => {
    const sourceLauncher = new FakeLauncher();
    sourceLauncher.respond = async (request) =>
      request.type === "check-source" ? sourceCheck() : null;

    const { launcher, notifyChanged, service } = createService({
      launcher: sourceLauncher,
      mode: "source",
    });

    expect(
      (await service.getStatus({ forceRefresh: true })).available,
    ).not.toBeNull();
    notifyChanged.mockClear();

    launcher?.disconnect();

    expect(notifyChanged).toHaveBeenCalledOnce();
    expect((await service.getStatus({ forceRefresh: false })).support).toEqual({
      kind: "unsupported",
      reason: "unmanaged",
    });
  });

  it("reports a launcher that rejects an acknowledgement as a conflict", async () => {
    const launcher = new FakeLauncher();
    launcher.respond = async () => {
      throw new Error("The omnyo-app launcher did not respond.");
    };

    const { service } = createService({ launcher, mode: "source" });

    await expectApiError(
      service.acknowledgeResult({ id: "result-1" }),
      "app_update_rejected",
    );
  });

  it("re-checks origin/main before applying a source update", async () => {
    const launcher = new FakeLauncher();

    const checks = [
      sourceCheck(),
      sourceCheck({
        incoming: {
          commit: "c".repeat(40),
          commitCount: 3,
          subjects: [],
          version: "1.0.0",
        },
      }),
    ];

    launcher.respond = async (request) =>
      request.type === "check-source" ? checks.shift() : null;
    const { service } = createService({ launcher, mode: "source" });
    await service.getStatus({ forceRefresh: true });

    await service.apply({ confirmInterruptingThreads: false });

    expect(launcher.requests.at(-1)).toMatchObject({
      target: { commit: "c".repeat(40), kind: "source" },
      type: "apply",
    });
  });
});

class FakeProcessPort extends EventEmitter {
  channel = { unref: vi.fn() };
  readonly sent: ServerToLauncherMessage[] = [];

  send = (
    message: ServerToLauncherMessage,
    callback: (error: Error | null) => void,
  ): boolean => {
    this.sent.push(message);
    callback(null);

    return true;
  };
}

describe("private coordinator updates", () => {
  const RUNTIME_SHA256 = "c".repeat(64);
  const dataDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dataDir) => rm(dataDir, { force: true, recursive: true })),
    );
  });

  async function stageManifest(
    text: string,
    deliveryApproved = true,
    approvedVersion = "0.46.20+private.1",
  ): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), "omnyo-private-update-"));
    dataDirs.push(dataDir);
    const path = formatPrivateServerUpdateManifestPath(dataDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);

    if (deliveryApproved)
      await writeFile(
        join(dirname(path), "approved-delivery.json"),
        JSON.stringify({
          schema: 1,
          version: approvedVersion,
          sourceCommit: COMMIT_B,
          runtimeSha256: RUNTIME_SHA256,
          snapshot: { webStateSha256: null, bundledPlugins: [] },
        }),
      );

    return dataDir;
  }

  function manifest(version = "0.46.20+private.1"): string {
    return JSON.stringify({
      schema: 1,
      version,
      protocolVersion: 237,
      sourceCommit: COMMIT_B,
      runtimeSha256: RUNTIME_SHA256,
      stagedAt: "2026-10-18T10:00:00.000Z",
    });
  }

  function createPrivateService(args: {
    dataDir: string;
    runningThreads: () => number;
    currentVersion?: string;
    privateDelivery?: PrivateDeliveryGuard;
    acquireRestartHold?: (
      ownerId: string,
      closePluginLeases: readonly string[],
    ) => Promise<void>;
    releaseRestartHold?: (ownerId: string) => Promise<void>;
    stopRunningThreads?: (args: {
      shouldContinue: () => boolean;
      timeoutMs: number;
    }) => Promise<void>;
  }) {
    const launcher = new FakeLauncher();
    const setDraining = vi.fn();
    const notifyChanged = vi.fn();
    const currentVersion = args.currentVersion ?? "0.46.19+private.1";

    const service = createAppUpdateService({
      currentCommit: null,
      appSurface: "web",
      config: { appVersion: currentVersion, isDevelopment: false },
      countRunningThreads: args.runningThreads,
      acquireRestartHold: args.acquireRestartHold ?? (async () => undefined),
      releaseRestartHold: args.releaseRestartHold ?? (async () => undefined),
      dataDir: args.dataDir,
      launcher,
      logger: testLogger,
      mode: "private",
      privateDelivery: args.privateDelivery ?? {
        bundledName: async () => null,
        snapshot: async () => {
          const web = await readFile(
            join(args.dataDir, "private-web-updates", "active.json"),
          ).catch(() => null);

          return {
            webStateSha256:
              web === null
                ? null
                : createHash("sha256").update(web).digest("hex"),
            bundledPlugins: [],
          };
        },
        flush: async () => undefined,
      },
      notifyChanged,
      setDraining,
      stopRunningThreads: args.stopRunningThreads ?? (async () => undefined),
    });

    launcher.push({
      current: {
        kind: "npm",
        packageRoot: `/pkg/${currentVersion}`,
        version: currentVersion,
      },
      mode: "private",
    });

    return { launcher, notifyChanged, service, setDraining };
  }

  async function pushReady(launcher: FakeLauncher): Promise<void> {
    launcher.push({
      activity: {
        phase: "ready",
        startedAt: "2026-10-18T10:05:00.000Z",
        target: {
          kind: "private",
          runtimeSha256: RUNTIME_SHA256,
          version: "0.46.20+private.1",
        },
        targetVersion: "0.46.20+private.1",
      },
      mode: "private",
    });

    for (let index = 0; index < 5; index++) await Promise.resolve();
  }

  it("never escalates an idle-only identity offer to forced chat interruption", async () => {
    vi.useFakeTimers();
    let runningThreads = 2;

    const stopRunningThreads = vi.fn(async () => {
      runningThreads = 0;
    });

    const acquire = vi.fn(async () => undefined);

    const text = JSON.stringify({
      ...JSON.parse(manifest()),
      schema: 2,
      activation: "idle-only",
    });

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(text),
      runningThreads: () => runningThreads,
      stopRunningThreads,
      acquireRestartHold: acquire,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(stopRunningThreads).not.toHaveBeenCalled();
    expect(setDraining).not.toHaveBeenCalled();
    expect(
      launcher.requests.some((request) => request.type === "restart"),
    ).toBe(false);
    await expect(
      service.apply({ confirmInterruptingThreads: true }),
    ).rejects.toMatchObject({ body: { code: "app_update_idle_only" } });
    expect(
      (await service.getStatus({ forceRefresh: false })).activity,
    ).toMatchObject({ phase: "preparing", step: "Waiting for idle" });
    runningThreads = 0;
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toEqual({ type: "restart" }),
    );
    expect(acquire).toHaveBeenCalledWith(expect.any(String), []);
    expect(stopRunningThreads).not.toHaveBeenCalled();
    service.dispose();
  });

  it("rejects initial forced activation of an idle-only identity offer before any launcher effect", async () => {
    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(
        JSON.stringify({
          ...JSON.parse(manifest()),
          schema: 2,
          activation: "idle-only",
        }),
      ),
      runningThreads: () => 2,
    });

    await expect(
      service.apply({ confirmInterruptingThreads: true }),
    ).rejects.toMatchObject({ body: { code: "app_update_idle_only" } });
    expect(launcher.requests).toEqual([]);
    service.dispose();
  });

  it("protects delivered fixes by refusing a runtime without delivery approval", async () => {
    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest(), false),
      runningThreads: () => 0,
    });

    await expectApiError(
      service.apply({ confirmInterruptingThreads: false }),
      "app_update_blocked",
    );
    expect(launcher.requests).toEqual([]);
    service.dispose();
  });

  it("protects delivered fixes that change after admission and releases only the owned hold", async () => {
    const dataDir = await stageManifest(manifest());

    const acquire = vi.fn(async () => {
      await mkdir(join(dataDir, "private-web-updates"));
      await writeFile(
        join(dataDir, "private-web-updates", "active.json"),
        "new delivered web",
      );
    });

    const release = vi.fn(async () => undefined);

    const { launcher, service, setDraining } = createPrivateService({
      dataDir,
      runningThreads: () => 0,
      acquireRestartHold: acquire,
      releaseRestartHold: release,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toMatchObject({
        type: "cancel",
        errorCode: "app_update_delivered_fixes_changed",
      }),
    );
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(release.mock.calls[0]).toEqual(acquire.mock.calls[0].slice(0, 1));
    expect(
      launcher.requests.some((request) => request.type === "restart"),
    ).toBe(false);
    await vi.waitFor(() => expect(setDraining).toHaveBeenLastCalledWith(false));
    service.dispose();
  });

  it("protects delivered fixes against a replacement approval while waiting and avoids stopping chats", async () => {
    const dataDir = await stageManifest(manifest());
    const stopRunningThreads = vi.fn(async () => undefined);

    const { launcher, service, setDraining } = createPrivateService({
      dataDir,
      runningThreads: () => 1,
      stopRunningThreads,
    });

    await service.apply({ confirmInterruptingThreads: true });
    const web = Buffer.from("new delivered web");
    await mkdir(join(dataDir, "private-web-updates"));
    await writeFile(join(dataDir, "private-web-updates", "active.json"), web);
    await writeFile(
      join(dataDir, "private-server-update", "approved-delivery.json"),
      JSON.stringify({
        schema: 1,
        version: "0.46.20+private.1",
        sourceCommit: COMMIT_B,
        runtimeSha256: RUNTIME_SHA256,
        snapshot: {
          webStateSha256: createHash("sha256").update(web).digest("hex"),
          bundledPlugins: [],
        },
      }),
    );
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toMatchObject({
        type: "cancel",
        errorCode: "app_update_delivered_fixes_changed",
      }),
    );
    expect(stopRunningThreads).not.toHaveBeenCalled();
    expect(
      launcher.requests.some((request) => request.type === "restart"),
    ).toBe(false);
    await vi.waitFor(() => expect(setDraining).toHaveBeenLastCalledWith(false));
    service.dispose();
  });

  it("protects delivered fixes by flushing pending registration work before final verification", async () => {
    let finishWork = () => {};

    let flushCalls = 0;

    const work = new Promise<void>((resolve) => {
      finishWork = resolve;
    });

    const dataDir = await stageManifest(manifest());

    const { launcher, service } = createPrivateService({
      dataDir,
      runningThreads: () => 0,
      privateDelivery: {
        snapshot: async () => ({ webStateSha256: null, bundledPlugins: [] }),
        bundledName: async () => null,
        flush: async () => {
          flushCalls += 1;
          await work;
        },
      },
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() => expect(flushCalls).toBe(1));
    expect(
      launcher.requests.some((request) => request.type === "restart"),
    ).toBe(false);
    finishWork();
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toEqual({ type: "restart" }),
    );
    expect(flushCalls).toBe(2);
    service.dispose();
  });

  it("keeps delivered fixes cancellation from stopping chats while verification is in flight", async () => {
    let finish = () => {};

    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const stopRunningThreads = vi.fn(async () => undefined);
    const flush = vi.fn(async () => work);

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 1,
      privateDelivery: {
        snapshot: async () => ({ webStateSha256: null, bundledPlugins: [] }),
        bundledName: async () => null,
        flush,
      },
      stopRunningThreads,
    });

    await service.apply({ confirmInterruptingThreads: true });
    await pushReady(launcher);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    const cancelled = service.cancel();
    finish();
    await cancelled;
    expect(stopRunningThreads).not.toHaveBeenCalled();
    expect(
      launcher.requests.some((request) => request.type === "restart"),
    ).toBe(false);
    expect(setDraining).toHaveBeenLastCalledWith(false);
    service.dispose();
  });

  it("keeps new turns flowing while a private update prepares and waits for idle chats", async () => {
    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 1,
    });

    launcher.respond = async (request) => {
      if (request.type === "apply") {
        launcher.push({
          activity: {
            output: [],
            phase: "preparing",
            startedAt: "2026-10-18T10:01:00.000Z",
            step: "Preparing runtime",
            target: request.target,
            targetVersion: request.targetVersion,
          },
          mode: "private",
        });
      }

      return null;
    };

    expect(
      await service.apply({ confirmInterruptingThreads: false }),
    ).toMatchObject({
      activity: { phase: "preparing" },
      installsWhenIdle: true,
      newTurnsPausedForUpdate: false,
    });
    await pushReady(launcher);
    expect(await service.getStatus({ forceRefresh: false })).toMatchObject({
      activity: { phase: "draining" },
      installsWhenIdle: true,
      newTurnsPausedForUpdate: false,
    });
    expect(await service.cancel()).toMatchObject({
      installsWhenIdle: false,
      newTurnsPausedForUpdate: false,
    });
    expect(setDraining).not.toHaveBeenCalled();
    service.dispose();
  });

  it("pauses new turns only for the restart handoff and resumes them while worker admission is busy", async () => {
    const acquire = vi.fn(async () => {
      throw new ApiError(409, "runtime_update_busy", "Worker is busy");
    });

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
      acquireRestartHold: acquire,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(setDraining.mock.calls).toEqual([[true], [false]]),
    );
    expect(
      (await service.getStatus({ forceRefresh: false }))
        .newTurnsPausedForUpdate,
    ).toBe(false);
    service.dispose();
  });

  it("keeps an idle-chat update waiting while a worker terminal owns admission", async () => {
    const acquire = vi.fn(async () => {
      throw new ApiError(409, "runtime_update_busy", "Worker is busy");
    });

    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
      acquireRestartHold: acquire,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    expect(
      launcher.requests.filter((request) => request.type === "restart"),
    ).toEqual([]);
    service.dispose();
  });

  it("rechecks stopping or hidden work after worker admission before restarting", async () => {
    let running = 0;
    const release = vi.fn(async () => undefined);

    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => running,
      acquireRestartHold: async () => {
        running = 1;
      },
      releaseRestartHold: release,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(
      launcher.requests.filter((request) => request.type === "restart"),
    ).toEqual([]);
    service.dispose();
  });

  it("retains admission when an uncertain restart cannot acknowledge cancellation after leaving ready", async () => {
    const release = vi.fn(async () => undefined);

    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
      releaseRestartHold: release,
    });

    launcher.respond = async (request) => {
      if (request.type === "restart")
        throw new Error("acknowledgement timed out");

      if (request.type === "cancel")
        throw new LauncherRequestRejectedError("Restart already accepted");

      return null;
    };

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(
        launcher.requests.some((request) => request.type === "restart"),
      ).toBe(true),
    );
    launcher.push({ activity: { phase: "idle" } });
    await expectApiError(service.cancel(), "app_update_rejected");
    expect(release).not.toHaveBeenCalled();
    const status = await service.getStatus({ forceRefresh: false });
    expect(status.blocked?.message).toContain("remains held");
    expect(status).toMatchObject({
      activity: { phase: "idle" },
      newTurnsPausedForUpdate: true,
    });
    service.dispose();
  });

  it("shows recovery when cancellation succeeds but releasing its worker hold is uncertain", async () => {
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("Worker response was lost"))
      .mockResolvedValue(undefined);

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
      releaseRestartHold: release,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(
        launcher.requests.some((request) => request.type === "restart"),
      ).toBe(true),
    );
    await expectApiError(service.cancel(), "app_update_rejected");
    expect(launcher.requests.at(-1)?.type).toBe("cancel");
    expect(
      (await service.getStatus({ forceRefresh: false })).blocked?.message,
    ).toContain("remains held");
    expect(setDraining).toHaveBeenLastCalledWith(true);
    await service.cancel();
    expect(
      launcher.requests.filter((request) => request.type === "cancel"),
    ).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls[0]).toEqual(release.mock.calls[1]);
    expect(setDraining).toHaveBeenLastCalledWith(false);
    service.dispose();
  });

  it("offers a staged private runtime that is newer than the running one", async () => {
    const { service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
    });

    const status = await service.getStatus({ forceRefresh: false });

    expect(status.support).toEqual({ kind: "supported", mode: "private" });
    expect(status.available).toEqual({
      channel: "private",
      commit: COMMIT_B,
      commitCount: null,
      subjects: [],
      version: "0.46.20+private.1",
    });
  });

  it("does not offer a staged runtime that is not newer than the running one", async () => {
    const { service } = createPrivateService({
      dataDir: await stageManifest(manifest("0.46.19+private.1")),
      runningThreads: () => 0,
    });

    const status = await service.getStatus({ forceRefresh: false });

    expect(status.available).toBeNull();
    expect(status.blocked).toBeNull();
  });

  it.each([
    ["0.46.382+private.1", "1.0.0+private.1", "1.0.0+private.1"],
    ["1.0.0+private.1", "1.0.1", "1.0.1"],
    ["1.0.1", "1.0.2", "1.0.2"],
    ["1.0.0+private.1", "1.0.0", null],
    ["1.0.1", "1.0.1", null],
  ])(
    "on %s offers staged runtime %s as %s",
    async (currentVersion, staged, offered) => {
      const { service } = createPrivateService({
        currentVersion,
        dataDir: await stageManifest(manifest(staged), true, staged),
        runningThreads: () => 0,
      });

      const status = await service.getStatus({ forceRefresh: false });

      expect(status.support).toEqual({ kind: "supported", mode: "private" });
      expect(status.available?.version ?? null).toBe(offered);
      expect(status.blocked).toBeNull();
    },
  );

  it("reports an unreadable staged runtime manifest instead of hiding it", async () => {
    const { service } = createPrivateService({
      dataDir: await stageManifest("{"),
      runningThreads: () => 0,
    });

    const status = await service.getStatus({ forceRefresh: false });

    expect(status.available).toBeNull();
    expect(status.blocked).toMatchObject({ reason: "update-unreadable" });
  });

  it("waits for running chats without pausing new turns, then restarts once they finish", async () => {
    vi.useFakeTimers();
    let runningThreads = 2;
    const stopRunningThreads = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => undefined);

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => runningThreads,
      acquireRestartHold: acquire,
      stopRunningThreads,
    });

    await service.apply({ confirmInterruptingThreads: false });

    expect(launcher.requests).toEqual([
      {
        target: {
          kind: "private",
          runtimeSha256: RUNTIME_SHA256,
          version: "0.46.20+private.1",
        },
        targetVersion: "0.46.20+private.1",
        type: "apply",
      },
    ]);

    await pushReady(launcher);
    expect(launcher.requests).toHaveLength(1);
    expect(setDraining).not.toHaveBeenCalled();
    expect(
      (await service.getStatus({ forceRefresh: false })).activity,
    ).toMatchObject({ phase: "draining", targetVersion: "0.46.20+private.1" });

    runningThreads = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() =>
      expect(
        launcher.requests.some((request) => request.type === "restart"),
      ).toBe(true),
    );
    expect(launcher.requests.at(-1)).toEqual({ type: "restart" });
    expect(setDraining.mock.calls).toEqual([[true]]);
    expect(stopRunningThreads).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledWith(expect.any(String), []);
  });

  it("stops and resumes running chats once a private update has waited 10 minutes for idle chats", async () => {
    vi.useFakeTimers();
    let runningThreads = 2;

    const acquire = vi.fn(async () => {
      throw new ApiError(409, "runtime_update_busy", "Worker is busy");
    });

    const stopRunningThreads = vi.fn(async () => {
      runningThreads = 0;
    });

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => runningThreads,
      acquireRestartHold: acquire,
      stopRunningThreads,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);

    const waiting = await service.getStatus({ forceRefresh: false });
    expect(waiting.installsWhenIdle).toBe(true);

    if (waiting.activity.phase !== "draining")
      throw new Error("expected the update to wait for idle chats");
    expect(
      Date.parse(waiting.activity.stopsRunningChatsAt) -
        Date.parse(waiting.activity.startedAt),
    ).toBe(10 * 60 * 1000);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 5_000);
    expect(stopRunningThreads).not.toHaveBeenCalled();
    expect(launcher.requests.some((r) => r.type === "restart")).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() =>
      expect(
        launcher.requests.some((request) => request.type === "restart"),
      ).toBe(true),
    );
    expect(stopRunningThreads).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(launcher.requests.at(-1)).toEqual({ type: "restart" });
    expect(setDraining.mock.calls).toEqual([[true]]);
    service.dispose();
  });

  it("stops every running chat before restarting when Alex updates now", async () => {
    let runningThreads = 3;
    const acquire = vi.fn(async () => undefined);

    const stopRunningThreads = vi.fn(async () => {
      runningThreads = 0;
    });

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => runningThreads,
      acquireRestartHold: acquire,
      stopRunningThreads,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    expect(stopRunningThreads).not.toHaveBeenCalled();
    expect(
      await service.apply({ confirmInterruptingThreads: true }),
    ).toMatchObject({ installsWhenIdle: false });

    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toEqual({ type: "restart" }),
    );
    expect(stopRunningThreads).toHaveBeenCalledOnce();
    expect(setDraining.mock.calls).toEqual([[true]]);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("stops running chats only once the update is ready to restart", async () => {
    const stopRunningThreads = vi.fn(async () => undefined);

    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
      stopRunningThreads,
    });

    await service.apply({ confirmInterruptingThreads: true });
    expect(stopRunningThreads).not.toHaveBeenCalled();
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toEqual({ type: "restart" }),
    );
    expect(stopRunningThreads).toHaveBeenCalledOnce();
  });

  it("abandons an update-now and resumes chats when a running chat cannot be stopped", async () => {
    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 1,
      stopRunningThreads: async () => {
        throw new Error("1 turn did not stop.");
      },
    });

    await service.apply({ confirmInterruptingThreads: true });
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toMatchObject({ type: "cancel" }),
    );
    const cancel = launcher.requests.at(-1);
    expect(cancel?.type === "cancel" ? cancel.message : null).toContain(
      "1 turn did not stop.",
    );
    expect(launcher.requests.some((r) => r.type === "restart")).toBe(false);
    await vi.waitFor(() => expect(setDraining).toHaveBeenLastCalledWith(false));
    service.dispose();
  });

  it("restarts an update-now without asking a busy worker for idle admission", async () => {
    const acquire = vi.fn(async () => {
      throw new ApiError(409, "runtime_update_busy", "Worker is busy");
    });

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
      acquireRestartHold: acquire,
    });

    await service.apply({ confirmInterruptingThreads: true });
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toEqual({ type: "restart" }),
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(setDraining.mock.calls).toEqual([[true]]);
    expect(await service.getStatus({ forceRefresh: false })).toMatchObject({
      newTurnsPausedForUpdate: true,
    });
    expect(launcher.requests.some((r) => r.type === "cancel")).toBe(false);
    service.dispose();
  });

  it.each(["busy", "held"])(
    "pauses chats before restarting when update-now overtakes an idle worker check that returns %s",
    async (result) => {
      let settleAdmission = () => undefined;

      const acquire = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settleAdmission = () => {
              if (result === "busy")
                reject(
                  new ApiError(409, "runtime_update_busy", "Worker is busy"),
                );
              else resolve();
            };
          }),
      );

      const release = vi.fn(async () => undefined);
      const stopRunningThreads = vi.fn(async () => undefined);

      const { launcher, service } = createPrivateService({
        dataDir: await stageManifest(manifest()),
        runningThreads: () => 0,
        acquireRestartHold: acquire,
        releaseRestartHold: release,
        stopRunningThreads,
      });

      await service.apply({ confirmInterruptingThreads: false });
      await pushReady(launcher);
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
      await service.apply({ confirmInterruptingThreads: true });
      settleAdmission();
      await vi.waitFor(() =>
        expect(launcher.requests.at(-1)).toEqual({ type: "restart" }),
      );
      expect(stopRunningThreads).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledTimes(result === "held" ? 1 : 0);
      service.dispose();
    },
  );

  it("keeps new turns paused without claiming a worker hold after an uncertain forced restart", async () => {
    const release = vi.fn(async () => undefined);

    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
      releaseRestartHold: release,
    });

    launcher.respond = async (request) => {
      if (request.type === "restart")
        throw new Error("Acknowledgement was lost");

      if (request.type === "cancel")
        throw new LauncherRequestRejectedError("Restart already accepted");

      return null;
    };

    await service.apply({ confirmInterruptingThreads: true });
    await pushReady(launcher);
    await vi.waitFor(async () => {
      const status = await service.getStatus({ forceRefresh: false });
      expect(status.blocked?.message).toContain("New turns remain paused");
      expect(status.blocked?.message).not.toContain("admission remains held");
      expect(status.newTurnsPausedForUpdate).toBe(true);
    });
    await expectApiError(service.cancel(), "app_update_rejected");
    expect(
      (await service.getStatus({ forceRefresh: false })).blocked?.message,
    ).toContain("New turns remain paused");
    expect(release).not.toHaveBeenCalled();
    service.dispose();
  });

  it("keeps new turns paused when the launcher disconnects after accepting a forced restart", async () => {
    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
    });

    await service.apply({ confirmInterruptingThreads: true });
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toEqual({ type: "restart" }),
    );
    launcher.disconnect();
    const status = await service.getStatus({ forceRefresh: false });
    expect(status.newTurnsPausedForUpdate).toBe(true);
    expect(status.blocked).toMatchObject({
      code: "app_update_recovery_required",
    });
    service.dispose();
  });

  it("keeps an update-now request when a default apply races it", async () => {
    let running = 2;

    const stopRunningThreads = vi.fn(async () => {
      running = 0;
    });

    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => running,
      stopRunningThreads,
    });

    await Promise.all([
      service.apply({ confirmInterruptingThreads: true }),
      service.apply({ confirmInterruptingThreads: false }),
    ]);

    expect(launcher.requests.filter((r) => r.type === "apply")).toHaveLength(1);
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(launcher.requests.at(-1)).toEqual({ type: "restart" }),
    );
    expect(stopRunningThreads).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("stops scheduling further chat stops once the update is cancelled", async () => {
    let releaseStop: () => void = () => undefined;
    let shouldContinue: () => boolean = () => true;
    let stopping = false;

    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 1,
      stopRunningThreads: (args) => {
        stopping = true;
        shouldContinue = args.shouldContinue;

        return new Promise((resolve) => {
          releaseStop = resolve;
        });
      },
    });

    await service.apply({ confirmInterruptingThreads: true });
    await pushReady(launcher);
    await vi.waitFor(() => expect(stopping).toBe(true));
    const cancelling = service.cancel();
    expect(shouldContinue()).toBe(false);
    const second = service.cancel();
    releaseStop();
    await Promise.all([cancelling, second]);
    expect(
      launcher.requests.filter((request) => request.type === "cancel"),
    ).toHaveLength(1);
    expect(launcher.requests.some((r) => r.type === "restart")).toBe(false);
    service.dispose();
  });

  it("cancels a waiting update without ever pausing new turns", async () => {
    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 1,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await service.cancel();

    expect(setDraining).not.toHaveBeenCalled();
    expect(launcher.requests.at(-1)).toMatchObject({ type: "cancel" });
  });

  it("returns to waiting when the launcher refuses the restart, then retries", async () => {
    vi.useFakeTimers();

    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
    });

    launcher.respond = async (request) => {
      if (request.type === "restart")
        throw new LauncherRequestRejectedError("not ready");

      return null;
    };

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() => expect(setDraining).toHaveBeenLastCalledWith(false));

    expect(
      (await service.getStatus({ forceRefresh: false })).activity.phase,
    ).toBe("draining");

    launcher.respond = async () => null;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() =>
      expect(
        launcher.requests.filter((request) => request.type === "restart"),
      ).toHaveLength(2),
    );

    expect(
      launcher.requests.filter((request) => request.type === "restart"),
    ).toHaveLength(2);
  });

  it("forgets a waiting update when the launcher goes away", async () => {
    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 1,
    });

    await service.apply({ confirmInterruptingThreads: false });
    launcher.disconnect();

    expect(await service.getStatus({ forceRefresh: false })).toMatchObject({
      installsWhenIdle: false,
      newTurnsPausedForUpdate: false,
    });
    expect(setDraining).not.toHaveBeenCalled();
  });

  it("does not report a drain once the restart has been requested", async () => {
    const { launcher, service } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 0,
    });

    await service.apply({ confirmInterruptingThreads: false });
    await pushReady(launcher);
    await vi.waitFor(() =>
      expect(
        launcher.requests.some((request) => request.type === "restart"),
      ).toBe(true),
    );

    expect(launcher.requests.at(-1)).toEqual({ type: "restart" });
    expect(
      (await service.getStatus({ forceRefresh: false })).activity.phase,
    ).not.toBe("draining");
  });

  it("ends the waiting update when the launcher cannot stage the runtime", async () => {
    const { launcher, service, setDraining } = createPrivateService({
      dataDir: await stageManifest(manifest()),
      runningThreads: () => 1,
    });

    await service.apply({ confirmInterruptingThreads: false });
    launcher.push({
      current: {
        kind: "npm",
        packageRoot: "/pkg/0.46.19",
        version: "0.46.19+private.1",
      },
      mode: "private",
    });

    expect(
      (await service.getStatus({ forceRefresh: false })).installsWhenIdle,
    ).toBe(false);
    expect(setDraining).not.toHaveBeenCalled();
  });
});

describe("launcher channel", () => {
  it("returns null without an IPC channel", () => {
    const port = new FakeProcessPort();
    expect(
      createLauncherChannel({
        off: port.off.bind(port),
        on: port.on.bind(port),
      }),
    ).toBeNull();
  });

  it("says hello, unrefs the channel, and pairs responses with requests", async () => {
    const port = new FakeProcessPort();
    const channel = createLauncherChannel(port);
    expect(port.sent).toEqual([{ channel: "omnyo-app-update/hello" }]);
    expect(port.channel.unref).toHaveBeenCalled();

    const first = channel?.request({ type: "check-source" });
    const second = channel?.request({ id: "r", type: "acknowledge-result" });
    const [, firstRequest, secondRequest] = port.sent;

    if (
      firstRequest?.channel !== "omnyo-app-update/request" ||
      secondRequest?.channel !== "omnyo-app-update/request"
    ) {
      throw new Error("expected two requests");
    }

    port.emit("message", {
      channel: "omnyo-app-update/response",
      error: "boom",
      requestId: secondRequest.requestId,
      result: null,
    });
    port.emit("message", {
      channel: "omnyo-app-update/response",
      error: null,
      requestId: firstRequest.requestId,
      result: { ok: true },
    });

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).rejects.toThrow("boom");
  });

  it("forwards valid status pushes and ignores malformed messages", () => {
    const port = new FakeProcessPort();
    const channel = createLauncherChannel(port);
    const statuses: LauncherAppUpdateStatus[] = [];
    channel?.onStatus((status) => statuses.push(status));

    port.emit("message", {
      channel: "omnyo-app-update/status",
      status: { bad: true },
    });
    port.emit("message", "not an object");
    port.emit("message", {
      channel: "omnyo-app-update/status",
      status: {
        activity: { phase: "idle" },
        current: { kind: "npm", packageRoot: "/pkg", version: "1.0.0" },
        lastResult: null,
        mode: "npm",
      },
    });

    expect(statuses).toHaveLength(1);
  });

  it("rejects pending requests when the launcher disconnects", async () => {
    const port = new FakeProcessPort();
    const channel = createLauncherChannel(port);

    const pending = channel?.request({ type: "check-source" });
    port.emit("disconnect");

    await expect(pending).rejects.toThrow("disconnected");
  });
});

describe("unpublished Omnyo registry admission", () => {
  it("refuses unsupported npm mode without asking a provider or interrupting work", async () => {
    const { service, launcher } = createService({ runningThreads: 2 });

    const lookup = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected provider request"));

    try {
      const status = await service.getStatus({ forceRefresh: true });
      expect(status.support).toEqual({
        kind: "unsupported",
        reason: "unmanaged",
      });
      expect(status.available).toBeNull();

      const error = await expectApiError(
        service.apply({ confirmInterruptingThreads: true }),
        "app_update_unsupported",
      );

      expect(error.body.message).toMatch(/verified private release installer/i);
      expect(lookup).not.toHaveBeenCalled();
      expect(launcher?.requests).toEqual([]);
    } finally {
      lookup.mockRestore();
      service.dispose();
    }
  });
});

describe("unpublished Omnyo ready-status admission", () => {
  it.each([
    { label: "public registry", options: { mode: "npm" }, reason: "unmanaged" },
    { label: "unmanaged", options: { mode: null }, reason: "unmanaged" },
    {
      label: "desktop",
      options: { mode: "source", appSurface: "desktop" },
      reason: "desktop",
    },
    {
      label: "development",
      options: { mode: "source", isDevelopment: true },
      reason: "development",
    },
  ] as const)(
    "never restarts or cancels work for an unsupported $label ready status",
    async ({ options, reason }) => {
      const { service, launcher } = createService({
        ...options,
        runningThreads: 2,
      });

      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected provider request"));

      try {
        launcher?.push({
          mode: options.mode === "npm" ? "npm" : "source",
          activity: {
            phase: "ready",
            startedAt: "2026-11-04T00:00:00.000Z",
            target: { kind: "npm", version: "1.1.0" },
            targetVersion: "1.1.0",
          },
        });
        await Promise.resolve();
        expect(launcher?.requests).toEqual([]);
        expect(provider).not.toHaveBeenCalled();
        expect(
          (await service.getStatus({ forceRefresh: true })).support,
        ).toEqual({ kind: "unsupported", reason });
      } finally {
        provider.mockRestore();
        service.dispose();
      }
    },
  );
});
