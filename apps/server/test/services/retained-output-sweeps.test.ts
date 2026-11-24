import { performance } from "node:perf_hooks";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  COMPLETED_EVENT_OUTPUT_RETENTION_MS,
  createConnection,
  createProject,
  createThread,
  events,
  maintenanceScanCursors,
  migrate,
  noopNotifier,
  retainedEventOutputs,
  threadPruningWork,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import {
  runCompletedEventOutputMigrationSweep,
  runRetainedEventOutputExpirySweep,
} from "../../src/services/system/periodic-sweeps.js";
import { NotificationHub } from "../../src/ws/hub.js";

const NOW = 1_800_000_000_000;

type SweepKind = "expiry" | "migration";

function fixture(kind: SweepKind, sizes: readonly number[]) {
  let commits = 0;
  const payloadCommitGroups = new Set<number>();

  const db: DbConnection = createConnection(":memory:", {
    slowQueryThresholdMs: 0,
    slowQueryLogger: {
      info(fields) {
        if (
          fields.operation === "run" &&
          /^(delete from "retained_event_outputs"|update "events")/iu.test(
            fields.sql,
          )
        )
          payloadCommitGroups.add(commits);

        if (
          !db.$client.inTransaction &&
          (fields.operation === "transaction" ||
            (fields.operation === "run" &&
              /^delete from "retained_event_outputs"/iu.test(fields.sql)))
        )
          commits += 1;
      },
    },
  });

  migrate(db);
  const hub = new NotificationHub();
  const host = upsertHost(db, noopNotifier, { name: "retention-batch-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "retention-batch-project",
    source: { type: "local_path", hostId: host.id, path: "/inert/retention" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  const output = (size: number) => "x".repeat(size);

  db.transaction(() => {
    for (const [index, size] of sizes.entries()) {
      const id = `maintenance-${index + 1}`;
      db.insert(events)
        .values({
          id,
          threadId: thread.id,
          scopeKind: "turn",
          turnId: "maintenance-turn",
          sequence: index + 1,
          type: "item/completed",
          itemId: id,
          itemKind: "commandExecution",
          createdAt:
            kind === "expiry"
              ? NOW - COMPLETED_EVENT_OUTPUT_RETENTION_MS - 1
              : NOW - 1,
          data: JSON.stringify({
            item: {
              id,
              type: "commandExecution",
              aggregatedOutput: kind === "expiry" ? "preview" : output(size),
            },
          }),
        })
        .run();

      if (kind === "expiry")
        db.insert(retainedEventOutputs)
          .values({
            eventId: id,
            outputPath: "aggregatedOutput",
            value: JSON.stringify(output(size)),
            expiresAt: NOW - 1,
          })
          .run();
    }
  });

  const notifications: string[] = [];
  hub.onChangedMessage((message) => {
    if (
      message.entity === "thread" &&
      message.changes.includes("history-compacted")
    )
      notifications.push(message.id);
  });

  return {
    db,
    notifications,
    thread,
    commitCount: () => commits,
    payloadCommitCount: () => payloadCommitGroups.size,
    async run() {
      commits = 0;
      payloadCommitGroups.clear();

      if (kind === "expiry")
        await runRetainedEventOutputExpirySweep({ db, hub }, NOW);
      else await runCompletedEventOutputMigrationSweep({ db, hub }, NOW);
    },
  };
}

async function observeExpiryYields(f: ReturnType<typeof fixture>) {
  const counts: number[] = [];
  let finished = false;

  const probe = () => {
    if (finished) return;
    counts.push(f.db.select().from(retainedEventOutputs).all().length);
    setImmediate(probe);
  };

  setImmediate(probe);

  try {
    await f.run();
  } finally {
    finished = true;
  }

  return counts;
}

describe("retained output transaction batches", () => {
  it.each(["expiry", "migration"] as const)(
    "groups two small %s writes in one commit while retaining previews and live output",
    async (kind) => {
      const f = fixture(
        kind,
        kind === "expiry" ? [40_000, 40_000, 40_000] : [40_000, 40_000],
      );

      if (kind === "expiry")
        f.db
          .update(retainedEventOutputs)
          .set({ expiresAt: NOW + 1 })
          .where(eq(retainedEventOutputs.eventId, "maintenance-3"))
          .run();

      const liveOutputs = f.db
        .select()
        .from(retainedEventOutputs)
        .where(eq(retainedEventOutputs.eventId, "maintenance-3"))
        .all();

      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const before = f.db.select().from(events).all();

      try {
        await f.run();
        expect(f.commitCount()).toBeLessThanOrEqual(2);
        expect(f.payloadCommitCount()).toBe(1);
        expect(f.notifications).toEqual([f.thread.id]);

        if (kind === "expiry") {
          expect(f.db.select().from(events).all()).toEqual(before);
          expect(f.db.select().from(retainedEventOutputs).all()).toEqual(
            liveOutputs,
          );
        } else {
          const outputs = f.db.select().from(retainedEventOutputs).all();
          expect(outputs.map((row) => row.value)).toEqual([
            JSON.stringify("x".repeat(40_000)),
            JSON.stringify("x".repeat(40_000)),
          ]);
          expect(
            outputs.every(
              (row) =>
                row.expiresAt === NOW - 1 + COMPLETED_EVENT_OUTPUT_RETENTION_MS,
            ),
          ).toBe(true);
          expect(
            f.db
              .select()
              .from(events)
              .all()
              .every((row) => row.data.length < 10_000),
          ).toBe(true);
          expect(
            f.db.select().from(maintenanceScanCursors).all().length,
          ).toBeGreaterThan(0);
          const committed = f.db.select().from(events).all();
          await f.run();
          expect(f.db.select().from(events).all()).toEqual(committed);
        }
      } finally {
        clock.mockRestore();
        f.db.$client.close();
      }
    },
  );

  it.each(["expiry", "migration"] as const)(
    "rolls back earlier %s advances and cursors when the second write fails",
    async (kind) => {
      const f = fixture(kind, [40_000, 40_000]);
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const before = f.db.select().from(events).all();
      const outputs = f.db.select().from(retainedEventOutputs).all();
      f.db.$client.exec(
        kind === "expiry"
          ? `CREATE TRIGGER fail_second_expiry BEFORE DELETE ON retained_event_outputs
             WHEN OLD.event_id = 'maintenance-2' BEGIN SELECT RAISE(ABORT, 'second maintenance write failed'); END`
          : `CREATE TRIGGER fail_second_migration BEFORE UPDATE OF data ON events
             WHEN OLD.id = 'maintenance-2' BEGIN SELECT RAISE(ABORT, 'second maintenance write failed'); END`,
      );

      try {
        await expect(f.run()).rejects.toThrow();
        expect(f.db.select().from(events).all()).toEqual(before);
        expect(f.db.select().from(retainedEventOutputs).all()).toEqual(outputs);
        expect(f.db.select().from(maintenanceScanCursors).all()).toEqual([]);
        expect(f.db.select().from(threadPruningWork).all()).toEqual([]);
        expect(f.notifications).toEqual([]);
      } finally {
        clock.mockRestore();
        f.db.$client.close();
      }
    },
  );

  it.each(["expiry", "migration"] as const)(
    "preserves earlier %s commits and resumes the failed batch without losing output",
    async (kind) => {
      const f = fixture(kind, [300_000, 40_000, 40_000]);
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);

      const state = () => ({
        events: f.db.select().from(events).all(),
        outputs: f.db.select().from(retainedEventOutputs).all(),
        cursors: f.db.select().from(maintenanceScanCursors).all(),
      });

      let checkpoint: ReturnType<typeof state> | null = null;
      f.db.$client.exec(
        kind === "expiry"
          ? `CREATE TRIGGER fail_later_batch BEFORE DELETE ON retained_event_outputs
             WHEN OLD.event_id = 'maintenance-3' BEGIN SELECT RAISE(ABORT, 'later batch failed'); END`
          : `CREATE TRIGGER fail_later_batch BEFORE UPDATE OF data ON events
             WHEN OLD.id = 'maintenance-3' BEGIN SELECT RAISE(ABORT, 'later batch failed'); END`,
      );
      setImmediate(() => {
        checkpoint = state();
      });

      try {
        await expect(f.run()).rejects.toThrow();
        expect(checkpoint).not.toBeNull();
        expect(state()).toEqual(checkpoint);
        expect(f.notifications).toEqual([f.thread.id]);
        f.db.$client.exec("DROP TRIGGER fail_later_batch");
        await f.run();
        const outputs = f.db.select().from(retainedEventOutputs).all();

        if (kind === "expiry") expect(outputs).toEqual([]);
        else
          expect(outputs.map((row) => row.value)).toEqual(
            [300_000, 40_000, 40_000].map((size) =>
              JSON.stringify("x".repeat(size)),
            ),
          );
      } finally {
        clock.mockRestore();
        f.db.$client.close();
      }
    },
  );

  it("yields after at most eight small expiry advances", async () => {
    const f = fixture(
      "expiry",
      Array.from({ length: 20 }, () => 1),
    );

    const clock = vi.spyOn(performance, "now").mockReturnValue(0);

    try {
      expect(await observeExpiryYields(f)).toEqual([12, 4]);
      expect(f.commitCount()).toBe(3);
      expect(f.db.select().from(retainedEventOutputs).all()).toEqual([]);
    } finally {
      clock.mockRestore();
      f.db.$client.close();
    }
  });

  it("yields after an indivisible oversized expiry and continues with the next output", async () => {
    const f = fixture("expiry", [300_000, 300_000, 300_000]);
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);

    try {
      expect(await observeExpiryYields(f)).toEqual([2, 1, 0]);
      expect(f.db.select().from(retainedEventOutputs).all()).toEqual([]);
    } finally {
      clock.mockRestore();
      f.db.$client.close();
    }
  });

  it("yields after an advance exceeds the elapsed budget", async () => {
    const f = fixture("expiry", [1, 1, 1]);
    let elapsed = 0;

    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => elapsed);

    f.db.$client.function("advance_maintenance_clock", () => {
      elapsed += 10;
    });
    f.db.$client
      .exec(`CREATE TRIGGER slow_expiry AFTER DELETE ON retained_event_outputs
      BEGIN SELECT advance_maintenance_clock(); END`);

    try {
      expect(await observeExpiryYields(f)).toEqual([2, 1, 0]);
    } finally {
      clock.mockRestore();
      f.db.$client.close();
    }
  });
});
