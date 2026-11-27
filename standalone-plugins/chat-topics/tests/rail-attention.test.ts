import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { work } from "./work-fixtures.ts";
import { z } from "zod";
import { buildTree, rootAttention, type GroupThread } from "../lib/grouping.ts";

const countsSchema = z.object({ failed: z.number(), needs: z.number() });

const fixtureSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      parentThreadId: z.string().nullable(),
      status: z.string(),
      runtimeStatus: z.string(),
      queuedWork: z.string(),
      hasPendingInteraction: z.boolean(),
      isUnread: z.boolean(),
      isHidden: z.boolean(),
      isArchived: z.boolean(),
      activity: z.record(z.string(), z.number()),
      indicator: z.string(),
      workLabel: z.enum(["needs-you", "working", "blocked", "waiting", "open", "ready-to-archive"]),
    }),
  ),
  expected: z.object({ projects: z.record(z.string(), countsSchema) }),
});

const fixture = fixtureSchema.parse(
  JSON.parse(readFileSync(new URL("./rail-attention.fixture.json", import.meta.url), "utf8")),
);

const threads: GroupThread[] = fixture.threads.map((thread, index) => ({
  ...thread,
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  originKind: null,
  displayTitle: thread.id,
  originPluginId: null,
  createdAt: index,
  latestAttentionAt: index,
  lastMessageAt: null,
  isPinned: false,
  shelvedAt: null,
  shelfSortKey: null,
  groupId: null,
  work: work(thread.workLabel),
}));

describe("rail badge parity", () => {
  it("puts the same roots in Blocked and Needs you that the rail counts per project", () => {
    const roots = buildTree(threads).roots;

    for (const [projectId, expected] of Object.entries(fixture.expected.projects)) {
      const count = (id: string) =>
        roots.filter(
          (root) => rootAttention(root).state === id && root.thread.projectId === projectId,
        ).length;

      assert.deepEqual(
        { failed: count("blk"), needs: count("need") },
        { failed: expected.failed, needs: expected.needs },
        projectId,
      );
    }
  });
});
