import { getThread, updateThread } from "@omnyo/db";
import {
  threadResponseSchema,
  threadTimelineResponseSchema,
} from "@omnyo/server-contract";
import { expect, it } from "vitest";
import { completeThreadHandoff } from "../../src/services/threads/thread-create-helpers.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedHandoffSourceAtMaxDepth(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/thread-create-handoff",
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/thread-create-handoff",
  });

  let parentThreadId: string | null = null;

  for (let level = 1; level < 4; level += 1) {
    parentThreadId = seedThread(harness.deps, {
      projectId: project.id,
      parentThreadId,
    }).id;
  }

  const sourceThread = seedThread(harness.deps, {
    environmentId: environment.id,
    parentThreadId,
    projectId: project.id,
    title: "COMMANDER CUSTOM MODEL",
    titleFallback: "Original fallback",
  });

  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    inputText: "Earlier work",
    permissionMode: "full",
    providerThreadId: "provider-handoff-source",
    threadId: sourceThread.id,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-handoff-source",
    sequence: 3,
    threadId: sourceThread.id,
    turnId: "turn-handoff-source",
  });

  return { environment, project, sourceThread };
}

it("keeps the source title and nests the old chat under its handoff without copying history", async () => {
  await withTestHarness(async (harness) => {
    const { environment, project, sourceThread } =
      seedHandoffSourceAtMaxDepth(harness);

    const response = await harness.app.request("/api/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "app",
        projectId: project.id,
        providerId: sourceThread.providerId,
        model: "gpt-5",
        input: [
          { type: "text", text: `Continue from @thread:${sourceThread.id}` },
        ],
        environment: { type: "reuse", environmentId: environment.id },
        originKind: "handoff",
        sourceThreadId: sourceThread.id,
      }),
    });

    expect(response.status).toBe(201);
    const created = threadResponseSchema.parse(await readJson(response));
    expect(created).toMatchObject({
      title: sourceThread.title,
      originKind: "handoff",
      parentThreadId: null,
      sourceThreadId: sourceThread.id,
    });
    expect(getThread(harness.db, created.id)).toMatchObject({
      title: sourceThread.title,
      originKind: "handoff",
      parentThreadId: null,
      sourceThreadId: sourceThread.id,
    });
    expect(getThread(harness.db, sourceThread.id)?.parentThreadId).toBe(
      created.id,
    );

    const start = await waitForQueuedCommand(
      harness,
      ({ command }) =>
        command.type === "thread.start" && command.threadId === created.id,
    );

    if (start.command.type !== "thread.start") {
      throw new Error("Expected thread.start");
    }

    expect(start.command.fork).toBeUndefined();
    expect(start.command.input).toMatchObject([
      { type: "text", text: `Continue from @thread:${sourceThread.id}` },
    ]);
    await reportQueuedCommandSuccess(harness, start, {
      providerThreadId: "provider-handoff-target",
    });

    const timeline = await harness.app.request(
      `/api/v1/threads/${created.id}/timeline`,
    );

    expect(timeline.status).toBe(200);

    const rows = threadTimelineResponseSchema.parse(
      await readJson(timeline),
    ).rows;

    expect(
      rows.flatMap((row) => (row.kind === "conversation" ? [row.text] : [])),
    ).toEqual([`Continue from @thread:${sourceThread.id}`]);
  });
});

it("rejects a handoff without a source thread", async () => {
  await withTestHarness(async (harness) => {
    const { environment, project } = seedHandoffSourceAtMaxDepth(harness);

    const response = await harness.app.request("/api/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        input: [{ type: "text", text: "Continue" }],
        environment: { type: "reuse", environmentId: environment.id },
        originKind: "handoff",
      }),
    });

    expect(response.status).toBe(400);
  });
});

it("keeps earlier chats and existing children directly under repeated handoffs", async () => {
  await withTestHarness(async (harness) => {
    const { environment, project, sourceThread } =
      seedHandoffSourceAtMaxDepth(harness);

    const child = seedThread(harness.deps, {
      projectId: project.id,
      parentThreadId: sourceThread.id,
    });

    const previousIds = [sourceThread.id, child.id];
    let sourceId = sourceThread.id;

    for (let index = 0; index < 5; index += 1) {
      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: sourceThread.providerId,
          model: "gpt-5",
          input: [{ type: "text", text: `Continue from @thread:${sourceId}` }],
          environment: { type: "reuse", environmentId: environment.id },
          originKind: "handoff",
          sourceThreadId: sourceId,
        }),
      });

      expect(response.status).toBe(201);
      const created = threadResponseSchema.parse(await readJson(response));
      expect(created.title).toBe(sourceThread.title);
      expect(created.parentThreadId).toBeNull();
      expect(created.sourceThreadId).toBe(sourceId);

      for (const id of previousIds) {
        expect(getThread(harness.db, id)?.parentThreadId).toBe(created.id);
      }

      previousIds.push(created.id);
      sourceId = created.id;
    }
  });
});

it.each([
  { title: undefined, expected: "Original fallback" },
  { title: "Explicit title", expected: "Explicit title" },
])(
  "uses $expected for a handoff from an unnamed source",
  async ({ title, expected }) => {
    await withTestHarness(async (harness) => {
      const { environment, project, sourceThread } =
        seedHandoffSourceAtMaxDepth(harness);

      updateThread(harness.db, harness.hub, sourceThread.id, { title: null });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: sourceThread.providerId,
          model: "gpt-5",
          input: [{ type: "text", text: "Continue" }],
          environment: { type: "reuse", environmentId: environment.id },
          originKind: "handoff",
          sourceThreadId: sourceThread.id,
          title,
        }),
      });

      expect(response.status).toBe(201);
      expect(threadResponseSchema.parse(await readJson(response)).title).toBe(
        expected,
      );
    });
  },
);

it("rolls back every hierarchy change if moving the source fails", async () => {
  await withTestHarness(async (harness) => {
    const { project, sourceThread } = seedHandoffSourceAtMaxDepth(harness);

    const child = seedThread(harness.deps, {
      projectId: project.id,
      parentThreadId: sourceThread.id,
    });

    const destination = seedThread(harness.deps, {
      projectId: project.id,
      originKind: "handoff",
      sourceThreadId: sourceThread.id,
    });

    harness.db.$client.exec(`
      CREATE TRIGGER reject_handoff_source_move
      BEFORE UPDATE OF parent_thread_id ON threads
      WHEN OLD.id = '${sourceThread.id}'
      BEGIN SELECT RAISE(ABORT, 'handoff move failed'); END;
    `);

    expect(() => completeThreadHandoff(harness.deps, destination)).toThrow(
      "handoff move failed",
    );
    expect(getThread(harness.db, child.id)?.parentThreadId).toBe(
      sourceThread.id,
    );
    expect(getThread(harness.db, sourceThread.id)?.parentThreadId).toBe(
      sourceThread.parentThreadId,
    );
    expect(getThread(harness.db, destination.id)?.parentThreadId).toBeNull();
  });
});
