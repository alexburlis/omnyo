import { getThread } from "@omnyo/db";
import { INBOX_CALLER_THREAD_HEADER, threadSchema } from "@omnyo/domain";
import {
  apiErrorSchema,
  sidebarBootstrapResponseSchema,
  threadListResponseSchema,
} from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedShelfProject(harness: TestAppHarness, name: string) {
  const { host } = seedHostSession(harness.deps, {
    id: `host-thread-shelving-${name}`,
  });

  return seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/thread-shelving-${name}-source`,
  }).project;
}

function postThreadAction(
  harness: TestAppHarness,
  threadId: string,
  action: string,
) {
  return harness.app.request(`/api/v1/threads/${threadId}/${action}`, {
    method: "POST",
  });
}

async function shelve(harness: TestAppHarness, threadId: string) {
  const response = await postThreadAction(harness, threadId, "shelve");

  expect(response.status).toBe(200);

  return threadSchema.parse(await readJson(response));
}

async function listThreadIds(harness: TestAppHarness, query: string) {
  const response = await harness.app.request(`/api/v1/threads?${query}`);

  expect(response.status).toBe(200);

  return threadListResponseSchema
    .parse(await readJson(response))
    .map((thread) => thread.id);
}

async function listSidebarThreadIds(harness: TestAppHarness) {
  const response = await harness.app.request("/api/v1/sidebar-bootstrap");

  expect(response.status).toBe(200);

  const bootstrap = sidebarBootstrapResponseSchema.parse(
    await readJson(response),
  );

  return [bootstrap.personalProject, ...bootstrap.projects].flatMap((project) =>
    project.threads.map((thread) => thread.id),
  );
}

function reorderShelf(
  harness: TestAppHarness,
  threadId: string,
  neighbors: { previousThreadId: string | null; nextThreadId: string | null },
  headers: Record<string, string> = {},
) {
  return harness.app.request(`/api/v1/threads/${threadId}/shelf-order`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(neighbors),
  });
}

function waitForLaterShelfTime() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("public thread shelving", () => {
  it("shelves a top-level chat with its sub-chats and marks it read", async () => {
    await withTestHarness(async (harness) => {
      const project = seedShelfProject(harness, "family");
      const root = seedThread(harness.deps, { projectId: project.id });

      const child = seedThread(harness.deps, {
        parentThreadId: root.id,
        projectId: project.id,
      });

      const hiddenGrandchild = seedThread(harness.deps, {
        parentThreadId: child.id,
        projectId: project.id,
        visibility: "hidden",
      });

      const unread = await postThreadAction(harness, root.id, "unread");

      expect(threadSchema.parse(await readJson(unread)).lastReadAt).toBeNull();

      const shelved = await shelve(harness, root.id);

      expect(shelved.shelvedAt).toEqual(expect.any(Number));
      expect(shelved.lastReadAt).toBeGreaterThanOrEqual(
        shelved.latestAttentionAt,
      );
      expect(getThread(harness.db, child.id)?.shelvedAt).toBe(
        shelved.shelvedAt,
      );
      expect(getThread(harness.db, hiddenGrandchild.id)?.shelvedAt).toBe(
        shelved.shelvedAt,
      );
    });
  });

  it("keeps shelved families out of the sidebar and lists them by shelf state", async () => {
    await withTestHarness(async (harness) => {
      const project = seedShelfProject(harness, "lists");
      const first = seedThread(harness.deps, { projectId: project.id });

      const firstChild = seedThread(harness.deps, {
        parentThreadId: first.id,
        projectId: project.id,
      });

      const second = seedThread(harness.deps, { projectId: project.id });
      const active = seedThread(harness.deps, { projectId: project.id });
      const shelvedThreadIds = [first.id, firstChild.id, second.id];

      await shelve(harness, first.id);
      await waitForLaterShelfTime();
      await shelve(harness, second.id);

      const sidebarThreadIds = await listSidebarThreadIds(harness);

      expect(sidebarThreadIds).toContain(active.id);
      expect(
        sidebarThreadIds.filter((id) => shelvedThreadIds.includes(id)),
      ).toEqual([]);
      expect(
        await listThreadIds(harness, `projectId=${project.id}&shelved=true`),
      ).toEqual([second.id, first.id, firstChild.id]);
      expect(
        await listThreadIds(harness, `projectId=${project.id}&shelved=false`),
      ).toEqual([active.id]);
      expect(
        (await listThreadIds(harness, `projectId=${project.id}`)).sort(),
      ).toEqual([...shelvedThreadIds, active.id].sort());
    });
  });

  it("refuses missing threads, sub-chats and archived chats", async () => {
    await withTestHarness(async (harness) => {
      const project = seedShelfProject(harness, "refusals");
      const root = seedThread(harness.deps, { projectId: project.id });

      const child = seedThread(harness.deps, {
        parentThreadId: root.id,
        projectId: project.id,
      });

      const archived = seedThread(harness.deps, { projectId: project.id });

      for (const action of ["shelve", "unshelve"]) {
        const missing = await postThreadAction(harness, "thr_missing", action);

        expect(missing.status).toBe(404);
        expect(apiErrorSchema.parse(await readJson(missing))).toMatchObject({
          code: "thread_not_found",
        });
      }

      const subChat = await postThreadAction(harness, child.id, "shelve");

      expect(subChat.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(subChat))).toMatchObject({
        code: "shelve_requires_top_level",
      });

      expect(
        (await postThreadAction(harness, archived.id, "archive-all")).status,
      ).toBe(200);

      const archivedChat = await postThreadAction(
        harness,
        archived.id,
        "shelve",
      );

      expect(archivedChat.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(archivedChat))).toMatchObject({
        code: "thread_archived",
      });

      for (const thread of [root, child, archived]) {
        expect(getThread(harness.db, thread.id)?.shelvedAt).toBeNull();
      }
    });
  });

  it("shelves and unshelves idempotently and returns the family to the sidebar", async () => {
    await withTestHarness(async (harness) => {
      const project = seedShelfProject(harness, "idempotent");
      const root = seedThread(harness.deps, { projectId: project.id });

      const child = seedThread(harness.deps, {
        parentThreadId: root.id,
        projectId: project.id,
      });

      const shelved = await shelve(harness, root.id);
      const repeated = await shelve(harness, root.id);

      expect(repeated.shelvedAt).toBe(shelved.shelvedAt);
      expect(repeated.lastReadAt).toBe(shelved.lastReadAt);
      expect(await listSidebarThreadIds(harness)).not.toContain(root.id);

      for (const attempt of ["first", "repeated"]) {
        const response = await postThreadAction(harness, root.id, "unshelve");

        expect(response.status, attempt).toBe(200);
        expect(
          threadSchema.parse(await readJson(response)).shelvedAt,
          attempt,
        ).toBeNull();
      }

      expect(await listSidebarThreadIds(harness)).toEqual(
        expect.arrayContaining([root.id, child.id]),
      );
    });
  });

  it("keeps Shelf membership when a shelved chat is archived", async () => {
    await withTestHarness(async (harness) => {
      const project = seedShelfProject(harness, "archive");
      const root = seedThread(harness.deps, { projectId: project.id });

      const child = seedThread(harness.deps, {
        parentThreadId: root.id,
        projectId: project.id,
      });

      await shelve(harness, root.id);

      expect(
        (await postThreadAction(harness, root.id, "archive-all")).status,
      ).toBe(200);

      for (const thread of [root, child]) {
        expect(getThread(harness.db, thread.id)).toMatchObject({
          archivedAt: expect.any(Number),
          shelvedAt: expect.any(Number),
        });
      }
    });
  });

  it("lets the owner drag a Shelf family between neighbors", async () => {
    await withTestHarness(async (harness) => {
      const project = seedShelfProject(harness, "order");
      const first = seedThread(harness.deps, { projectId: project.id });

      const firstChild = seedThread(harness.deps, {
        parentThreadId: first.id,
        projectId: project.id,
      });

      const second = seedThread(harness.deps, { projectId: project.id });
      const third = seedThread(harness.deps, { projectId: project.id });

      for (const thread of [first, second, third]) {
        await shelve(harness, thread.id);
        await waitForLaterShelfTime();
      }

      const shelfQuery = `projectId=${project.id}&shelved=true`;

      expect(await listThreadIds(harness, shelfQuery)).toEqual([
        third.id,
        second.id,
        first.id,
        firstChild.id,
      ]);

      const moved = await reorderShelf(harness, first.id, {
        previousThreadId: null,
        nextThreadId: third.id,
      });

      expect(moved.status).toBe(200);

      const [movedRoot] = threadListResponseSchema.parse(await readJson(moved));

      expect(movedRoot?.id).toBe(first.id);
      expect(movedRoot?.shelfSortKey).toEqual(expect.any(String));
      expect(await listThreadIds(harness, shelfQuery)).toEqual([
        first.id,
        firstChild.id,
        third.id,
        second.id,
      ]);

      const stale = await reorderShelf(harness, second.id, {
        previousThreadId: second.id,
        nextThreadId: null,
      });

      expect(stale.status).toBe(409);

      const agent = await reorderShelf(
        harness,
        second.id,
        { previousThreadId: null, nextThreadId: first.id },
        { [INBOX_CALLER_THREAD_HEADER]: third.id },
      );

      expect(agent.status).toBe(403);
      expect(apiErrorSchema.parse(await readJson(agent))).toMatchObject({
        code: "owner_only",
      });
      expect(await listThreadIds(harness, shelfQuery)).toEqual([
        first.id,
        firstChild.id,
        third.id,
        second.id,
      ]);
    });
  });
});
