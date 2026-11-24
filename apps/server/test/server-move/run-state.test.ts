import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertHost } from "@omnyo/db";
import { SERVER_MOVE_STEP_IDS, type ServerMoveStepId } from "@omnyo/domain";
import type { HostDaemonOnlineRpcRequestMessage } from "@omnyo/host-daemon-contract";
import { writeServerMovedFile } from "@omnyo/server-archive";
import type {
  ServerMoveStatus,
  ServerMoveStepStatus,
} from "@omnyo/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createServerMoveCoordinator } from "../../src/services/server-move/coordinator.js";
import {
  isServerMoveFrozen,
  isServerMoveSnapshotFenced,
} from "../../src/services/server-move/freeze-state.js";
import {
  reconcileServerMoveRunAtBoot,
  type RestoredServerMoveRun,
} from "../../src/services/server-move/reconcile.js";
import {
  SERVER_MOVE_RUN_FILE_NAME,
  writeServerMoveRunFile,
  type ServerMoveRunFile,
} from "../../src/services/server-move/run-state.js";
import {
  createTestServerMoveEnvironment,
  inspectResult,
  registerFakeDaemon,
  TEST_SERVER_MOVE_TIMINGS,
  type FakeDaemonReply,
} from "../helpers/server-move.js";
import { seedHost, seedPrimaryHost } from "../helpers/seed.js";
import {
  testLogger,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const OLD = "host-old";

const NEW = "host-new";

const WORKER = "host-worker";

const MOVE_ID = "move-boot-1";

const DIRECT_URL = "https://desktop.example.test";

const BOOT_NOW = 9_000;

const BOOT_TIMINGS = {
  ...TEST_SERVER_MOVE_TIMINGS,
  recoveryProbeIntervalMs: 20,
};

const ORIGINAL_CONFIG = '{"config":{"OMNYO_LOG_LEVEL":"info"}}\n';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

function ok(result: unknown): FakeDaemonReply {
  return { ok: true, result };
}

function targetReply(
  request: HostDaemonOnlineRpcRequestMessage,
): FakeDaemonReply {
  switch (request.command.type) {
    case "server_move.inspect":
      return ok(inspectResult());
    case "server_move.activate":
      return ok({ ok: true });
    case "server_move.abort":
      return ok({ ok: true, moveId: request.command.moveId, fenced: true });
    default:
      throw new Error(`Unexpected target command ${request.command.type}`);
  }
}

function seedTopology(harness: TestAppHarness): void {
  seedHost(harness.deps, { id: OLD, name: "Laptop" });
  seedPrimaryHost(harness.deps, OLD);
  seedHost(harness.deps, { id: NEW, name: "Desktop" });
  upsertHost(harness.db, harness.hub, { id: WORKER, name: "Worker" });
}

const ALL_THROUGH_SWITCH: Partial<
  Record<ServerMoveStepId, ServerMoveStepStatus>
> = {
  "stop-work": "done",
  "update-target": "skipped",
  export: "done",
  transfer: "done",
  "start-target": "done",
  "verify-address": "done",
  switch: "running",
};

function runFile(
  harness: TestAppHarness,
  state: ServerMoveStatus["state"],
  steps: Partial<Record<ServerMoveStepId, ServerMoveStepStatus>>,
  overrides: Partial<ServerMoveRunFile> = {},
): ServerMoveRunFile {
  return {
    version: 1,
    status: {
      moveId: MOVE_ID,
      state,
      mode: "direct",
      targetHostId: NEW,
      targetHostName: "Desktop",
      serverUrl: DIRECT_URL,
      destinationStatusUrl: `${DIRECT_URL}/health`,
      startedAt: 1_000,
      finishedAt: null,
      error: null,
      steps: SERVER_MOVE_STEP_IDS.map((id) => ({
        id,
        status: steps[id] ?? "pending",
        message: null,
      })),
      cancellable: state === "preparing",
    },
    activationToken: "activation-token-0123456789",
    archiveExistingTargetServerData: false,
    sourceServerHost: { id: OLD, name: "Laptop" },
    connectHandle: null,
    workDir: join(harness.config.dataDir, "server-move", MOVE_ID),
    grant: { serverUrl: DIRECT_URL, headers: {} },
    configBackup: null,
    movedAt: null,
    activationRequestedAt: null,
    activationConfirmedAt: null,
    prepareDispatchedAt: null,
    ...overrides,
  };
}

async function lockDataDir(harness: TestAppHarness): Promise<void> {
  await writeServerMovedFile(harness.config.dataDir, {
    version: 1,
    moveId: MOVE_ID,
    movedAt: 5_000,
    fromHostId: OLD,
    toHostId: NEW,
    toHostName: "Desktop",
    serverUrl: DIRECT_URL,
    mode: "direct",
    connectHandle: null,
    oldCopyEntries: ["app.db"],
  });
}

async function writeMovedConfig(harness: TestAppHarness): Promise<string> {
  const path = join(harness.config.dataDir, "config.json");
  await writeFile(
    path,
    `${JSON.stringify({ config: { OMNYO_LOG_LEVEL: "info" }, serverUrl: DIRECT_URL })}\n`,
  );

  return path;
}

async function reconcile(
  harness: TestAppHarness,
): Promise<RestoredServerMoveRun | null> {
  return reconcileServerMoveRunAtBoot({
    dataDir: harness.config.dataDir,
    logger: testLogger,
    now: BOOT_NOW,
  });
}

function requireRestored(
  restored: RestoredServerMoveRun | null,
): RestoredServerMoveRun {
  if (restored === null) {
    throw new Error("Expected a restored server move");
  }

  return restored;
}

function runFileExists(harness: TestAppHarness): boolean {
  return existsSync(join(harness.config.dataDir, SERVER_MOVE_RUN_FILE_NAME));
}

describe("server move boot reconciliation", () => {
  it("retains an ambiguous restarted preparation until management proves the target fence", () =>
    withTestHarness(async (harness) => {
      seedTopology(harness);

      const run = runFile(
        harness,
        "preparing",
        {
          "stop-work": "done",
          "update-target": "done",
          export: "done",
          transfer: "running",
        },
        { prepareDispatchedAt: 1000 },
      );

      await mkdir(run.workDir, { recursive: true });
      await writeFile(join(run.workDir, "server.bbsa"), "archive");
      await writeServerMoveRunFile(harness.config.dataDir, run);
      const restored = requireRestored(await reconcile(harness));
      expect(restored.kind).toBe("recovery_required");
      expect(existsSync(run.workDir)).toBe(true);

      const { environment, events, plugins } = createTestServerMoveEnvironment(
        harness,
        { timings: BOOT_TIMINGS },
      );

      const coordinator = createServerMoveCoordinator(environment);

      try {
        coordinator.restore(restored);
        expect(coordinator.getStatus()).toMatchObject({
          moveId: MOVE_ID,
          state: "recovery_required",
          cancellable: true,
          finishedAt: null,
        });
        expect(coordinator.isFrozen()).toBe(true);
        expect(plugins.paused).toBe(true);
        expect((await coordinator.cancel()).state).toBe("recovery_required");
        registerFakeDaemon(harness, {
          events,
          hostId: NEW,
          handle: targetReply,
        });
        expect((await coordinator.cancel()).state).toBe("cancelled");
        expect(events).toContain(`${NEW}:server_move.abort`);
        expect(coordinator.isFrozen()).toBe(false);
        await expect.poll(() => runFileExists(harness)).toBe(false);
      } finally {
        coordinator.dispose();
      }
    }));

  it("retains rewritten config until the ambiguous switch target is positively fenced", () =>
    withTestHarness(async (harness) => {
      seedTopology(harness);
      const configPath = await writeMovedConfig(harness);
      await writeServerMoveRunFile(
        harness.config.dataDir,
        runFile(harness, "switching", ALL_THROUGH_SWITCH, {
          configBackup: { path: configPath, originalText: ORIGINAL_CONFIG },
          movedAt: 5_000,
          activationRequestedAt: 5_100,
        }),
      );

      const restored = requireRestored(await reconcile(harness));

      expect(restored.kind).toBe("recovery_required");
      expect(JSON.parse(await readFile(configPath, "utf8"))).not.toEqual(
        JSON.parse(ORIGINAL_CONFIG),
      );

      const { environment, events } = createTestServerMoveEnvironment(harness, {
        timings: BOOT_TIMINGS,
      });

      const coordinator = createServerMoveCoordinator(environment);

      try {
        coordinator.restore(restored);
        registerFakeDaemon(harness, {
          events,
          hostId: NEW,
          handle: targetReply,
        });
        await coordinator.cancel();
        expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(
          JSON.parse(ORIGINAL_CONFIG),
        );
      } finally {
        coordinator.dispose();
      }
    }));

  it("brings back an unconfirmed locked run as recovery_required and finishes once the destination is ready", () =>
    withTestHarness(async (harness) => {
      seedTopology(harness);
      const configPath = await writeMovedConfig(harness);
      await lockDataDir(harness);
      await writeServerMoveRunFile(
        harness.config.dataDir,
        runFile(harness, "switching", ALL_THROUGH_SWITCH, {
          configBackup: { path: configPath, originalText: ORIGINAL_CONFIG },
          movedAt: 5_000,
          activationRequestedAt: 5_100,
        }),
      );
      const destination: { state: "pending" | "ready" } = { state: "pending" };

      const { environment, events, plugins, retired } =
        createTestServerMoveEnvironment(harness, { timings: BOOT_TIMINGS });

      registerFakeDaemon(harness, {
        events,
        hostId: OLD,
        handle: (request) =>
          request.command.type === "server_move.probe"
            ? ok({ reachable: true, message: null, state: destination.state })
            : targetReply(request),
      });
      registerFakeDaemon(harness, {
        events,
        hostId: WORKER,
        handle: targetReply,
      });

      const restored = requireRestored(await reconcile(harness));
      expect(restored.kind).toBe("recovery_required");
      const coordinator = createServerMoveCoordinator(environment);

      try {
        coordinator.restore(restored);

        expect(coordinator.getStatus()).toMatchObject({
          state: "recovery_required",
          cancellable: true,
          error: { step: "switch" },
        });
        expect(coordinator.isFrozen()).toBe(true);
        expect(isServerMoveFrozen(harness.db)).toBe(true);
        expect(isServerMoveSnapshotFenced(harness.db)).toBe(true);
        expect(coordinator.movedTo()).toBeNull();
        expect(plugins.paused).toBe(true);
        await coordinator.handlePluginsStarted();
        expect(plugins.suspends).toBe(1);
        await expect
          .poll(() => events.includes(`${OLD}:server_move.probe`))
          .toBe(true);
        expect(events).not.toContain("retire");

        destination.state = "ready";
        await retired;

        expect(coordinator.getStatus()?.state).toBe("completed");
        expect(events).toContain("plugins:stop");
        expect(events).toContain(`server.moved:${OLD}`);
        expect(events).toContain(`server.moved:${WORKER}`);
      } finally {
        coordinator.dispose();
      }
    }));

  it("republishes a confirmed locked run as completed and retires again", () =>
    withTestHarness(async (harness) => {
      seedTopology(harness);
      await lockDataDir(harness);
      await writeServerMoveRunFile(
        harness.config.dataDir,
        runFile(harness, "switching", ALL_THROUGH_SWITCH, {
          movedAt: 5_000,
          activationRequestedAt: 5_100,
          activationConfirmedAt: 5_200,
        }),
      );

      const restored = requireRestored(await reconcile(harness));
      expect(restored.kind).toBe("completed");
      const { environment, retired } = createTestServerMoveEnvironment(harness);
      const coordinator = createServerMoveCoordinator(environment);

      try {
        coordinator.restore(restored);

        expect(coordinator.getStatus()).toMatchObject({
          state: "completed",
          cancellable: false,
          error: null,
          finishedAt: BOOT_NOW,
        });
        expect(coordinator.getStatus()?.steps.at(-1)).toMatchObject({
          id: "switch",
          status: "done",
        });
        expect(coordinator.movedTo()).toEqual({
          serverUrl: DIRECT_URL,
          toHostName: "Desktop",
          movedAt: 5_000,
        });
        expect(coordinator.isFrozen()).toBe(true);
        expect(isServerMoveSnapshotFenced(harness.db)).toBe(true);
        await retired;
        expect(
          JSON.parse(
            await readFile(join(harness.config.dataDir, "config.json"), "utf8"),
          ),
        ).toMatchObject({ serverUrl: DIRECT_URL });
      } finally {
        coordinator.dispose();
      }
    }));

  it("forgets a committed run whose old copy was unlocked and leaves config.json alone", () =>
    withTestHarness(async (harness) => {
      const configPath = join(harness.config.dataDir, "config.json");
      await writeFile(configPath, ORIGINAL_CONFIG);
      await writeServerMoveRunFile(
        harness.config.dataDir,
        runFile(harness, "switching", ALL_THROUGH_SWITCH, {
          configBackup: {
            path: configPath,
            originalText: '{"config":{"OMNYO_LOG_LEVEL":"debug"}}\n',
          },
          movedAt: 5_000,
          activationRequestedAt: 5_100,
          activationConfirmedAt: 5_200,
        }),
      );

      expect(await reconcile(harness)).toBeNull();

      expect(runFileExists(harness)).toBe(false);
      expect(await readFile(configPath, "utf8")).toBe(ORIGINAL_CONFIG);
    }));

  it("never deletes a recorded work directory outside the data directory's move directory", () =>
    withTestHarness(async (harness) => {
      const outside = await mkdtemp(
        join(tmpdir(), "omnyo-server-move-outside-"),
      );

      tempDirs.push(outside);
      await writeFile(join(outside, "keep.txt"), "keep");
      await writeServerMoveRunFile(
        harness.config.dataDir,
        runFile(
          harness,
          "preparing",
          { "stop-work": "running" },
          { workDir: outside },
        ),
      );

      const restored = requireRestored(await reconcile(harness));

      expect(restored.run.status.error?.step).toBe("stop-work");
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    }));

  it("fails boot visibly for an unreadable run file", () =>
    withTestHarness(async (harness) => {
      await writeFile(
        join(harness.config.dataDir, SERVER_MOVE_RUN_FILE_NAME),
        "{not json",
      );

      await expect(reconcile(harness)).rejects.toThrow();
    }));
});
