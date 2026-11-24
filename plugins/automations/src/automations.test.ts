import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { PluginCliRegistration } from "@omnyo/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  createAutomation,
  createManualRun,
  decodeAutomationRow,
  getAutomation,
  getRunningAutomationRun,
  listAutomationsForProject,
  listDueAutomations,
  listAutomationRuns,
  migrations,
  parseAutomationExecution,
  setAutomationEnabled,
  setAutomationRunThread,
  setAutomationRunTurnRequest,
  AUTOMATION_RETRY_BASE_MS,
  type AutomationEnvValues,
  type Db,
} from "./data.js";
import { AutomationEnvStore } from "./env-secrets.js";
import { ingestLegacyImport } from "./legacy-import.js";
import {
  computeInitialNextRunAt,
  computeNextScheduledTime,
  validateOnceDefinition,
} from "./schedule-helpers.js";
import {
  omnyoBinaryCandidates,
  executeScriptFile,
  executeStoredScript,
  isWakeAgentSuppressed,
  mapScriptResultToRun,
  scriptPathEnv,
  withRuntimeNode,
} from "./script-runner.js";
import { executeScriptRun, reconcileRunningAutomationRuns } from "./run.js";
import { createScriptWorkingDirectoryResolver } from "./working-directory.js";
import { sweepDueAutomations } from "./sweep.js";
import { createAutomationService } from "./service.js";
import { registerAutomationCli } from "./cli.js";
import { automationScriptDir, scriptsRoot } from "./script-files.js";

const BASH_SCRIPT_RUNS_ARE_POSIX_ONLY =
  "script automations spawn `bash` by name, which Windows does not provide";

function pastedShellArg(value: string): string {
  return process.platform === "win32" ? `'${value}'` : value;
}

function createTestDb(): Db {
  const db = new Database(":memory:");

  for (const migration of migrations) db.exec(migration);

  return db;
}

const secretHost = createFakePluginHost({ pluginId: "automations" });

afterAll(() => secretHost.harness.dispose());

const noEnv: AutomationEnvValues = { values: () => undefined };

function testEnv(): AutomationEnvStore {
  return new AutomationEnvStore(secretHost.api.experimental_secrets);
}

function createScheduledAutomation(
  db: Db,
  nextRunAt: number,
  id = "auto_test",
) {
  return createAutomation(db, {
    id,
    projectId: "proj_test",
    name: "Test",
    enabled: true,
    trigger: {
      triggerType: "schedule",
      cron: "* * * * *",
      timezone: "UTC",
    },
    runMode: "agent",
    execution: {
      mode: "agent",
      prompt: "do it",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
    },
    origin: "human",
    createdByThreadId: null,
    nextRunAt,
  });
}

function createOnceAutomation(db: Db, nextRunAt: number, id = "auto_once") {
  return createAutomation(db, {
    id,
    projectId: "proj_test",
    name: "Once",
    enabled: true,
    trigger: {
      triggerType: "once",
      runAt: nextRunAt,
    },
    runMode: "agent",
    execution: {
      mode: "agent",
      prompt: "do it once",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
    },
    origin: "human",
    createdByThreadId: null,
    nextRunAt,
  });
}

function oneShotTrigger() {
  return { triggerType: "once" as const, runAt: Date.now() + 60_000 };
}

function legacyAutomationRow(
  overrides: {
    execution?: string;
    runMode?: "agent" | "script";
    targetThreadId?: string | null;
    triggerType?: "schedule" | "once";
  } = {},
) {
  return {
    id: "auto_legacy",
    projectId: "proj_test",
    targetThreadId: null,
    name: "Legacy",
    enabled: true,
    triggerType: "schedule" as const,
    triggerConfig: JSON.stringify({
      triggerType: "schedule",
      cron: "* * * * *",
      timezone: "UTC",
    }),
    runMode: "agent" as const,
    execution: JSON.stringify({
      mode: "agent",
      prompt: "legacy",
      providerId: "codex",
      model: "gpt-5",
      permissionMode: "readonly",
    }),
    environment: JSON.stringify({ type: "project-default" }),
    autoArchive: false,
    origin: "human" as const,
    createdByThreadId: null,
    nextRunAt: 1000,
    lastRunAt: null,
    runCount: 1,
    lastRunStatus: "succeeded" as const,
    lastRunThreadId: "thr_legacy",
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const unusedThreadRecovery = {
  events: {
    list: async () => [],
    wait: async () => null,
  },
  retry: async () => {
    throw new Error("not expected");
  },
};

const unusedInbox = {
  waits: async () => {
    throw new Error("not expected");
  },
  cancelWait: async () => {
    throw new Error("not expected");
  },
  registerWait: async () => {
    throw new Error("not expected");
  },
};

function createAutomationServiceOmnyo() {
  return {
    sdk: {
      system: {
        config: async (): Promise<{ primaryHostId: string | null }> => ({
          primaryHostId: "host_server",
        }),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => {
          const personal = projectId === "proj_personal";
          const remoteOnly = projectId === "proj_remote";

          const sources = personal
            ? []
            : [
                {
                  id: `psrc_${projectId}`,
                  projectId,
                  type: "local_path" as const,
                  hostId: remoteOnly ? "host_remote" : "host_server",
                  path: remoteOnly ? "/remote/project" : "/server/project",
                  isDefault: true,
                  createdAt: 1,
                  updatedAt: 1,
                },
              ];

          return {
            id: projectId,
            kind: personal ? ("personal" as const) : ("standard" as const),
            name: personal ? "Personal" : "Test Project",
            gitRemoteUrl: null,
            createdAt: 1,
            updatedAt: 1,
            sources,
          };
        },
        list: async () => [],
      },
      providers: {
        list: async () =>
          [
            {
              id: "codex",
              capabilities: {
                permissionModes: ["accept-edits", "auto", "full"],
              },
            },
          ] as never,
      },
      experimental_inbox: unusedInbox,
      threads: {
        ...unusedThreadRecovery,
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId }),
        send: async () => {
          throw new Error("not expected");
        },
        spawn: async () => {
          throw new Error("not expected");
        },
      },
    },
    server: { loopbackBaseUrl: "http://127.0.0.1:38886" },
    realtime: { publish: () => undefined },
    log: {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    },
  };
}

describe("data migrations", () => {
  it("upgrades private recovery history without reusing its recorded migration", async () => {
    const host = createFakePluginHost();
    const db = host.api.storage.database();

    try {
      host.api.storage.migrate(db, [
        ...migrations.slice(0, 3),
        "ALTER TABLE automation_runs ADD COLUMN recovery TEXT;",
      ]);

      const ledger = db
        .prepare("SELECT * FROM _plugin_migrations ORDER BY id")
        .all();

      expect(ledger[3]).toMatchObject({
        id: 3,
        statement_hash:
          "716f6ff98a3532b1ea87ea4c303817f36a285b8844ef7950dca4478afd18462a",
      });
      db.prepare(
        `INSERT INTO automations (
           id, project_id, name, trigger_type, trigger_config, run_mode,
           execution, origin, created_at, updated_at
         ) VALUES (
           'auto_legacy', 'proj_test', 'Legacy', 'once', '{}', 'agent', '{}',
           'human', 1, 1
         )`,
      ).run();
      db.prepare(
        `INSERT INTO automation_runs (
           id, automation_id, run_mode, status, trigger, scheduled_for,
           started_at, finished_at, output, recovery
         ) VALUES (
           'run_legacy', 'auto_legacy', 'agent', 'completed', 'schedule',
           1000, 1001, 1002, 'retained output', '{"status":"retained"}'
         )`,
      ).run();

      host.api.storage.migrate(db, migrations);

      const upgradedLedger = db
        .prepare("SELECT * FROM _plugin_migrations ORDER BY id")
        .all();

      expect(upgradedLedger).toHaveLength(migrations.length);
      expect(upgradedLedger.slice(0, 4)).toEqual(ledger);
      expect(upgradedLedger[4]).toMatchObject({
        id: 4,
        statement_hash:
          "24b5e5804e9dd11870b5fd60ff1c4d062da9b9ed570c6cd11d440962f067b0d0",
      });
      expect(
        db
          .prepare("SELECT * FROM automation_runs WHERE id = 'run_legacy'")
          .get(),
      ).toMatchObject({
        automation_id: "auto_legacy",
        status: "completed",
        scheduled_for: 1000,
        started_at: 1001,
        finished_at: 1002,
        output: "retained output",
        recovery: '{"status":"retained"}',
        turn_request_id: null,
      });

      setAutomationRunTurnRequest(db, {
        runId: "run_legacy",
        turnRequestId: "turn_new",
      });
      expect(
        listAutomationRuns(db, { automationId: "auto_legacy", limit: 10 }),
      ).toMatchObject([{ id: "run_legacy", turnRequestId: "turn_new" }]);
      expect(() => host.api.storage.migrate(db, migrations)).not.toThrow();
      expect(
        db.prepare("SELECT * FROM _plugin_migrations ORDER BY id").all(),
      ).toEqual(upgradedLedger);
    } finally {
      await host.harness.dispose();
    }
  });

  it("decodes stored script executions without a working-directory policy as automation-storage", () => {
    expect(
      parseAutomationExecution(
        {
          id: "auto_test",
          execution: JSON.stringify({
            mode: "script",
            scriptFile: "script.sh",
            timeoutMs: 120_000,
          }),
        },
        noEnv,
      ),
    ).toEqual({
      mode: "script",
      scriptFile: "script.sh",
      timeoutMs: 120_000,
      workingDirectory: { type: "automation-storage" },
    });
  });

  it("migrates stored agent automations to current permission modes", () => {
    const db = createTestDb();

    const insert = db.prepare(
      `INSERT INTO automations (
         id, project_id, name, enabled, trigger_type, trigger_config,
         run_mode, execution, origin, created_at, updated_at
       ) VALUES (?, 'proj_test', ?, 1, 'schedule', ?, 'agent', ?, 'human', 1, 1)`,
    );

    const trigger = JSON.stringify({
      triggerType: "schedule",
      cron: "* * * * *",
      timezone: "UTC",
    });

    for (const mode of ["workspace-write", "readonly"]) {
      insert.run(
        `auto_${mode}`,
        mode,
        trigger,
        JSON.stringify({
          mode: "agent",
          prompt: "legacy",
          providerId: "codex",
          model: "gpt-5",
          permissionMode: mode,
          environment: { type: "project-default" },
        }),
      );
    }

    db.exec(migrations[1] ?? "");

    const modes = db
      .prepare<[], { permissionMode: string }>(
        `SELECT json_extract(execution, '$.permissionMode') AS permissionMode
         FROM automations ORDER BY id`,
      )
      .all()
      .map((row) => row.permissionMode);

    expect(modes).toEqual(["accept-edits", "accept-edits"]);
  });

  it("settles older duplicate running rows so single-flight can be introduced on history", () => {
    const db = new Database(":memory:");
    db.exec(migrations[0] ?? "");
    db.prepare(
      `INSERT INTO automations (
         id, project_id, name, trigger_type, trigger_config, run_mode,
         execution, origin, created_at, updated_at
       ) VALUES (
         'auto_once', 'proj_test', 'Once', 'once', '{}', 'agent', '{}',
         'human', 1, 1
       )`,
    ).run();

    const insertRun = db.prepare(
      `INSERT INTO automation_runs (
         id, automation_id, run_mode, status, trigger, scheduled_for, started_at
       ) VALUES (?, 'auto_once', 'agent', 'running', 'manual', 1000, ?)`,
    );

    insertRun.run("run_first", 1000);
    insertRun.run("run_second", 1001);
    insertRun.run("run_third", 1001);

    db.transaction(() => {
      for (const migration of migrations.slice(1)) db.exec(migration);
    })();

    const rows = db
      .prepare(
        `SELECT id, status, skip_reason AS skipReason, finished_at AS finishedAt
           FROM automation_runs ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      status: string;
      skipReason: string | null;
      finishedAt: number | null;
    }>;

    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ["run_first", "skipped"],
      ["run_second", "skipped"],
      ["run_third", "running"],
    ]);
    expect(rows[0]!.skipReason).toMatch(/single-flight/);
    expect(rows[0]!.finishedAt).not.toBeNull();
    expect(() => insertRun.run("run_fourth", 2000)).toThrow(/UNIQUE/);
  });
});

describe("startup reconciliation", () => {
  function reconcileOmnyo(threads: {
    get: (args: { threadId: string }) => Promise<unknown>;
  }) {
    const published: unknown[] = [];

    return {
      api: {
        sdk: {
          experimental_inbox: unusedInbox,
          threads: {
            ...unusedThreadRecovery,
            get: threads.get,
            send: async () => {
              throw new Error("not expected");
            },
            spawn: async () => {
              throw new Error("not expected");
            },
          },
        },
        realtime: {
          publish: (...args: unknown[]) => void published.push(args),
        },
        log: {
          debug: () => undefined,
          error: () => undefined,
          info: () => undefined,
          warn: () => undefined,
        },
      },
      published,
    };
  }

  function thread(
    threadId: string,
    status: "idle" | "pending" | "active" | "starting" | "stopping" | "error",
    extra: { deletedAt?: number | null; archivedAt?: number | null } = {},
  ) {
    return {
      id: threadId,
      status,
      deletedAt: extra.deletedAt ?? null,
      archivedAt: extra.archivedAt ?? null,
    };
  }

  it("settles ghost script runs and threadless agent runs as interrupted", async () => {
    const db = createTestDb();
    const script = createScheduledAutomation(db, 0, "auto_script");
    const agent = createScheduledAutomation(db, 0, "auto_agent");

    const scriptRun = createManualRun(db, {
      automationId: script.id,
      runMode: "script",
      now: 1000,
    }).run;

    const agentRun = createManualRun(db, {
      automationId: agent.id,
      runMode: "agent",
      now: 1000,
    }).run;

    const { api, published } = reconcileOmnyo({
      get: async () => {
        throw new Error("no thread should be asked about");
      },
    });

    await reconcileRunningAutomationRuns(api, db);

    for (const run of [scriptRun, agentRun]) {
      const settled = listAutomationRuns(db, {
        automationId: run.automationId,
        limit: 10,
      })[0]!;

      expect(settled.status).toBe("skipped");
      expect(settled.skipReason).toMatch(/interrupted/);
      expect(settled.finishedAt).not.toBeNull();
      expect(getRunningAutomationRun(db, run.automationId)).toBeNull();
    }

    expect(published.length).toBeGreaterThan(0);
  });

  it("settles agent runs by their thread's state and leaves live threads alone", async () => {
    const db = createTestDb();

    const cases = [
      {
        id: "auto_idle",
        thread: thread("thr_idle", "idle"),
        status: "succeeded",
      },
      {
        id: "auto_error",
        thread: thread("thr_error", "error"),
        status: "failed",
      },
      {
        id: "auto_active",
        thread: thread("thr_active", "active"),
        status: "running",
      },
      {
        id: "auto_starting",
        thread: thread("thr_starting", "starting"),
        status: "running",
      },
      {
        id: "auto_pending",
        thread: thread("thr_pending", "pending"),
        status: "running",
      },
      {
        id: "auto_archived",
        thread: thread("thr_archived", "idle", { archivedAt: 5 }),
        status: "skipped",
      },
      { id: "auto_gone", thread: null, status: "skipped" },
      { id: "auto_unreachable", thread: "boom", status: "running" },
    ] as const;

    const threads = new Map<string, unknown>();

    for (const testCase of cases) {
      const automation = createScheduledAutomation(db, 0, testCase.id);

      const run = createManualRun(db, {
        automationId: automation.id,
        runMode: "agent",
        now: 1000,
      }).run;

      const threadId = `thr_${testCase.id.slice("auto_".length)}`;
      setAutomationRunThread(db, { runId: run.id, threadId });
      threads.set(threadId, testCase.thread);
    }

    const { api } = reconcileOmnyo({
      get: async ({ threadId }) => {
        const value = threads.get(threadId);

        if (value === null) {
          throw Object.assign(new Error("not found"), { status: 404 });
        }

        if (value === "boom") throw new Error("connection refused");

        return value;
      },
    });

    await reconcileRunningAutomationRuns(api, db);

    for (const testCase of cases) {
      const run = listAutomationRuns(db, {
        automationId: testCase.id,
        limit: 10,
      })[0]!;

      expect([testCase.id, run.status]).toEqual([testCase.id, testCase.status]);
    }

    expect(
      listAutomationRuns(db, { automationId: "auto_idle", limit: 1 })[0]!
        .skipReason,
    ).toBe(
      "interrupted: the server restarted before the agent run was observed to finish",
    );
    expect(getAutomation(db, "auto_error")!.consecutiveFailures).toBe(1);
    expect(getAutomation(db, "auto_gone")!.consecutiveFailures).toBe(0);
  });

  it("does not pause for a turn that failed while the plugin was not running", async () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 0, "auto_restarted");
    db.prepare(
      "UPDATE automations SET consecutive_failures = 2 WHERE id = ?",
    ).run(automation.id);

    const run = createManualRun(db, {
      automationId: automation.id,
      runMode: "agent",
      now: 1000,
    }).run;

    setAutomationRunThread(db, { runId: run.id, threadId: "thr_restarted" });

    const { api } = reconcileOmnyo({
      get: async () => thread("thr_restarted", "error"),
    });

    await reconcileRunningAutomationRuns(api, db);

    expect(
      listAutomationRuns(db, { automationId: automation.id, limit: 1 })[0]!
        .status,
    ).toBe("failed");
    expect(getAutomation(db, automation.id)).toMatchObject({
      consecutiveFailures: 3,
      enabled: true,
    });
  });
});

describe("schedule helpers", () => {
  it.each([
    [
      "0 9 * * *",
      "America/Chicago",
      "2027-03-13T16:00:00Z",
      "2027-03-14T14:00:00.000Z",
    ],
    [
      "0 3 * * *",
      "America/Chicago",
      "2027-03-13T16:00:00Z",
      "2027-03-14T08:00:00.000Z",
    ],
    [
      "0 1 * * *",
      "America/Chicago",
      "2027-03-13T16:00:00Z",
      "2027-03-14T07:00:00.000Z",
    ],
    [
      "0 9 * * *",
      "America/New_York",
      "2027-03-13T16:00:00Z",
      "2027-03-14T13:00:00.000Z",
    ],
    [
      "0 9 * * *",
      "Europe/London",
      "2027-03-27T16:00:00Z",
      "2027-03-28T08:00:00.000Z",
    ],
    [
      "0 9 * * 0",
      "America/Chicago",
      "2027-03-13T16:00:00Z",
      "2027-03-14T14:00:00.000Z",
    ],
  ])(
    "keeps the spring-forward run for %s in %s",
    (cron, timezone, now, expected) => {
      const next = computeNextScheduledTime({
        cron,
        timezone,
        now: Date.parse(now),
      });

      expect(new Date(next).toISOString()).toBe(expected);
    },
  );

  it("validates and computes once triggers", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(() => validateOnceDefinition({ runAt: now, now })).toThrow(
      "One-shot run time must be in the future",
    );
    expect(
      computeInitialNextRunAt({
        trigger: { triggerType: "once", runAt: now + 1_000 },
        enabled: true,
        now,
      }),
    ).toBe(now + 1_000);
    expect(
      computeInitialNextRunAt({
        trigger: { triggerType: "once", runAt: now + 1_000 },
        enabled: false,
        now,
      }),
    ).toBeNull();
  });
});

describe("automation data access", () => {
  it("CAS claims a scheduled run only once", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);

    const first = claimAutomationScheduledRun(db, {
      automationId: "auto_test",
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });

    const second = claimAutomationScheduledRun(db, {
      automationId: "auto_test",
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });

    expect(first.advanced).toBe(true);
    expect(second.advanced).toBe(false);
    expect(
      listAutomationRuns(db, { automationId: "auto_test", limit: 10 }),
    ).toHaveLength(1);
  });

  it("settles a running automation exactly once", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);

    const claim = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 1000 + 3_600_000,
      now: 1000,
    });

    if (!claim.advanced) throw new Error("claim failed");

    const first = closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "first failure",
      now: 1001,
    });

    const duplicate = closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "duplicate failure",
      now: 1002,
    });

    expect(first?.run.status).toBe("failed");
    expect(duplicate).toBeNull();
    expect(getAutomation(db, automation.id)?.consecutiveFailures).toBe(1);
    expect(getAutomation(db, automation.id)?.nextRunAt).toBe(
      1001 + AUTOMATION_RETRY_BASE_MS,
    );
    expect(first?.run.error).toBe("first failure");
  });

  it("does not re-enable a manually paused automation after failure", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);

    const claim = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });

    if (!claim.advanced) throw new Error("claim failed");
    setAutomationEnabled(db, {
      projectId: automation.projectId,
      automationId: automation.id,
      enabled: false,
      nextRunAt: null,
    });

    closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "failed after pause",
      now: 1001,
    });

    expect(getAutomation(db, automation.id)?.enabled).toBe(false);
    expect(getAutomation(db, automation.id)?.nextRunAt).toBeNull();
  });

  it("auto-pauses after three consecutive scheduled failures", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    let expectedNextRunAt = 1000;

    for (let failure = 1; failure <= 3; failure += 1) {
      const advancedNextRunAt = expectedNextRunAt + 3_600_000;

      const claim = claimAutomationScheduledRun(db, {
        automationId: automation.id,
        expectedNextRunAt,
        newNextRunAt: advancedNextRunAt,
        now: expectedNextRunAt,
      });

      if (!claim.advanced) throw new Error(`claim ${failure} failed`);
      const failedAt = expectedNextRunAt + 1;
      closeAutomationRun(db, {
        runId: claim.run.id,
        status: "failed",
        error: `dispatch failed ${failure}`,
        now: failedAt,
      });
      const current = getAutomation(db, automation.id);
      expect(current?.consecutiveFailures).toBe(failure);

      if (failure < 3) {
        expectedNextRunAt =
          failedAt + AUTOMATION_RETRY_BASE_MS * 2 ** (failure - 1);
        expect(current?.enabled).toBe(true);
        expect(current?.nextRunAt).toBe(expectedNextRunAt);
      } else {
        expect(current?.enabled).toBe(false);
        expect(current?.nextRunAt).toBeNull();
        expect(current?.lastError).toContain(
          "paused after 3 consecutive failures",
        );
      }
    }
  });

  it("keeps retrying transient failures with backoff instead of pausing", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    let expectedNextRunAt = 1000;

    for (let failure = 1; failure <= 4; failure += 1) {
      const claim = claimAutomationScheduledRun(db, {
        automationId: automation.id,
        expectedNextRunAt,
        newNextRunAt: expectedNextRunAt + 3_600_000,
        now: expectedNextRunAt,
      });

      if (!claim.advanced) throw new Error(`claim ${failure} failed`);
      const failedAt = expectedNextRunAt + 1;
      closeAutomationRun(db, {
        runId: claim.run.id,
        status: "failed",
        error: `stream disconnected ${failure}`,
        transientFailure: true,
        now: failedAt,
      });
      const current = getAutomation(db, automation.id);
      expectedNextRunAt =
        failedAt + AUTOMATION_RETRY_BASE_MS * 2 ** (failure - 1);
      expect(current?.consecutiveFailures).toBe(failure);
      expect(current?.enabled).toBe(true);
      expect(current?.nextRunAt).toBe(expectedNextRunAt);
      expect(current?.lastError).toBe(`stream disconnected ${failure}`);
    }
  });

  it("never schedules a quick retry after the next scheduled run", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    const nextSlot = 1000 + AUTOMATION_RETRY_BASE_MS / 2;

    const claim = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: nextSlot,
      now: 1000,
    });

    if (!claim.advanced) throw new Error("claim failed");

    closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "dispatch failed",
      now: 1001,
    });

    expect(getAutomation(db, automation.id)?.nextRunAt).toBe(nextSlot);
  });

  it("enforces one running execution per automation", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);

    const first = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });

    if (!first.advanced) throw new Error("first claim failed");

    const overlapping = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 2000,
      newNextRunAt: 3000,
      now: 2000,
    });

    const manual = createManualRun(db, {
      automationId: automation.id,
      runMode: "agent",
      now: 2000,
    });

    expect(overlapping.advanced).toBe(false);
    expect(manual.deduped).toBe(true);
    expect(manual.run.id).toBe(first.run.id);
    expect(getRunningAutomationRun(db, automation.id)?.id).toBe(first.run.id);
  });

  it("skips scheduled script runs while the script host is offline instead of pausing", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-offline-"));

    const execution = {
      mode: "script" as const,
      scriptFile: "script.sh",
      interpreter: "bash" as const,
      timeoutMs: 10_000,
      workingDirectory: { type: "path" as const, path: pluginDataDir },
    };

    const automation = createAutomation(db, {
      id: "auto_offline",
      projectId: "proj_test",
      name: "Release tick",
      enabled: true,
      trigger: { triggerType: "schedule", cron: "* * * * *", timezone: "UTC" },
      runMode: "script",
      execution,
      origin: "human",
      createdByThreadId: null,
      nextRunAt: 1000,
    });

    const offline = Object.assign(new Error("Host is not connected"), {
      body: { code: "host_unavailable", message: "Host is not connected" },
    });

    const api = {
      sdk: { projects: { get: async () => null } },
      server: { loopbackBaseUrl: "http://127.0.0.1:38886" },
      realtime: { publish: () => undefined },
      log: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
    };

    try {
      let expectedNextRunAt = 1000;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claim = claimAutomationScheduledRun(db, {
          automationId: automation.id,
          expectedNextRunAt,
          newNextRunAt: expectedNextRunAt + 60_000,
          now: expectedNextRunAt,
        });

        if (!claim.advanced) throw new Error(`claim ${attempt} failed`);
        expectedNextRunAt += 60_000;

        await executeScriptRun(api, db, {
          pluginDataDir,
          automation,
          run: claim.run,
          execution,
          onFailure: (error) => {
            closeAutomationRun(db, {
              runId: claim.run.id,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              now: Date.now(),
            });
          },
          resolveWorkingDirectory: async () => pluginDataDir,
          scriptHostRouting: {
            hostId: () => "host_release",
            execute: async () => {
              throw offline;
            },
          },
        });
      }

      const current = getAutomation(db, automation.id);

      expect(current?.enabled).toBe(true);
      expect(current?.consecutiveFailures).toBe(0);
      expect(current?.nextRunAt).toBe(expectedNextRunAt);
      expect(
        listAutomationRuns(db, { automationId: automation.id, limit: 3 }).map(
          (run) => [run.status, run.skipReason],
        ),
      ).toEqual(
        Array.from({ length: 3 }, () => [
          "skipped",
          "script host offline: Host is not connected",
        ]),
      );
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("resets consecutive failures after a successful run", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);

    const first = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });

    if (!first.advanced) throw new Error("first claim failed");
    closeAutomationRun(db, {
      runId: first.run.id,
      status: "failed",
      error: "dispatch failed",
      now: 1001,
    });
    const retryAt = getAutomation(db, automation.id)?.nextRunAt;

    if (retryAt === null || retryAt === undefined) {
      throw new Error("retry was not scheduled");
    }

    const retry = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: retryAt,
      newNextRunAt: retryAt + 60_000,
      now: retryAt,
    });

    if (!retry.advanced) throw new Error("retry claim failed");
    closeAutomationRun(db, {
      runId: retry.run.id,
      status: "succeeded",
      now: retryAt + 1,
    });

    expect(getAutomation(db, automation.id)?.consecutiveFailures).toBe(0);
  });

  it("resets consecutive failures when a scheduled tick is skipped", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);

    const failed = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });

    if (!failed.advanced) throw new Error("claim failed");
    closeAutomationRun(db, {
      runId: failed.run.id,
      status: "failed",
      error: "transient failure",
      now: 1001,
    });
    const retryAt = getAutomation(db, automation.id)?.nextRunAt;

    if (retryAt === null || retryAt === undefined) {
      throw new Error("retry was not scheduled");
    }

    const skipped = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: retryAt,
      newNextRunAt: retryAt + 60_000,
      skipReason: "nothing to do",
      now: retryAt,
    });

    expect(skipped.advanced).toBe(true);
    expect(skipped.advanced && skipped.run.status).toBe("skipped");
    expect(getAutomation(db, automation.id)?.consecutiveFailures).toBe(0);
    expect(getAutomation(db, automation.id)?.lastError).toBeNull();
  });

  it("does not re-arm one-shot automations after dispatch failure", () => {
    const db = createTestDb();
    const automation = createOnceAutomation(db, 1000);

    const claim = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: null,
      now: 1000,
    });

    if (!claim.advanced) throw new Error("claim failed");
    closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "dispatch failed",
      now: 1001,
    });
    const restored = getAutomation(db, automation.id);
    expect(restored?.enabled).toBe(false);
    expect(restored?.nextRunAt).toBeNull();
    expect(restored?.runCount).toBe(1);
    expect(restored?.consecutiveFailures).toBe(1);
    expect(restored?.lastRunStatus).toBe("failed");
  });

  it.each([1000, 2000])(
    "leaves undispatched agent automations unchanged when next due at %s",
    async (nextRunAt) => {
      const db = createTestDb();
      const automation = createScheduledAutomation(db, nextRunAt);

      const api = {
        sdk: {
          hosts: {
            list: vi.fn(async () => {
              return [
                {
                  id: "host_test",
                  name: "host",
                  status: "disconnected",
                  lastSeenAt: null,
                  createdAt: 1,
                  updatedAt: 1,
                },
              ];
            }),
          },
          projects: {
            get: async () => {
              throw new Error("not expected");
            },
          },
          system: {
            config: async () => {
              throw new Error("not expected");
            },
          },
          experimental_inbox: unusedInbox,
          threads: {
            ...unusedThreadRecovery,
            get: async () => {
              throw new Error("not expected");
            },
            send: async () => {
              throw new Error("not expected");
            },
            spawn: async () => {
              throw new Error("not expected");
            },
          },
        },
        server: { loopbackBaseUrl: "http://127.0.0.1:38886" },
        realtime: { publish: () => undefined },
        log: {
          debug: () => undefined,
          error: () => undefined,
          info: () => undefined,
          warn: () => undefined,
        },
      };

      await sweepDueAutomations(api, db, {
        pluginDataDir: "/tmp",
        env: noEnv,
        serverHostId: "host_server",
        now: 1000,
      });

      expect(api.sdk.hosts.list).toHaveBeenCalledTimes(
        nextRunAt > 1000 ? 0 : 1,
      );
      expect(getAutomation(db, automation.id)?.runCount).toBe(0);
      expect(
        listAutomationRuns(db, { automationId: automation.id, limit: 10 }),
      ).toHaveLength(0);
    },
  );

  it("does not repeatedly select degraded agent executions for sweeping", () => {
    const db = createTestDb();
    const emptyPrompt = createScheduledAutomation(db, 1000, "auto_empty");
    const invalidJson = createScheduledAutomation(db, 1000, "auto_invalid");
    const healthy = createScheduledAutomation(db, 1000, "auto_healthy");
    db.prepare("UPDATE automations SET execution = ? WHERE id = ?").run(
      JSON.stringify({
        mode: "agent",
        prompt: "",
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "accept-edits",
        environment: { type: "project-default" },
      }),
      emptyPrompt.id,
    );
    db.prepare("UPDATE automations SET execution = ? WHERE id = ?").run(
      "not json",
      invalidJson.id,
    );

    expect(
      listDueAutomations(db, noEnv, { now: 1000, limit: 100 }).map(
        (automation) => automation.id,
      ),
    ).toEqual([healthy.id]);
    expect(getAutomation(db, emptyPrompt.id)).toMatchObject({
      enabled: true,
      nextRunAt: 1000,
    });
    expect(getAutomation(db, invalidJson.id)).toMatchObject({
      enabled: true,
      nextRunAt: 1000,
    });
  });

  it("finds healthy due work after a full batch of malformed rows", () => {
    const db = createTestDb();

    const updateExecution = db.prepare(
      "UPDATE automations SET execution = ?, created_at = 1 WHERE id = ?",
    );

    for (let index = 0; index < 100; index += 1) {
      const id = `auto_invalid_${index.toString().padStart(3, "0")}`;
      createScheduledAutomation(db, 1000, id);
      updateExecution.run(
        JSON.stringify({ mode: "agent", prompt: "incomplete" }),
        id,
      );
    }

    const healthy = createScheduledAutomation(db, 1000, "auto_healthy");
    db.prepare("UPDATE automations SET created_at = 2 WHERE id = ?").run(
      healthy.id,
    );

    expect(
      listDueAutomations(db, noEnv, { now: 1000, limit: 100 }).map(
        (automation) => automation.id,
      ),
    ).toEqual([healthy.id]);
  });

  it("rejects denormalized fields that disagree with stored JSON", () => {
    const mismatches = [
      "UPDATE automations SET trigger_type = 'once' WHERE id = ?",
      "UPDATE automations SET run_mode = 'script' WHERE id = ?",
      "UPDATE automations SET target_thread_id = 'thr_other' WHERE id = ?",
    ];

    for (const mismatch of mismatches) {
      const db = createTestDb();
      const automation = createScheduledAutomation(db, 1000);
      db.prepare(mismatch).run(automation.id);
      const row = getAutomation(db, automation.id);
      expect(row).not.toBeNull();

      if (row === null) throw new Error("Expected stored automation");

      expect(decodeAutomationRow(row, noEnv).automation).toEqual({
        id: automation.id,
        projectId: automation.projectId,
        name: automation.name,
        problem: "invalid-stored-data",
      });
    }
  });

  it("dedupes manual runs by idempotency key", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);

    const first = createManualRun(db, {
      automationId: "auto_test",
      runMode: "agent",
      idempotencyKey: "same",
      now: 2000,
    });

    const second = createManualRun(db, {
      automationId: "auto_test",
      runMode: "agent",
      idempotencyKey: "same",
      now: 3000,
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it("records skipped script close state", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);

    const run = createManualRun(db, {
      automationId: "auto_test",
      runMode: "script",
      now: 1000,
    }).run;

    closeAutomationRun(db, {
      runId: run.id,
      status: "skipped",
      skipReason: "empty output",
      exitCode: 0,
      now: 1001,
    });

    const [closed] = listAutomationRuns(db, {
      automationId: "auto_test",
      limit: 1,
    });

    expect(closed?.status).toBe("skipped");
    expect(closed?.skipReason).toBe("empty output");
  });
});

describe("automation service", () => {
  it("chooses runnable defaults for new scripts and preserves the automation-storage directory on replacement", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-service-"));

    const service = createAutomationService({
      api: createAutomationServiceOmnyo(),
      db,
      env: testEnv(),
      pluginDataDir,
    });

    try {
      const created = await service.create({
        projectId: "proj_test",
        name: "New project script",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: {
          mode: "script",
          script: "pwd\n",
          timeoutMs: 120_000,
        },
        origin: "human",
      });

      expect(created.execution).toMatchObject({
        workingDirectory: { type: "project" },
      });

      const personal = await service.create({
        projectId: "proj_personal",
        name: "Personal script",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: {
          mode: "script",
          script: "pwd\n",
          timeoutMs: 120_000,
        },
        origin: "human",
      });

      expect(personal.execution).toMatchObject({
        workingDirectory: { type: "automation-storage" },
      });

      const remoteOnly = await service.create({
        projectId: "proj_remote",
        name: "Remote-only project script",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: {
          mode: "script",
          script: "pwd\n",
          timeoutMs: 120_000,
        },
        origin: "human",
      });

      expect(remoteOnly.execution).toMatchObject({
        workingDirectory: { type: "automation-storage" },
      });
      await expect(
        service.update({
          projectId: "proj_remote",
          automationId: remoteOnly.id,
          script: { workingDirectory: { type: "project" } },
        }),
      ).resolves.toMatchObject({
        execution: { resolvedWorkingDirectory: null },
      });
      await expect(
        service.get({
          projectId: "proj_remote",
          automationId: remoteOnly.id,
        }),
      ).resolves.toMatchObject({
        execution: { resolvedWorkingDirectory: null },
      });

      const legacyId = "auto_existing_legacy";
      const legacyScriptDir = automationScriptDir(pluginDataDir, legacyId);
      await mkdir(legacyScriptDir, { recursive: true });
      await writeFile(join(legacyScriptDir, "old.sh"), "pwd\n");
      db.prepare(
        `INSERT INTO automations (
           id, project_id, name, enabled, trigger_type, trigger_config,
           run_mode, execution, origin, next_run_at, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'once', ?, 'script', ?, 'human', ?, ?, ?)`,
      ).run(
        legacyId,
        "proj_test",
        "Existing legacy script",
        JSON.stringify(oneShotTrigger()),
        JSON.stringify({
          mode: "script",
          scriptFile: "old.sh",
          timeoutMs: 120_000,
        }),
        Date.now() + 60_000,
        Date.now(),
        Date.now(),
      );

      const replaced = await service.update({
        projectId: "proj_test",
        automationId: legacyId,
        execution: {
          mode: "script",
          script: "pwd -P\n",
          timeoutMs: 120_000,
        },
      });

      expect(replaced.execution).toMatchObject({
        workingDirectory: { type: "automation-storage" },
      });
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("reads the server host identity after a co-located daemon initializes", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-service-"));
    const api = createAutomationServiceOmnyo();
    let serverHostId: string | null = null;
    api.sdk.system.config = async () => ({ primaryHostId: serverHostId });

    const service = createAutomationService({
      api,
      db,
      env: testEnv(),
      pluginDataDir,
    });

    serverHostId = "host_server";

    try {
      const created = await service.create({
        projectId: "proj_test",
        name: "Post-startup script",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: {
          mode: "script",
          script: "pwd\n",
          timeoutMs: 120_000,
        },
        origin: "human",
      });

      expect(created.execution).toMatchObject({
        workingDirectory: { type: "project" },
      });
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("updates only a script working-directory policy", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-service-"));

    const service = createAutomationService({
      api: createAutomationServiceOmnyo(),
      db,
      env: testEnv(),
      pluginDataDir,
    });

    try {
      const created = await service.create({
        projectId: "proj_test",
        name: "Selected directory",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: {
          mode: "script",
          script: "pwd\n",
          timeoutMs: 120_000,
        },
        origin: "human",
      });

      const updated = await service.update({
        projectId: "proj_test",
        automationId: created.id,
        script: {
          workingDirectory: { type: "path", path: pluginDataDir },
        },
      });

      expect(updated.execution).toMatchObject({
        mode: "script",
        workingDirectory: { type: "path", path: pluginDataDir },
        resolvedWorkingDirectory: pluginDataDir,
      });
      await expect(
        service.get({
          projectId: "proj_test",
          automationId: created.id,
        }),
      ).resolves.toMatchObject({
        execution: { resolvedWorkingDirectory: pluginDataDir },
      });
      await service.update({
        projectId: "proj_test",
        automationId: created.id,
        script: { workingDirectory: { type: "automation-storage" } },
      });
      await expect(
        service.get({
          projectId: "proj_test",
          automationId: created.id,
        }),
      ).resolves.toMatchObject({
        execution: {
          resolvedWorkingDirectory: scriptsRoot(pluginDataDir),
        },
      });
      await expect(
        service.update({
          projectId: "proj_test",
          automationId: created.id,
          script: {
            workingDirectory: { type: "path", path: "relative/path" },
          },
        }),
      ).rejects.toThrow("absolute path on the Omnyo server host");
      await expect(
        service.update({
          projectId: "proj_test",
          automationId: created.id,
          script: {
            workingDirectory: {
              type: "path",
              path: "/tmp/\u001b[31mred\u0007",
            },
          },
        }),
      ).rejects.toThrow("must not contain control characters");
      await expect(
        service.create({
          projectId: "proj_test",
          name: "Control characters",
          enabled: true,
          trigger: oneShotTrigger(),
          execution: {
            mode: "script",
            script: "pwd\n",
            timeoutMs: 120_000,
            workingDirectory: {
              type: "path",
              path: "/tmp/\u001b[31mred\u0007",
            },
          },
          origin: "human",
        }),
      ).rejects.toThrow("must not contain control characters");
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("validates project availability before creating an automation", async () => {
    const db = createTestDb();

    const api = {
      sdk: {
        system: { config: async () => ({ primaryHostId: null }) },
        projects: {
          get: async () => {
            throw new Error("Project not found");
          },
          list: async () => [],
        },
        providers: {
          list: async () => [],
        },
        threadSections: {
          list: async () => [],
        },
        experimental_inbox: unusedInbox,
        threads: {
          ...unusedThreadRecovery,
          get: async () => {
            throw new Error("not expected");
          },
          send: async () => {
            throw new Error("not expected");
          },
          spawn: async () => {
            throw new Error("not expected");
          },
        },
      },
      server: { loopbackBaseUrl: "http://127.0.0.1:38886" },
      realtime: { publish: () => undefined },
      log: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
    };

    const service = createAutomationService({
      api,
      db,
      env: testEnv(),
      pluginDataDir: "/tmp",
    });

    await expect(
      service.create({
        projectId: "proj_missing",
        name: "Missing project",
        enabled: true,
        trigger: { triggerType: "once", runAt: Date.now() + 60_000 },
        execution: {
          mode: "agent",
          prompt: "hello",
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "accept-edits",
          environment: { type: "project-default" },
        },
        origin: "human",
      }),
    ).rejects.toThrow("Project proj_missing is not available");
    expect(listAutomationsForProject(db, "proj_missing")).toHaveLength(0);
  });

  it("removes a stored script directory after switching to agent execution", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-service-"));

    const automation = createAutomation(db, {
      id: "auto_script_to_agent",
      projectId: "proj_test",
      name: "Script to agent",
      enabled: true,
      trigger: oneShotTrigger(),
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "old.sh",
        timeoutMs: 120_000,
        workingDirectory: { type: "automation-storage" },
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: Date.now() + 60_000,
    });

    const scriptDir = automationScriptDir(pluginDataDir, automation.id);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "old.sh"), "echo old\n");

    const service = createAutomationService({
      api: createAutomationServiceOmnyo(),
      db,
      env: testEnv(),
      pluginDataDir,
    });

    try {
      await service.update({
        projectId: "proj_test",
        automationId: automation.id,
        execution: {
          mode: "agent",
          prompt: "do it",
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "accept-edits",
          environment: { type: "project-default" },
        },
      });

      await expect(access(scriptDir)).rejects.toThrow();
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("removes only a superseded stored script file after a filename change", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-service-"));

    const automation = createAutomation(db, {
      id: "auto_script_rename",
      projectId: "proj_test",
      name: "Script rename",
      enabled: true,
      trigger: oneShotTrigger(),
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "old.sh",
        timeoutMs: 120_000,
        workingDirectory: { type: "automation-storage" },
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: Date.now() + 60_000,
    });

    const scriptDir = automationScriptDir(pluginDataDir, automation.id);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "old.sh"), "echo old\n");
    await writeFile(join(scriptDir, "keep.txt"), "keep\n");

    const service = createAutomationService({
      api: createAutomationServiceOmnyo(),
      db,
      env: testEnv(),
      pluginDataDir,
    });

    try {
      await service.update({
        projectId: "proj_test",
        automationId: automation.id,
        execution: {
          mode: "script",
          script: "echo new\n",
          scriptFile: "new.sh",
          timeoutMs: 120_000,
        },
      });

      await expect(access(join(scriptDir, "old.sh"))).rejects.toThrow();
      await expect(readFile(join(scriptDir, "new.sh"), "utf8")).resolves.toBe(
        "echo new\n",
      );
      await expect(readFile(join(scriptDir, "keep.txt"), "utf8")).resolves.toBe(
        "keep\n",
      );
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("removes a newly staged filename when the database update fails", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-service-"));

    const automation = createAutomation(db, {
      id: "auto_script_rollback",
      projectId: "proj_test",
      name: "Script rollback",
      enabled: true,
      trigger: oneShotTrigger(),
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "old.sh",
        timeoutMs: 120_000,
        workingDirectory: { type: "automation-storage" },
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: Date.now() + 60_000,
    });

    const scriptDir = automationScriptDir(pluginDataDir, automation.id);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "old.sh"), "echo old\n");
    db.exec(`CREATE TRIGGER reject_automation_update
      BEFORE UPDATE ON automations
      BEGIN
        SELECT RAISE(ABORT, 'update rejected');
      END`);

    const service = createAutomationService({
      api: createAutomationServiceOmnyo(),
      db,
      env: testEnv(),
      pluginDataDir,
    });

    try {
      await expect(
        service.update({
          projectId: "proj_test",
          automationId: automation.id,
          execution: {
            mode: "script",
            script: "echo new\n",
            scriptFile: "new.sh",
            timeoutMs: 120_000,
          },
        }),
      ).rejects.toThrow("update rejected");
      await expect(readFile(join(scriptDir, "old.sh"), "utf8")).resolves.toBe(
        "echo old\n",
      );
      await expect(access(join(scriptDir, "new.sh"))).rejects.toThrow();
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite the active filename when the database update fails", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-service-"));

    const automation = createAutomation(db, {
      id: "auto_script_same_name_rollback",
      projectId: "proj_test",
      name: "Script same-name rollback",
      enabled: true,
      trigger: oneShotTrigger(),
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "old.sh",
        timeoutMs: 120_000,
        workingDirectory: { type: "automation-storage" },
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: Date.now() + 60_000,
    });

    const scriptDir = automationScriptDir(pluginDataDir, automation.id);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "old.sh"), "echo old\n");
    db.exec(`CREATE TRIGGER reject_automation_update
      BEFORE UPDATE ON automations
      BEGIN
        SELECT RAISE(ABORT, 'update rejected');
      END`);

    const service = createAutomationService({
      api: createAutomationServiceOmnyo(),
      db,
      env: testEnv(),
      pluginDataDir,
    });

    try {
      await expect(
        service.update({
          projectId: "proj_test",
          automationId: automation.id,
          execution: {
            mode: "script",
            script: "echo replacement\n",
            scriptFile: "old.sh",
            timeoutMs: 120_000,
          },
        }),
      ).rejects.toThrow("update rejected");
      await expect(readFile(join(scriptDir, "old.sh"), "utf8")).resolves.toBe(
        "echo old\n",
      );
      await expect(readdir(scriptDir)).resolves.toEqual(["old.sh"]);
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });
});

describe("automation CLI --script-file", () => {
  type FileReadCall = { hostId: string | undefined; path: string };

  async function setup() {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-1649-data-"));
    const srcDir = await mkdtemp(join(tmpdir(), "omnyo-1649-src-"));
    const reads: FileReadCall[] = [];
    const serviceOmnyo = createAutomationServiceOmnyo();

    const service = createAutomationService({
      api: serviceOmnyo,
      db,
      env: testEnv(),
      pluginDataDir,
    });

    const sdk = {
      ...serviceOmnyo.sdk,
      hosts: {
        list: async () => [
          { id: "host_server", name: "server" },
          { id: "host_laptop", name: "Laptop" },
        ],
      },
      threads: {
        ...serviceOmnyo.sdk.threads,
        get: async ({ threadId }: { threadId: string }) =>
          threadId === "thr_env"
            ? { id: threadId, environment: { hostId: "host_laptop" } }
            : { id: threadId, environment: null },
      },
      files: {
        read: async ({ hostId, path }: { hostId?: string; path: string }) => {
          reads.push({ hostId, path });
          const content = await readFile(path, "utf8");

          return {
            path,
            content,
            contentEncoding: "utf8" as const,
            sizeBytes: Buffer.byteLength(content),
            sha256: "",
          };
        },
      },
    };

    let cli: PluginCliRegistration | undefined;
    registerAutomationCli({
      api: {
        sdk: sdk as never,
        cli: {
          register: (registration) => {
            cli = registration;
          },
        },
      },
      service,
    });

    if (!cli) throw new Error("automation CLI was not registered");

    return {
      cli,
      db,
      pluginDataDir,
      srcDir,
      reads,
      async cleanup() {
        await rm(pluginDataDir, { recursive: true, force: true });
        await rm(srcDir, { recursive: true, force: true });
      },
    };
  }

  function idFrom(stdout: string | undefined): string {
    const id = /Automation created: (\S+)/.exec(stdout ?? "")?.[1];

    if (!id) throw new Error(`no id in: ${stdout}`);

    return id;
  }

  it("preserves a tier named none and clears it with a separate flag", async () => {
    const t = await setup();

    try {
      const created = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "tier-test",
          "--in",
          "30m",
          "--prompt",
          "Check the build",
          "--provider",
          "codex",
          "--model",
          "test-model",
          "--permission-mode",
          "auto",
          "--target-thread",
          "thr_env",
          "--service-tier",
          "none",
          "--json",
        ],
        {},
      );

      expect(created.exitCode).toBe(0);
      const automation = JSON.parse(created.stdout ?? "");
      expect(automation.execution.serviceTier).toBe("none");

      const conflict = await t.cli.run(
        [
          "update",
          automation.id,
          "--project",
          "proj_test",
          "--service-tier",
          "none",
          "--clear-service-tier",
        ],
        {},
      );

      expect(conflict.exitCode).not.toBe(0);
      expect(conflict.stderr).toContain(
        "Cannot combine --service-tier and --clear-service-tier",
      );

      const cleared = await t.cli.run(
        [
          "update",
          automation.id,
          "--project",
          "proj_test",
          "--clear-service-tier",
          "--json",
        ],
        {},
      );

      expect(cleared.exitCode).toBe(0);
      expect(
        JSON.parse(cleared.stdout ?? "").execution.serviceTier,
      ).toBeUndefined();

      const updated = await t.cli.run(
        [
          "update",
          automation.id,
          "--project",
          "proj_test",
          "--service-tier",
          "none",
          "--json",
        ],
        {},
      );

      expect(updated.exitCode).toBe(0);
      expect(JSON.parse(updated.stdout ?? "").execution.serviceTier).toBe(
        "none",
      );
    } finally {
      await t.cleanup();
    }
  });

  it("resolves the source against ctx.cwd and reports the stored snapshot copy", async () => {
    const t = await setup();
    const sourcePath = join(t.srcDir, "hello.sh");
    await writeFile(sourcePath, '#!/bin/sh\necho "VERSION 1"\n');

    try {
      const created = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "issue-1649",
          "--in",
          "30m",
          "--script-file",
          "./hello.sh",
        ],
        { cwd: t.srcDir },
      );

      expect(created.exitCode).toBe(0);
      const automationId = idFrom(created.stdout);
      expect(t.reads).toEqual([{ hostId: undefined, path: sourcePath }]);

      const storedPath = join(
        automationScriptDir(t.pluginDataDir, automationId),
        "hello.sh",
      );

      expect(created.stdout).toContain(`Script:    ${storedPath}`);
      expect(created.stdout).toContain(`Copied ${sourcePath}`);
      expect(created.stdout).toContain(`to ${storedPath}`);
      expect(created.stdout).toContain(
        `omnyo automation update ${automationId} --project proj_test --script-file ${pastedShellArg(sourcePath)}\n`,
      );
      expect(created.stdout).toContain("Working dir: /server/project");

      const shown = await t.cli.run(
        ["show", automationId, "--project", "proj_test"],
        {},
      );

      expect(shown.stdout).toContain(`Script:    ${storedPath}`);
      expect(shown.stdout).toContain("Working dir: /server/project");

      const shownJson = await t.cli.run(
        ["show", automationId, "--project", "proj_test", "--json"],
        {},
      );

      expect(JSON.parse(shownJson.stdout ?? "").execution).toEqual({
        mode: "script",
        script: '#!/bin/sh\necho "VERSION 1"\n',
        interpreter: "bash",
        workingDirectory: { type: "project" },
        resolvedWorkingDirectory: "/server/project",
        timeoutMs: 120_000,
        storedScriptPath: storedPath,
      });

      const policyUpdated = await t.cli.run(
        [
          "update",
          automationId,
          "--project",
          "proj_test",
          "--working-directory",
          "automation-storage",
          "--json",
        ],
        {},
      );

      expect(JSON.parse(policyUpdated.stdout ?? "").execution).toMatchObject({
        workingDirectory: { type: "automation-storage" },
      });

      const listed = await t.cli.run(
        ["list", "--project", "proj_test", "--json"],
        {},
      );

      expect(
        JSON.parse(listed.stdout ?? "")[0].execution.storedScriptPath,
      ).toBe(storedPath);

      const paused = await t.cli.run(
        ["pause", automationId, "--project", "proj_test", "--json"],
        {},
      );

      expect(JSON.parse(paused.stdout ?? "").execution.storedScriptPath).toBe(
        storedPath,
      );

      await writeFile(sourcePath, '#!/bin/sh\necho "VERSION 2"\n');
      await expect(readFile(storedPath, "utf8")).resolves.toContain(
        "VERSION 1",
      );

      const updated = await t.cli.run(
        [
          "update",
          automationId,
          "--project",
          "proj_test",
          "--script-file",
          "hello.sh",
        ],
        { cwd: t.srcDir },
      );

      expect(updated.exitCode).toBe(0);
      expect(updated.stdout).toContain(`Copied ${sourcePath}`);

      const updatedJson = await t.cli.run(
        ["show", automationId, "--project", "proj_test", "--json"],
        {},
      );

      const refreshedPath: unknown = JSON.parse(updatedJson.stdout ?? "")
        .execution.storedScriptPath;

      expect(
        JSON.parse(updatedJson.stdout ?? "").execution.workingDirectory,
      ).toEqual({ type: "automation-storage" });

      if (typeof refreshedPath !== "string") {
        throw new Error("missing storedScriptPath after update");
      }

      expect(
        refreshedPath.startsWith(
          automationScriptDir(t.pluginDataDir, automationId),
        ),
      ).toBe(true);
      expect(updated.stdout).toContain(`to ${refreshedPath}`);
      await expect(readFile(refreshedPath, "utf8")).resolves.toContain(
        "VERSION 2",
      );
    } finally {
      await t.cleanup();
    }
  });

  it("reads the file on the thread's environment host or the --host override", async () => {
    const t = await setup();
    const sourcePath = join(t.srcDir, "hello.sh");
    await writeFile(sourcePath, "echo hi\n");

    try {
      const inThread = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "thread-host",
          "--in",
          "30m",
          "--script-file",
          sourcePath,
        ],
        { cwd: "/nonexistent", threadId: "thr_env" },
      );

      expect(inThread.exitCode).toBe(0);
      expect(t.reads.at(-1)).toEqual({
        hostId: "host_laptop",
        path: sourcePath,
      });
      expect(inThread.stdout).toContain(
        `Copied ${sourcePath} (host host_laptop)`,
      );
      expect(inThread.stdout).toContain(
        `--script-file ${pastedShellArg(sourcePath)} --host host_laptop\n`,
      );

      const byName = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "named-host",
          "--in",
          "30m",
          "--script-file",
          sourcePath,
          "--host",
          "laptop",
        ],
        {},
      );

      expect(byName.exitCode).toBe(0);
      expect(t.reads.at(-1)).toEqual({
        hostId: "host_laptop",
        path: sourcePath,
      });

      const noEnv = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "no-env",
          "--in",
          "30m",
          "--script-file",
          sourcePath,
        ],
        { threadId: "thr_bare" },
      );

      expect(noEnv.exitCode).toBe(1);
      expect(noEnv.stderr).toContain("pass --host <name-or-id>");

      const hostOnly = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "host-only",
          "--in",
          "30m",
          "--script",
          "echo hi",
          "--host",
          "laptop",
        ],
        {},
      );

      expect(hostOnly.exitCode).toBe(1);
      expect(hostOnly.stderr).toContain("--host requires --script-file");
    } finally {
      await t.cleanup();
    }
  });

  it("accepts one-hour owned script builds without changing existing timeout values", async () => {
    const t = await setup();
    const sourcePath = join(t.srcDir, "candidate.mjs");
    await writeFile(sourcePath, "process.stdout.write('candidate fixture');\n");

    try {
      const create = async (name: string, timeout: string) =>
        t.cli.run(
          [
            "create",
            "--project",
            "proj_test",
            "--name",
            name,
            "--in",
            "30m",
            "--script-file",
            sourcePath,
            "--timeout",
            timeout,
          ],
          {},
        );

      const existing = await create("existing script", "900000");
      expect(existing.exitCode).toBe(0);
      const unchangedId = idFrom(existing.stdout);
      const candidate = await create("candidate build", "1h");
      expect(candidate.exitCode).toBe(0);

      const shown = await t.cli.run(
        ["show", idFrom(candidate.stdout), "--project", "proj_test", "--json"],
        {},
      );

      expect(JSON.parse(shown.stdout ?? "").execution.timeoutMs).toBe(3600000);

      const unchanged = await t.cli.run(
        ["show", unchangedId, "--project", "proj_test", "--json"],
        {},
      );

      expect(JSON.parse(unchanged.stdout ?? "").execution.timeoutMs).toBe(
        900000,
      );
      expect((await create("over budget", "3600001")).exitCode).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it("prints a refresh command that quotes the path and keeps script settings", async () => {
    const t = await setup();
    const sourcePath = join(t.srcDir, "my check $(id).sh");
    await writeFile(sourcePath, "echo one\n");

    try {
      const created = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "quoted",
          "--in",
          "30m",
          "--script-file",
          sourcePath,
          "--interpreter",
          "sh",
          "--timeout",
          "5000",
          "--env-json",
          '{"CHANNEL":"qa"}',
          "--working-directory",
          "automation-storage",
        ],
        {},
      );

      expect(created.exitCode).toBe(0);
      const automationId = idFrom(created.stdout);
      expect(created.stdout).toContain(
        `omnyo automation update ${automationId} --project proj_test --script-file '${sourcePath}'\n`,
      );

      await writeFile(sourcePath, "echo two\n");

      const refreshed = await t.cli.run(
        [
          "update",
          automationId,
          "--project",
          "proj_test",
          "--script-file",
          sourcePath,
          "--json",
        ],
        {},
      );

      expect(refreshed.exitCode).toBe(0);
      const { execution } = JSON.parse(refreshed.stdout ?? "");
      expect(execution).toMatchObject({
        interpreter: "sh",
        timeoutMs: 5000,
        env: { CHANNEL: "qa" },
        workingDirectory: { type: "automation-storage" },
      });
      await expect(readFile(execution.storedScriptPath, "utf8")).resolves.toBe(
        "echo two\n",
      );
    } finally {
      await t.cleanup();
    }
  });

  it("rejects an empty working-directory value on create and replacement", async () => {
    const t = await setup();

    try {
      const emptyCreate = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "empty-cwd",
          "--in",
          "30m",
          "--script",
          "echo hi",
          "--working-directory",
          "",
        ],
        {},
      );

      expect(emptyCreate.exitCode).toBe(1);
      expect(emptyCreate.stderr).toContain(
        "Missing required option --working-directory <value>.",
      );

      const created = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "valid",
          "--in",
          "30m",
          "--script",
          "echo hi",
        ],
        {},
      );

      const emptyReplacement = await t.cli.run(
        [
          "update",
          idFrom(created.stdout),
          "--project",
          "proj_test",
          "--script",
          "echo next",
          "--working-directory",
          "",
        ],
        {},
      );

      expect(emptyReplacement.exitCode).toBe(1);
      expect(emptyReplacement.stderr).toContain(
        "Missing required option --working-directory <value>.",
      );
    } finally {
      await t.cleanup();
    }
  });
});

describe("omnyo CLI injection for script runs", () => {
  it("prefers the env pointers over PATH and macOS install locations", () => {
    expect(
      omnyoBinaryCandidates({
        OMNYO_CLI: "/daemon/bundle/omnyo",
        OMNYO_CLI_DIR: "/other/dir",
      })[0],
    ).toBe("/daemon/bundle/omnyo");
    expect(omnyoBinaryCandidates({ OMNYO_CLI_DIR: "/daemon/bundle" })[0]).toBe(
      join("/daemon/bundle", "omnyo"),
    );
  });

  it("expands PATH itself so every candidate is absolute", () => {
    expect(
      omnyoBinaryCandidates({
        PATH: ["/usr/bin", "/opt/tools"].join(delimiter),
      }),
    ).toEqual([
      join("/usr/bin", "omnyo"),
      join("/opt/tools", "omnyo"),
      "/opt/homebrew/bin/omnyo",
      "/usr/local/bin/omnyo",
    ]);
    expect(
      omnyoBinaryCandidates({ PATH: "/usr/bin" }).every((c) => isAbsolute(c)),
    ).toBe(true);
  });

  it("drops entries that would resolve against the wrong directory", () => {
    expect(
      omnyoBinaryCandidates({ PATH: ["/usr/bin", "", "/bin"].join(delimiter) }),
    ).toEqual([
      join("/usr/bin", "omnyo"),
      join("/bin", "omnyo"),
      "/opt/homebrew/bin/omnyo",
      "/usr/local/bin/omnyo",
    ]);
    expect(
      omnyoBinaryCandidates({ OMNYO_CLI: "  ", OMNYO_CLI_DIR: "", PATH: "" }),
    ).toEqual(["/opt/homebrew/bin/omnyo", "/usr/local/bin/omnyo"]);
    expect(
      omnyoBinaryCandidates({
        OMNYO_CLI: "./omnyo",
        OMNYO_CLI_DIR: "rel/dir",
        PATH: "",
      }),
    ).toEqual(["/opt/homebrew/bin/omnyo", "/usr/local/bin/omnyo"]);
  });

  it("prepends omnyo's directory to PATH only when it is absolute", () => {
    expect(scriptPathEnv("/daemon/bundle/omnyo", "/usr/bin:/bin")).toBe(
      `${dirname("/daemon/bundle/omnyo")}${delimiter}/usr/bin:/bin`,
    );
    expect(scriptPathEnv("omnyo", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
    expect(scriptPathEnv(null, "/usr/bin:/bin")).toBe("/usr/bin:/bin");
    expect(scriptPathEnv("/daemon/bundle/omnyo", undefined)).toBe(
      "/daemon/bundle",
    );
  });

  it("passes no inherited OMNYO_ variable to the script", async ({ skip }) => {
    skip(process.platform === "win32", BASH_SCRIPT_RUNS_ARE_POSIX_ONLY);

    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-env-"));
    const scriptDir = automationScriptDir(pluginDataDir, "auto_env");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(
      join(scriptDir, "script.sh"),
      'printf "%s|%s|%s\\n" "${OMNYO_HOST_DAEMON_PORT-unset}" "${OMNYO_SERVER_URL-unset}" "${OMNYO_CLI-unset}"\n',
    );

    try {
      const result = await executeScriptFile({
        automationId: "auto_env",
        runId: "run_env",
        projectId: "proj_test",
        scriptPath: join(scriptDir, "script.sh"),
        interpreter: "bash",
        timeoutMs: 10_000,
        serverUrl: "http://127.0.0.1:38886",
        workingDir: scriptsRoot(pluginDataDir),
        inheritedEnv: {
          PATH: "/usr/bin:/bin",
          OMNYO_HOST_DAEMON_PORT: "38887",
          OMNYO_CLI: "/missing/omnyo",
        },
      });

      expect(result.exitCode).toBe(0);

      const [daemonPort, serverUrl, omnyoCli] = (
        result.output.trim().split("\n").at(-1) ?? ""
      ).split("|");

      expect({ daemonPort, serverUrl }).toEqual({
        daemonPort: "unset",
        serverUrl: "http://127.0.0.1:38886",
      });
      expect(omnyoCli).not.toBe("/missing/omnyo");
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("appends the daemon's own Node directory so node scripts start under a bare service PATH", () => {
    expect(withRuntimeNode("/usr/bin:/bin", "/opt/node/bin")).toBe(
      "/usr/bin:/bin:/opt/node/bin",
    );
    expect(withRuntimeNode("/opt/node/bin:/usr/bin", "/opt/node/bin")).toBe(
      "/opt/node/bin:/usr/bin",
    );
    expect(withRuntimeNode("", "/opt/node/bin")).toBe("/opt/node/bin");
  });
});

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }

  if (process.platform !== "linux") return true;

  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    const state = stat.slice(closingParen + 2, closingParen + 3);

    return state !== "Z" && state !== "X";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
}

describe("script process containment", () => {
  it.skipIf(process.platform === "win32").each([0, 7])(
    "terminates an unreferenced worker after the script exits with code %i",
    async (exitCode) => {
      const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-worker-"));

      const scriptDir = automationScriptDir(pluginDataDir, "auto_worker");
      let workerPid: number | undefined;

      try {
        await mkdir(scriptDir, { recursive: true });
        await writeFile(
          join(scriptDir, "worker.mjs"),
          [
            'import { spawn } from "node:child_process";',
            'const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
            "worker.unref();",
            "console.log(JSON.stringify({ worker: worker.pid }));",
            `process.exit(${exitCode});`,
          ].join("\n"),
        );

        const result = await executeStoredScript({
          pluginDataDir,
          automationId: "auto_worker",
          runId: "run_worker",
          projectId: "proj_test",
          scriptFile: "worker.mjs",
          interpreter: "node",
          timeoutMs: 30_000,
          serverUrl: "http://127.0.0.1:1",
          workingDir: scriptsRoot(pluginDataDir),
        });

        const workerMatch = result.output.match(/"worker":(\d+)/u);
        expect(workerMatch).not.toBeNull();

        const parsedWorkerPid = Number(workerMatch?.[1]);
        workerPid = parsedWorkerPid;
        expect(Number.isSafeInteger(parsedWorkerPid)).toBe(true);
        expect(result.exitCode).toBe(exitCode);
        expect(result.timedOut).toBe(false);
        await expect
          .poll(() => isProcessRunning(parsedWorkerPid), { timeout: 2_000 })
          .toBe(false);
      } finally {
        if (workerPid !== undefined && Number.isSafeInteger(workerPid)) {
          try {
            process.kill(workerPid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }

        await rm(pluginDataDir, { recursive: true, force: true });
      }
    },
  );

  it("terminates descendant processes when a script times out", async ({
    skip,
  }) => {
    skip(process.platform === "win32", BASH_SCRIPT_RUNS_ARE_POSIX_ONLY);

    const pluginDataDir = await mkdtemp(
      join(tmpdir(), "omnyo-auto-process-group-"),
    );

    const scriptDir = automationScriptDir(pluginDataDir, "auto_timeout");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(
      join(scriptDir, "script.sh"),
      "sleep 30 &\nchild_pid=$!\nprintf 'child_pid=%s\\n' \"$child_pid\"\nwait $child_pid\n",
    );

    try {
      const result = await executeStoredScript({
        pluginDataDir,
        automationId: "auto_timeout",
        runId: "run_timeout",
        projectId: "proj_test",
        scriptFile: "script.sh",
        interpreter: "bash",
        timeoutMs: 1_000,
        serverUrl: "http://127.0.0.1:38886",
        workingDir: scriptsRoot(pluginDataDir),
      });

      const childPidMatch = result.output.match(/^child_pid=(\d+)$/mu);
      const childPid = Number.parseInt(childPidMatch?.[1] ?? "", 10);
      expect(result.timedOut).toBe(true);
      expect(Number.isSafeInteger(childPid)).toBe(true);

      let childRunning = true;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        childRunning = await isProcessRunning(childPid);

        if (!childRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(childRunning).toBe(false);
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });
});

describe("script interpreter resolution", () => {
  it("starts a node script when the daemon's service PATH has no node", async ({
    skip,
  }) => {
    skip(process.platform === "win32", BASH_SCRIPT_RUNS_ARE_POSIX_ONLY);

    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-node-path-"));
    const scriptDir = automationScriptDir(pluginDataDir, "auto_node");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(
      join(scriptDir, "script.mjs"),
      "console.log('node ran');\n",
    );

    try {
      const result = await executeScriptFile({
        automationId: "auto_node",
        runId: "run_node",
        projectId: "proj_test",
        scriptPath: join(scriptDir, "script.mjs"),
        interpreter: "node",
        timeoutMs: 10_000,
        serverUrl: "http://127.0.0.1:38886",
        workingDir: scriptsRoot(pluginDataDir),
        inheritedEnv: { PATH: "/usr/bin:/bin" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("node ran");
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });
});

describe("script project context", () => {
  function withoutMissingOmnyoCliWarning(
    output: string | null | undefined,
  ): string | null | undefined {
    return output?.replace(
      /^\[omnyo\] warning: could not locate the omnyo CLI, so `omnyo` is not on PATH for this script\.\n/u,
      "",
    );
  }

  function projectSource(args: {
    hostId: string;
    path: string;
    isDefault: boolean;
  }) {
    return {
      id: `psrc_${args.hostId}`,
      projectId: "proj_test",
      type: "local_path" as const,
      hostId: args.hostId,
      path: args.path,
      isDefault: args.isDefault,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  async function realpathOrNull(value: string | null): Promise<string | null> {
    if (value === null) return null;

    try {
      return await realpath(value);
    } catch {
      return value;
    }
  }

  async function runScriptAutomation(args: {
    script: string;
    sources: ReturnType<typeof projectSource>[];
    serverHostId?: string | null;
    workingDirectory:
      | { type: "automation-storage" }
      | { type: "project" }
      | { type: "path"; path: string };
  }) {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-context-"));
    const scriptDir = automationScriptDir(pluginDataDir, "auto_context");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "script.sh"), args.script);

    const execution = {
      mode: "script" as const,
      scriptFile: "script.sh",
      interpreter: "bash" as const,
      timeoutMs: 10_000,
      workingDirectory: args.workingDirectory,
    };

    const automation = createAutomation(db, {
      id: "auto_context",
      projectId: "proj_test",
      name: "Project context",
      enabled: true,
      trigger: { triggerType: "once", runAt: 2_000 },
      runMode: "script",
      execution,
      origin: "human",
      createdByThreadId: null,
      nextRunAt: 2_000,
    });

    const { run } = createManualRun(db, {
      automationId: automation.id,
      runMode: "script",
      now: 2_000,
    });

    const warnings: string[] = [];

    const api = {
      sdk: {
        projects: {
          get: async () => ({
            id: "proj_test",
            kind: "standard" as const,
            name: "Test Project",
            gitRemoteUrl: null,
            createdAt: 1,
            updatedAt: 1,
            sources: args.sources,
          }),
        },
      },
      server: { loopbackBaseUrl: "http://127.0.0.1:38886" },
      realtime: { publish: () => undefined },
      log: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: (message: string) => void warnings.push(message),
      },
    };

    try {
      await executeScriptRun(api, db, {
        pluginDataDir,
        automation,
        run,
        execution,
        onFailure: (error) => {
          closeAutomationRun(db, {
            runId: run.id,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            now: Date.now(),
          });
        },
        resolveWorkingDirectory: createScriptWorkingDirectoryResolver({
          sdk: api.sdk,
          pluginDataDir,
          serverHostId:
            args.serverHostId === undefined ? "host_server" : args.serverHostId,
        }),
      });

      const [closed] = listAutomationRuns(db, {
        automationId: automation.id,
        limit: 1,
      });

      const service = createAutomationService({
        api: {
          ...api,
          sdk: {
            ...api.sdk,
            system: {
              config: async () => ({
                primaryHostId:
                  args.serverHostId === undefined
                    ? "host_server"
                    : args.serverHostId,
              }),
            },
            projects: { ...api.sdk.projects, list: async () => [] },
            providers: { list: async () => [] as never },
          },
        } as never,
        db,
        env: testEnv(),
        pluginDataDir,
      });

      const shown = await service.get({
        projectId: automation.projectId,
        automationId: automation.id,
      });

      return {
        closed,
        warnings,
        scriptsDir: await realpath(scriptsRoot(pluginDataDir)),
        displayedWorkingDirectory: await realpathOrNull(
          "execution" in shown && shown.execution.mode === "script"
            ? (shown.execution.resolvedWorkingDirectory ?? null)
            : null,
        ),
      };
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  }

  it("runs in the actual server-host source instead of a remote primary source", async ({
    skip,
  }) => {
    skip(process.platform === "win32", BASH_SCRIPT_RUNS_ARE_POSIX_ONLY);
    const serverProjectDir = await mkdtemp(join(tmpdir(), "omnyo-server-"));
    const remoteProjectDir = await mkdtemp(join(tmpdir(), "omnyo-remote-"));
    await mkdir(join(serverProjectDir, "bin"));
    await writeFile(
      join(serverProjectDir, "bin", "build-views.txt"),
      "project-relative file found\n",
    );

    try {
      const result = await runScriptAutomation({
        script: "pwd -P\ncat bin/build-views.txt\n",
        workingDirectory: { type: "project" },
        sources: [
          projectSource({
            hostId: "host_primary",
            path: remoteProjectDir,
            isDefault: true,
          }),
          projectSource({
            hostId: "host_server",
            path: serverProjectDir,
            isDefault: false,
          }),
        ],
      });

      expect(result.closed).toMatchObject({
        status: "succeeded",
        exitCode: 0,
      });
      expect(withoutMissingOmnyoCliWarning(result.closed?.output)).toBe(
        `${await realpath(serverProjectDir)}\nproject-relative file found\n`,
      );
    } finally {
      await rm(serverProjectDir, { recursive: true, force: true });
      await rm(remoteProjectDir, { recursive: true, force: true });
    }
  });

  it("reports a resolved directory equal to the process working directory", async ({
    skip,
  }) => {
    skip(process.platform === "win32", BASH_SCRIPT_RUNS_ARE_POSIX_ONLY);
    const serverProjectDir = await mkdtemp(join(tmpdir(), "omnyo-server-"));
    const explicitDir = await mkdtemp(join(tmpdir(), "omnyo-auto-explicit-"));

    const sources = [
      projectSource({
        hostId: "host_server",
        path: serverProjectDir,
        isDefault: true,
      }),
    ];

    try {
      for (const workingDirectory of [
        { type: "automation-storage" } as const,
        { type: "project" } as const,
        { type: "path", path: explicitDir } as const,
      ]) {
        const result = await runScriptAutomation({
          script: "pwd -P\n",
          workingDirectory,
          sources,
        });

        expect(result.displayedWorkingDirectory).not.toBeNull();
        expect(withoutMissingOmnyoCliWarning(result.closed?.output)).toBe(
          `${result.displayedWorkingDirectory}\n`,
        );
      }
    } finally {
      await rm(serverProjectDir, { recursive: true, force: true });
      await rm(explicitDir, { recursive: true, force: true });
    }
  });

  it("fails project policy instead of using another host's source", async () => {
    const remoteProjectDir = await mkdtemp(join(tmpdir(), "omnyo-remote-"));

    try {
      const result = await runScriptAutomation({
        script: "pwd -P\n",
        workingDirectory: { type: "project" },
        sources: [
          projectSource({
            hostId: "host_remote",
            path: remoteProjectDir,
            isDefault: true,
          }),
        ],
      });

      expect(result.closed).toMatchObject({
        status: "failed",
        error: "Project proj_test has no source on the Omnyo server host",
      });
    } finally {
      await rm(remoteProjectDir, { recursive: true, force: true });
    }
  });

  it("fails project policy when the server has no co-located host", async () => {
    const result = await runScriptAutomation({
      script: "pwd -P\n",
      workingDirectory: { type: "project" },
      serverHostId: null,
      sources: [],
    });

    expect(result.closed).toMatchObject({
      status: "failed",
      error: "Project proj_test has no source on the Omnyo server host",
    });
  });

  it("reuses one project lookup within a dispatch context", async () => {
    const get = vi.fn(async () => ({
      id: "proj_test",
      sources: [
        projectSource({
          hostId: "host_server",
          path: "/server/project",
          isDefault: true,
        }),
      ],
    }));

    const resolveWorkingDirectory = createScriptWorkingDirectoryResolver({
      sdk: { projects: { get } },
      pluginDataDir: "/plugin-data",
      serverHostId: "host_server",
    });

    await expect(
      Promise.all([
        resolveWorkingDirectory("proj_test", { type: "project" }),
        resolveWorkingDirectory("proj_test", { type: "project" }),
      ]),
    ).resolves.toEqual(["/server/project", "/server/project"]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fails when the project source is not a directory", async () => {
    const result = await runScriptAutomation({
      script: "pwd -P\n",
      workingDirectory: { type: "project" },
      sources: [
        projectSource({
          hostId: "host_server",
          path: join(tmpdir(), "omnyo-auto-missing-project-source"),
          isDefault: true,
        }),
      ],
    });

    expect(result.closed).toMatchObject({
      status: "failed",
      error: expect.stringContaining("is not an existing directory"),
    });
  });

  it("includes the first stderr line in a failed run summary", async ({
    skip,
  }) => {
    skip(process.platform === "win32", BASH_SCRIPT_RUNS_ARE_POSIX_ONLY);

    const result = await runScriptAutomation({
      script:
        "printf 'stdout kept\\n'\nprintf '\\n  missing project file  \\nlater detail\\n' >&2\nexit 2\n",
      workingDirectory: { type: "automation-storage" },
      sources: [],
    });

    expect(result.closed).toMatchObject({
      status: "failed",
      exitCode: 2,
      error: "Script exited with code 2: missing project file",
    });
    expect(withoutMissingOmnyoCliWarning(result.closed?.output)).toBe(
      "stdout kept\n\n  missing project file  \nlater detail\n",
    );
  });
});

describe("script wake gate", () => {
  it("suppresses only a trailing wakeAgent false object", () => {
    expect(isWakeAgentSuppressed('hello\n{"wakeAgent": false}\n')).toBe(true);
    expect(isWakeAgentSuppressed('{"wakeAgent": true}\n')).toBe(false);
    expect(isWakeAgentSuppressed("not json\n")).toBe(false);
  });

  it("maps silent successful scripts to skipped runs", () => {
    expect(
      mapScriptResultToRun({
        exitCode: 0,
        output: "",
        stderr: "",
        timedOut: false,
      }),
    ).toMatchObject({ status: "skipped", skipReason: "empty output" });
    expect(
      mapScriptResultToRun({
        exitCode: 0,
        output: 'nothing\n{"wakeAgent": false}',
        stderr: "",
        timedOut: false,
      }),
    ).toMatchObject({ status: "skipped", skipReason: "wakeAgent false" });
    expect(
      mapScriptResultToRun({
        exitCode: 2,
        output: "bad",
        stderr: "",
        timedOut: false,
      }),
    ).toMatchObject({ status: "failed", error: "Script exited with code 2" });
  });

  it("caps stderr failure details", () => {
    const stderr = `${"x".repeat(400)}\nsecond line\n`;
    const result = { exitCode: 1, output: stderr, stderr, timedOut: false };
    expect(mapScriptResultToRun(result).error).toBe(
      `Script exited with code 1: ${"x".repeat(199)}…`,
    );
  });

  it("skips blank and carriage-return lines before the first stderr detail", () => {
    const stderr = "\r\n   \r\n\r\nreal failure\r\nlater line\r\n";
    const result = { exitCode: 1, output: stderr, stderr, timedOut: false };
    expect(mapScriptResultToRun(result).error).toBe(
      "Script exited with code 1: real failure",
    );
  });

  it("omits the detail when stderr holds only line breaks", () => {
    const stderr = "\n".repeat(200_000);
    const result = { exitCode: 1, output: "", stderr, timedOut: false };
    expect(mapScriptResultToRun(result).error).toBe(
      "Script exited with code 1",
    );
  });

  it("finds a trailing stderr detail after a large run of blank lines", () => {
    const stderr = `${"\n".repeat(200_000)}last gasp`;
    const result = { exitCode: 1, output: "", stderr, timedOut: false };
    expect(mapScriptResultToRun(result).error).toBe(
      "Script exited with code 1: last gasp",
    );
  });

  it("removes terminal control sequences from stderr failure details", () => {
    const stderr = "\u001b]52;c;SGVsbG8=\u0007\u001b[31mdanger\u001b[0m\n";
    const result = { exitCode: 1, output: stderr, stderr, timedOut: false };
    expect(mapScriptResultToRun(result).error).toBe(
      "Script exited with code 1: danger",
    );
    expect(result.output).toBe(stderr);
  });
});

describe("legacy import", () => {
  it("ingests legacy rows, moves environment into agent execution, and imports scripts once", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-plugin-"));
    await mkdir(join(pluginDataDir, "import"), { recursive: true });
    await writeFile(
      join(pluginDataDir, "import", "legacy-automations.json"),
      JSON.stringify({
        automations: [legacyAutomationRow()],
        runs: [
          {
            id: "arun_legacy",
            automationId: "auto_legacy",
            runMode: "agent",
            threadId: "thr_legacy",
            status: "succeeded",
            trigger: "schedule",
            skipReason: null,
            error: null,
            output: null,
            exitCode: null,
            idempotencyKey: null,
            scheduledFor: 1000,
            startedAt: 1000,
            finishedAt: 1001,
          },
        ],
        scripts: {
          auto_legacy: { fileName: "script.sh", content: "echo ok\n" },
        },
      }),
    );
    const kv = new Map<string, unknown>();

    const api = {
      storage: {
        kv: {
          get: async <T>(key: string) => kv.get(key) as T | undefined,
          set: async (key: string, value: unknown) => {
            kv.set(key, value);
          },
        },
      },
      log: { info: () => undefined },
    };

    await ingestLegacyImport({ api, db, pluginDataDir });
    await ingestLegacyImport({ api, db, pluginDataDir });

    const imported = getAutomation(db, "auto_legacy");
    expect(imported).not.toBeNull();
    expect(JSON.parse(imported?.execution ?? "{}")).toMatchObject({
      mode: "agent",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
    });
    expect(
      listAutomationRuns(db, { automationId: "auto_legacy", limit: 10 }),
    ).toHaveLength(1);
    expect(kv.get("legacy-import-done")).toBe(true);
  });

  it("rejects legacy rows with inconsistent execution metadata", async () => {
    const cases = [
      {
        name: "run mode",
        row: legacyAutomationRow({ runMode: "script" }),
      },
      {
        name: "target thread",
        row: legacyAutomationRow({
          targetThreadId: "thr_row",
          execution: JSON.stringify({
            mode: "agent",
            prompt: "legacy",
            providerId: "codex",
            model: "gpt-5",
            permissionMode: "readonly",
            targetThreadId: "thr_execution",
          }),
        }),
      },
    ];

    for (const testCase of cases) {
      const db = createTestDb();
      const pluginDataDir = await mkdtemp(join(tmpdir(), "omnyo-auto-plugin-"));

      try {
        await mkdir(join(pluginDataDir, "import"), { recursive: true });
        await writeFile(
          join(pluginDataDir, "import", "legacy-automations.json"),
          JSON.stringify({
            automations: [testCase.row],
            runs: [],
            scripts: {},
          }),
        );
        const kv = new Map<string, unknown>();

        const api = {
          storage: {
            kv: {
              get: async <T>(key: string) => kv.get(key) as T | undefined,
              set: async (key: string, value: unknown) => {
                kv.set(key, value);
              },
            },
          },
          log: { info: () => undefined },
        };

        await expect(
          ingestLegacyImport({ api, db, pluginDataDir }),
          testCase.name,
        ).rejects.toThrow(/does not match/u);
      } finally {
        await rm(pluginDataDir, { recursive: true, force: true });
      }
    }
  });
});
