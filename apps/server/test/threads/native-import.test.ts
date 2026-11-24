import {
  environments,
  getNativeThreadImport,
  getThread,
  listEvents,
  nativeThreadImports,
  threadOwnerInputs,
  threadReceipts,
} from "@omnyo/db";
import {
  importNativeThreadResponseSchema,
  nativeSessionClaimsResponseSchema,
  threadTimelineResponseSchema,
  type ImportNativeThreadRequest,
} from "@omnyo/server-contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import {
  reportNextEnvironmentAttachSuccess,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadIdentity,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const CREATED_AT = Date.UTC(2026, 10, 10, 9, 0, 0);

const LAST_MESSAGE_AT = Date.UTC(2026, 10, 10, 9, 5, 0);

afterEach(() => vi.restoreAllMocks());

function seedImportTarget(harness: TestAppHarness, path: string) {
  const { host } = seedHostSession(harness.deps, { id: `host-${path}` });

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path,
  });

  return { host, project };
}

function seedIdentityOwner(
  harness: TestAppHarness,
  args: { hostId: string; path: string; projectId: string; source: string },
) {
  const environment = seedEnvironment(harness.deps, {
    hostId: args.hostId,
    projectId: args.projectId,
    path: `${args.path}-owner`,
  });

  const owner = seedThread(harness.deps, {
    projectId: args.projectId,
    environmentId: environment.id,
  });

  seedThreadIdentity(harness.deps, {
    threadId: owner.id,
    environmentId: environment.id,
    providerThreadId: args.source,
  });

  return owner;
}

function importRequest(args: {
  cwd: string;
  hostId: string;
  projectId: string;
  sourceProviderThreadId: string;
}): Omit<ImportNativeThreadRequest, "origin"> & { origin: "sdk" } {
  return {
    projectId: args.projectId,
    hostId: args.hostId,
    providerId: "codex",
    sourceProviderThreadId: args.sourceProviderThreadId,
    sourcePath: `/home/test/.codex/sessions/rollout-${args.sourceProviderThreadId}.jsonl`,
    cwd: args.cwd,
    title: "Fix the relay reconnect",
    createdAt: CREATED_AT,
    lastMessageAt: LAST_MESSAGE_AT,
    origin: "sdk",
    turns: [
      {
        startedAt: CREATED_AT,
        completedAt: CREATED_AT + 60_000,
        status: "completed",
        userText: "Why does the relay drop after sleep?",
        items: [
          {
            type: "commandExecution",
            id: "call-1",
            command: "rg reconnect",
            cwd: null,
            output: "relay.ts: reconnect()",
            exitCode: 0,
            durationMs: 120,
          },
          {
            type: "agentMessage",
            id: "msg-1",
            text: "The socket is not re-armed after wake.",
          },
        ],
      },
      {
        startedAt: LAST_MESSAGE_AT - 30_000,
        completedAt: LAST_MESSAGE_AT,
        status: "completed",
        userText: "Patch it",
        items: [
          {
            type: "fileChange",
            id: "patch-1",
            changes: [
              {
                path: "relay.ts",
                kind: "update",
                diff: "@@ -1 +1 @@\n-old\n+new\n",
              },
            ],
          },
          { type: "agentMessage", id: "msg-2", text: "Patched the re-arm." },
        ],
      },
    ],
  };
}

async function postImport(
  harness: TestAppHarness,
  body: ImportNativeThreadRequest,
): Promise<Response> {
  return harness.app.request("/api/v1/threads/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function importOk(
  harness: TestAppHarness,
  body: ImportNativeThreadRequest,
): Promise<string> {
  const response = await postImport(harness, body);
  expect(response.status, await response.clone().text()).toBe(201);

  const result = importNativeThreadResponseSchema.parse(
    await readJson(response),
  );

  if (result.kind !== "imported") {
    throw new Error("Expected an imported thread");
  }

  return result.threadId;
}

async function settleImport(harness: TestAppHarness, threadId: string) {
  await reportNextEnvironmentAttachSuccess(harness, threadId);
  await waitForIdle(harness, threadId);
}

async function waitForIdle(harness: TestAppHarness, threadId: string) {
  await expect.poll(() => getThread(harness.db, threadId)?.status).toBe("idle");
}

async function sendText(
  harness: TestAppHarness,
  threadId: string,
  text: string,
): Promise<void> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: textInput(text), mode: "auto" }),
    },
  );

  expect(response.status, await response.clone().text()).toBe(200);
}

describe("POST /threads/import", () => {
  it("creates an idle thread with original times, seeded history and no attention", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-idle";
      const { host, project } = seedImportTarget(harness, path);
      const importStartedAt = Date.now();

      const threadId = await importOk(
        harness,
        importRequest({
          cwd: path,
          hostId: host.id,
          projectId: project.id,
          sourceProviderThreadId: "codex-source-idle",
        }),
      );

      await settleImport(harness, threadId);

      const thread = getThread(harness.db, threadId);
      expect(thread).toMatchObject({
        createdAt: CREATED_AT,
        latestAttentionAt: LAST_MESSAGE_AT,
        lastReadAt: LAST_MESSAGE_AT,
        title: "Fix the relay reconnect",
      });
      expect(thread?.updatedAt).toBeGreaterThanOrEqual(importStartedAt);

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${threadId}/timeline`,
      );

      expect(timelineResponse.status).toBe(200);

      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );

      const conversation = timeline.rows.flatMap((row) =>
        row.kind === "conversation" ? [row.text] : [],
      );

      expect(conversation).toEqual([
        "Why does the relay drop after sleep?",
        "The socket is not re-armed after wake.",
        "Patch it",
        "Patched the re-arm.",
      ]);

      const events = listEvents(harness.db, { threadId });
      expect(events.some((event) => event.type === "thread/identity")).toBe(
        false,
      );
      expect(
        events
          .filter((event) => event.type === "client/turn/requested")
          .map((event) => event.createdAt),
      ).toEqual([CREATED_AT, LAST_MESSAGE_AT - 30_000]);

      expect(
        harness.db
          .select()
          .from(threadReceipts)
          .where(eq(threadReceipts.threadId, threadId))
          .all(),
      ).toEqual([]);
      expect(
        harness.db
          .select()
          .from(threadOwnerInputs)
          .where(eq(threadOwnerInputs.threadId, threadId))
          .all(),
      ).toEqual([]);
    });
  });

  it("reports a second import of the same source as already claimed", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-twice";
      const { host, project } = seedImportTarget(harness, path);

      const request = importRequest({
        cwd: path,
        hostId: host.id,
        projectId: project.id,
        sourceProviderThreadId: "codex-source-twice",
      });

      const threadId = await importOk(harness, request);
      const second = await postImport(harness, request);

      expect(second.status).toBe(200);
      expect(await readJson(second)).toEqual({
        kind: "already-claimed",
        threadId,
        via: "import",
      });
    });
  });

  it("refuses a source that another thread already owns through its identity", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-owned";
      const { host, project } = seedImportTarget(harness, path);

      const owner = seedIdentityOwner(harness, {
        hostId: host.id,
        path,
        projectId: project.id,
        source: "codex-source-owned",
      });

      const response = await postImport(
        harness,
        importRequest({
          cwd: path,
          hostId: host.id,
          projectId: project.id,
          sourceProviderThreadId: "codex-source-owned",
        }),
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        kind: "already-claimed",
        threadId: owner.id,
        via: "identity",
      });
      expect(harness.db.select().from(nativeThreadImports).all()).toEqual([]);
    });
  });

  it("lists import and identity claims for the host and provider", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-claims";
      const { host, project } = seedImportTarget(harness, path);

      const owner = seedIdentityOwner(harness, {
        hostId: host.id,
        path,
        projectId: project.id,
        source: "codex-identity-claim",
      });

      const importedId = await importOk(
        harness,
        importRequest({
          cwd: path,
          hostId: host.id,
          projectId: project.id,
          sourceProviderThreadId: "codex-import-claim",
        }),
      );

      const response = await harness.app.request(
        `/api/v1/threads/native-sessions?hostId=${host.id}&providerId=codex`,
      );

      expect(response.status).toBe(200);

      const body = nativeSessionClaimsResponseSchema.parse(
        await readJson(response),
      );

      expect(body.claimed).toEqual(
        expect.arrayContaining([
          {
            sourceProviderThreadId: "codex-import-claim",
            threadId: importedId,
            via: "import",
          },
          {
            sourceProviderThreadId: "codex-identity-claim",
            threadId: owner.id,
            via: "identity",
          },
        ]),
      );
      expect(body.claimed).toHaveLength(2);

      const otherProvider = await harness.app.request(
        `/api/v1/threads/native-sessions?hostId=${host.id}&providerId=claude-code`,
      );

      expect(await readJson(otherProvider)).toEqual({ claimed: [] });
    });
  });

  it("forks the source on the first send and resumes the fork afterwards", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-send";
      const { host, project } = seedImportTarget(harness, path);

      const threadId = await importOk(
        harness,
        importRequest({
          cwd: path,
          hostId: host.id,
          projectId: project.id,
          sourceProviderThreadId: "codex-source-send",
        }),
      );

      await settleImport(harness, threadId);

      await sendText(harness, threadId, "Continue from here");

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === threadId,
      );

      if (start.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }

      expect(start.command.fork).toEqual({
        sourceProviderThreadId: "codex-source-send",
        restoreArchivedSource: false,
      });

      await reportQueuedCommandSuccess(harness, start, {
        providerThreadId: "codex-forked-session",
      });
      seedThreadIdentity(harness.deps, {
        threadId,
        environmentId: getThread(harness.db, threadId)?.environmentId ?? null,
        providerThreadId: "codex-forked-session",
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId,
        event: { type: "run.succeeded" },
      });
      await waitForIdle(harness, threadId);

      await sendText(harness, threadId, "And one more thing");

      const next = await waitForQueuedCommandAfter(
        harness,
        start.row.cursor,
        ({ command }) =>
          (command.type === "turn.submit" || command.type === "thread.start") &&
          command.threadId === threadId,
      );

      expect(next.command.type).toBe("turn.submit");
    });
  });

  it("refuses to fork an imported chat that never sent, so the native session is never cloned", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-fork-copy";
      const { host, project } = seedImportTarget(harness, path);

      const threadId = await importOk(
        harness,
        importRequest({
          cwd: path,
          hostId: host.id,
          projectId: project.id,
          sourceProviderThreadId: "codex-source-fork-copy",
        }),
      );

      await settleImport(harness, threadId);

      const lastSeededCompletion = listEvents(harness.db, { threadId })
        .filter((event) => event.type === "turn/completed")
        .at(-1);

      if (lastSeededCompletion === undefined) {
        throw new Error("Expected the imported last turn completion");
      }

      for (const body of [
        { sourceThreadId: threadId },
        {
          sourceThreadId: threadId,
          sourceSeqEnd: lastSeededCompletion.sequence,
        },
      ]) {
        const response = await harness.app.request("/api/v1/threads/fork", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        expect(response.status).toBe(400);
        expect(await readJson(response)).toMatchObject({
          code: "fork_source_session_unavailable",
        });
      }
    });
  });

  it("starts fresh after the first imported message is edited, even when that start fails", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-edit";
      const { host, project } = seedImportTarget(harness, path);

      const threadId = await importOk(
        harness,
        importRequest({
          cwd: path,
          hostId: host.id,
          projectId: project.id,
          sourceProviderThreadId: "codex-source-edit",
        }),
      );

      await settleImport(harness, threadId);

      const firstRequest = listEvents(harness.db, { threadId }).find(
        (event) => event.type === "client/turn/requested",
      );

      if (firstRequest === undefined) {
        throw new Error("Expected the imported first turn request");
      }

      const edit = await harness.app.request(
        `/api/v1/threads/${threadId}/edit-message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationId: "edit-op-native-import",
            expectedRequestSequence: firstRequest.sequence,
            input: textInput("Ask something else instead"),
          }),
        },
      );

      expect(edit.status, await edit.clone().text()).toBe(200);

      const editedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === threadId,
      );

      if (editedStart.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }

      expect(editedStart.command.fork).toBeUndefined();

      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId,
        event: { type: "run.failed" },
      });
      await expect
        .poll(() => getThread(harness.db, threadId)?.status)
        .toBe("error");

      await sendText(harness, threadId, "Try again");

      const retry = await waitForQueuedCommandAfter(
        harness,
        editedStart.row.cursor,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === threadId,
      );

      if (retry.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }

      expect(retry.command.fork).toBeUndefined();
    });
  });

  it("forks the source when the first send reprovisions an errored environment", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-reprovision";
      const { host, project } = seedImportTarget(harness, path);

      const threadId = await importOk(
        harness,
        importRequest({
          cwd: path,
          hostId: host.id,
          projectId: project.id,
          sourceProviderThreadId: "codex-source-reprovision",
        }),
      );

      await settleImport(harness, threadId);

      const environmentId = getThread(harness.db, threadId)?.environmentId;

      if (environmentId === null || environmentId === undefined) {
        throw new Error("Expected the imported thread to have an environment");
      }

      harness.db
        .update(environments)
        .set({ status: "error" })
        .where(eq(environments.id, environmentId))
        .run();

      await sendText(harness, threadId, "Continue after the error");
      await reportNextEnvironmentAttachSuccess(harness, threadId);

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === threadId,
      );

      if (start.command.type !== "thread.start") {
        throw new Error("Expected thread.start");
      }

      expect(start.command.fork).toEqual({
        sourceProviderThreadId: "codex-source-reprovision",
        restoreArchivedSource: false,
      });
    });
  });

  it("removes the import record when seeding fails so a retry imports", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/native-import-failure";
      const { host, project } = seedImportTarget(harness, path);

      const request = importRequest({
        cwd: path,
        hostId: host.id,
        projectId: project.id,
        sourceProviderThreadId: "codex-source-failure",
      });

      const notifyThread = harness.deps.hub.notifyThread.bind(harness.deps.hub);
      let failed = false;

      vi.spyOn(harness.deps.hub, "notifyThread").mockImplementation(
        (threadId, types, metadata) => {
          if (!failed && types.includes("events-appended")) {
            failed = true;
            throw new Error("Seeding notification failed");
          }

          notifyThread(threadId, types, metadata);
        },
      );

      const response = await postImport(harness, request);
      expect(response.status).toBe(500);
      expect(failed).toBe(true);
      expect(harness.db.select().from(nativeThreadImports).all()).toEqual([]);

      const retriedId = await importOk(harness, request);
      expect(getNativeThreadImport(harness.db, retriedId)).toMatchObject({
        sourceProviderThreadId: "codex-source-failure",
      });
    });
  });
});
