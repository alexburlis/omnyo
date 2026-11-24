import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  createAutomation,
  createManualRun,
  migrations,
  type Db,
} from "./data.js";
import {
  createFailureNoticeSender,
  failureNoticeMessage,
  FAILURE_NOTICE_MAX_AGE_MS,
  FAILURE_NOTICE_RETRY_DELAY_MS,
} from "./failure-notices.js";

function createTestDb(): Db {
  const db = new Database(":memory:");

  for (const migration of migrations) db.exec(migration);

  return db;
}

function createScheduledAutomation(db: Db, nextRunAt: number) {
  return createAutomation(db, {
    id: "auto_notice",
    projectId: "proj_test",
    name: "Paraspeech > SEO > Weekly Release Readiness",
    enabled: true,
    trigger: { triggerType: "schedule", cron: "* * * * *", timezone: "UTC" },
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

function failScheduledRun(
  db: Db,
  args: { expectedNextRunAt: number; error: string; transient?: boolean },
) {
  const claim = claimAutomationScheduledRun(db, {
    automationId: "auto_notice",
    expectedNextRunAt: args.expectedNextRunAt,
    newNextRunAt: args.expectedNextRunAt + 3_600_000,
    now: args.expectedNextRunAt,
  });

  if (!claim.advanced) throw new Error("claim failed");
  closeAutomationRun(db, {
    runId: claim.run.id,
    status: "failed",
    error: args.error,
    transientFailure: args.transient,
    now: args.expectedNextRunAt + 1,
  });

  return claim.run.id;
}

function notices(db: Db) {
  return db
    .prepare(
      `SELECT id, failure_notice AS kind FROM automation_runs
        WHERE failure_notice IS NOT NULL ORDER BY started_at`,
    )
    .all();
}

function nextRunAt(db: Db): number {
  const row = db
    .prepare(`SELECT next_run_at AS nextRunAt FROM automations WHERE id = ?`)
    .get("auto_notice") as { nextRunAt: number };

  return row.nextRunAt;
}

function fakeApi(callRpc: ReturnType<typeof vi.fn>) {
  return {
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    sdk: { plugins: { callRpc } },
  } as unknown as Parameters<typeof createFailureNoticeSender>[0];
}

describe("automation failure notices", () => {
  it("marks the first failure of a streak and the auto-pause, not the retries between", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);

    const first = failScheduledRun(db, {
      expectedNextRunAt: 1000,
      error: "first",
    });

    const second = failScheduledRun(db, {
      expectedNextRunAt: nextRunAt(db),
      error: "second",
    });

    const third = failScheduledRun(db, {
      expectedNextRunAt: nextRunAt(db),
      error: "third",
    });

    expect(notices(db)).toEqual([
      { id: first, kind: "retrying" },
      { id: third, kind: "paused" },
    ]);
    expect(notices(db)).not.toContainEqual(
      expect.objectContaining({ id: second }),
    );
  });

  it("does not notify transient failures", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);

    failScheduledRun(db, {
      expectedNextRunAt: 1000,
      error: "rate limited",
      transient: true,
    });

    expect(notices(db)).toEqual([]);
  });

  it("marks a failed manual run that will not retry as failed", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1_000_000);

    const { run } = createManualRun(db, {
      automationId: "auto_notice",
      runMode: "agent",
      now: 10,
    });

    closeAutomationRun(db, {
      runId: run.id,
      status: "failed",
      error: "boom",
      now: 11,
    });

    expect(notices(db)).toEqual([{ id: run.id, kind: "failed" }]);
  });

  it("queues each pending notice once through push-notifications", async () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);

    const runId = failScheduledRun(db, {
      expectedNextRunAt: 1000,
      error: '{"detail":"Bad Request"}',
    });

    const callRpc = vi.fn().mockResolvedValue({ id: "x", status: "queued" });
    const send = createFailureNoticeSender(fakeApi(callRpc), db);
    const signal = new AbortController().signal;

    await send(2000, signal);
    await send(3000, signal);

    expect(callRpc).toHaveBeenCalledTimes(1);
    expect(callRpc.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "push-notifications",
      method: "notifications.send",
      input: {
        id: `automation-failure:${runId}`,
        title: "Automation failed: Paraspeech > SEO > Weekly Release Readiness",
        body: '{"detail":"Bad Request"} Omnyo retries it and pauses it after 3 failures in a row.',
      },
    });
  });

  it("keeps a notice pending and backs off when queueing fails", async () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);
    failScheduledRun(db, { expectedNextRunAt: 1000, error: "boom" });

    const callRpc = vi
      .fn()
      .mockRejectedValueOnce(new Error("plugin push-notifications is disabled"))
      .mockResolvedValue({ id: "x", status: "queued" });

    const api = fakeApi(callRpc);
    const send = createFailureNoticeSender(api, db);
    const signal = new AbortController().signal;

    await send(2000, signal);
    await send(2000 + FAILURE_NOTICE_RETRY_DELAY_MS - 1, signal);
    expect(callRpc).toHaveBeenCalledTimes(1);
    expect(api.log.warn).toHaveBeenCalledTimes(1);

    await send(2000 + FAILURE_NOTICE_RETRY_DELAY_MS, signal);
    expect(callRpc).toHaveBeenCalledTimes(2);

    await send(2000 + 2 * FAILURE_NOTICE_RETRY_DELAY_MS, signal);
    expect(callRpc).toHaveBeenCalledTimes(2);
  });

  it("skips notices older than a day instead of replaying history", async () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);
    failScheduledRun(db, { expectedNextRunAt: 1000, error: "old" });

    const callRpc = vi.fn().mockResolvedValue({ id: "x", status: "queued" });
    const send = createFailureNoticeSender(fakeApi(callRpc), db);

    await send(1001 + FAILURE_NOTICE_MAX_AGE_MS, new AbortController().signal);

    expect(callRpc).not.toHaveBeenCalled();
  });

  it("keeps titles and bodies inside the push-notifications limits", () => {
    const message = failureNoticeMessage({
      runId: "run_1",
      kind: "paused",
      error: "x".repeat(2_000),
      automationName: "n".repeat(200),
    });

    expect(message.title.length).toBeLessThanOrEqual(80);
    expect(message.body.length).toBeLessThanOrEqual(500);
    expect(message.title.startsWith("Automation paused: ")).toBe(true);
    expect(message.body.endsWith("resume it in Automations.")).toBe(true);
  });
});
