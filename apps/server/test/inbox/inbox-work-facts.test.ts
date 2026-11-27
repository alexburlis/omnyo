import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { queuedThreadMessages, threads, type DbConnection } from "@omnyo/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectInboxEntries } from "../../src/services/inbox/collect.js";
import {
  insertConditions,
  insertWait,
} from "../../src/services/inbox/store.js";
import { createTestDb, withTestHarness } from "../helpers/test-app.js";
import { ThreadWorkFacts } from "../../src/services/threads/thread-work-facts.js";
import { seedQueuedMessage } from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedChat, seedInboxWorld } from "./inbox-driver.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
});

afterEach(() => vi.useRealTimers());

it("loads only uncovered IDs in bounded batches and keeps separate request owners", () => {
  const db = createTestDb();
  const observation = observeReads(db);

  try {
    const facts = new ThreadWorkFacts(db);
    facts.ensure([]);
    expect(observation.counts).toEqual({});
    const ids = Array.from({ length: 405 }, (_, index) => `thread-${index}`);
    facts.ensure([...ids, ...ids]);
    expect(observation.counts.thread_waits).toBeUndefined();
    expect(observation.counts.queued_thread_messages?.reads).toBe(2);
    expect(observation.counts.thread_wait_conditions).toBeUndefined();
    facts.ensure(ids);
    facts.ensure([]);
    expect(observation.counts.thread_waits).toBeUndefined();
    expect(observation.counts.queued_thread_messages?.reads).toBe(2);
    new ThreadWorkFacts(db).ensure(["thread-0"]);
    expect(observation.counts.thread_waits).toBeUndefined();
    expect(observation.counts.queued_thread_messages?.reads).toBe(3);
  } finally {
    observation.stop();
    db.$client.close();
  }
});

function observeReads(db: DbConnection) {
  const raw = db.$client;
  const prepare = raw.prepare.bind(raw);
  const restores: Array<() => void> = [];

  const counts: Record<string, { reads: number; rows: number; bytes: number }> =
    {};

  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = prepare(source);

      const table =
        /from "(thread_waits|thread_wait_conditions|queued_thread_messages)"/u.exec(
          source,
        )?.[1];

      if (table) {
        const original = statement.all;
        statement.all = function (...params: unknown[]) {
          const rows = original.apply(statement, params);
          const count = counts[table] ?? { reads: 0, rows: 0, bytes: 0 };
          count.reads += 1;
          count.rows += rows.length;
          count.bytes += Buffer.byteLength(JSON.stringify(rows));
          counts[table] = count;

          return rows;
        };

        restores.push(() => {
          statement.all = original;
        });
      }

      return statement;
    },
  });

  return {
    counts,
    stop() {
      raw.prepare = prepare;
      restores.forEach((restore) => restore());
    },
  };
}

it.each([0, 3])(
  "pins inbox and public work output with %i expanded sources",
  async (expanded) => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-work-facts");
      const templateChat = seedChat(world, { visibility: "hidden" });

      const template = harness.db
        .select()
        .from(threads)
        .where(eq(threads.id, templateChat.id))
        .get();

      if (!template) throw new Error("Expected thread template");

      const root = {
        ...template,
        id: "thr_work_root",
        visibility: "visible" as const,
      };

      const child = { ...root, id: "thr_work_child", parentThreadId: root.id };
      const archived = { ...child, id: "thr_work_archived" };
      harness.db.insert(threads).values([root, child, archived]).run();
      seedQueuedMessage(harness.deps, {
        threadId: templateChat.id,
        content: textInput("Synthetic owner message"),
        sendAt: Date.now() + 60_000,
      });

      const queuedTemplate = harness.db
        .select()
        .from(queuedThreadMessages)
        .get();

      if (!queuedTemplate) throw new Error("Expected queue template");

      const sources = Array.from({ length: expanded }, (_, index) => {
        const source = {
          ...template,
          id: `thr_work_source_${index}`,
          parentThreadId: null,
          launchedByThreadId: root.id,
          visibility: "hidden" as const,
        };

        harness.db.insert(threads).values(source).run();

        return source;
      });

      const identities = new Map([
        [root.id, "root"],
        [child.id, "child"],
        [archived.id, "archived"],
        [world.projectId, "project"],
        [world.environmentId, "environment"],
      ]);

      for (const [index, thread] of [
        root,
        child,
        archived,
        ...sources,
      ].entries()) {
        const queued = {
          ...queuedTemplate,
          id: `queue-work-${index}`,
          threadId: thread.id,
        };

        harness.db.insert(queuedThreadMessages).values(queued).run();
        identities.set(thread.id, `thread-${index}`);
        identities.set(queued.id, `queue-${index}`);

        if (index === 1)
          harness.db
            .update(queuedThreadMessages)
            .set({ failureReason: "Synthetic failure" })
            .where(eq(queuedThreadMessages.id, queued.id))
            .run();

        for (const [offset, variant] of (
          [
            {
              kind: "check",
              status: "live",
              questionId: null,
              proposalKind: null,
            },
            {
              kind: "report",
              status: "proposed",
              questionId: null,
              proposalKind: null,
            },
            {
              kind: "date",
              status: "live",
              questionId: "question-snooze",
              proposalKind: null,
            },
            {
              kind: "send-later",
              status: "live",
              questionId: null,
              proposalKind: null,
            },
            {
              kind: "report",
              status: "live",
              questionId: null,
              proposalKind: "archive",
            },
            {
              kind: "check",
              status: "closed",
              questionId: null,
              proposalKind: null,
            },
          ] as const
        ).entries()) {
          const wait = insertWait(harness.db, {
            threadId: thread.id,
            key: `wait-${offset}`,
            generation: 1,
            ...variant,
            readiness: "all",
            createdBy: "agent",
            automationId: null,
            ownerAccepted: true,
            forText: `Synthetic wait ${offset}`,
            resumeText: null,
            marker: `marker-${index}-${offset}`,
            deadline: Date.now() + 60_000,
            chainStartAt: Date.now(),
            nextCheckAt: null,
            checkIntervalMs: null,
            reminderAt: null,
            questionRevision: null,
            coversReceiptIds: [],
            afterWaitId: null,
            now: Date.now() + index * 10 + offset,
          });

          identities.set(wait.id, `wait-${index}-${offset}`);

          insertConditions(harness.db, wait.id, [
            {
              key: "z",
              kind: "chat",
              target: root.id,
              label: "Last source",
              afterSeq: null,
            },
            {
              key: "a",
              kind: "chat",
              target: child.id,
              label: "First source",
              afterSeq: null,
            },
          ]);
        }
      }

      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, archived.id))
        .run();
      const retained = new ThreadWorkFacts(harness.db);
      retained.ensure([root.id, root.id]);
      expect(retained.queue.get(root.id)).toHaveLength(1);
      retained.ensure([root.id, child.id]);
      expect(retained.queue.get(root.id)).toHaveLength(1);
      expect(retained.queue.get(child.id)).toHaveLength(1);
      const observation = observeReads(harness.db);

      try {
        const inbox = collectInboxEntries(harness.deps, {
          rootIds: [root.id],
          now: Date.now(),
        });

        const response = await harness.app.request(
          `/api/v1/threads/${root.id}/work`,
        );

        expect(response.status).toBe(200);
        const work: unknown = await response.json();

        const identityPattern = new RegExp(
          [...identities.keys()].join("|"),
          "gu",
        );

        const digest = createHash("sha256")
          .update(
            JSON.stringify({ inbox, work }, (key, value: unknown) =>
              typeof value === "string"
                ? ["revision", "basis", "latch"].includes(key)
                  ? "derived-digest"
                  : value.replace(
                      identityPattern,
                      (id) => identities.get(id) ?? id,
                    )
                : value,
            ),
          )
          .digest("hex");

        expect(digest).toMatchSnapshot();
        const queue = observation.counts.queued_thread_messages;

        expect(queue?.reads).toBeLessThan(expanded === 0 ? 10 : 14);
        expect(queue?.rows).toBeLessThan(expanded === 0 ? 15 : 44);
        expect(queue?.bytes).toBeLessThanOrEqual(expanded === 0 ? 701 : 1767);
      } finally {
        observation.stop();
      }
    });
  },
  30_000,
);
