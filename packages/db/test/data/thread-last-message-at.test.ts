import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@omnyo/domain";
import { noopNotifier } from "../../src/notifier.js";
import {
  appendDaemonEventsInTransaction,
  appendStoredThreadEvent,
  copyStoredThreadEventsInTransaction,
  insertEvents,
  listStoredEventRows,
  type AppendDaemonEventInput,
} from "../../src/data/events.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread, getThread } from "../../src/data/threads.js";
import type { DbConnection } from "../../src/connection.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "last-message-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "last-message-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/last-message" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  return { db, project, thread };
}

const turnFields = {
  itemId: null,
  itemKind: null,
  parentToolCallId: null,
  scope: turnScope("turn-last-message"),
  environmentId: null,
  providerThreadId: "provider-last-message",
};

function turnStarted(threadId: string): AppendDaemonEventInput {
  return {
    threadId,
    type: "turn/started",
    ...turnFields,
    data: JSON.stringify({ providerThreadId: "provider-last-message" }),
  };
}

function userMessage(threadId: string): AppendDaemonEventInput {
  return {
    threadId,
    type: "client/turn/requested",
    scope: threadScope(),
    environmentId: null,
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    providerThreadId: null,
    data: JSON.stringify({
      direction: "outbound",
      requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "hello", mentions: [] }],
      target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    }),
  };
}

function agentMessage(threadId: string, id: string): AppendDaemonEventInput {
  return {
    threadId,
    type: "item/completed",
    ...turnFields,
    itemId: id,
    itemKind: "agentMessage",
    data: JSON.stringify({
      providerThreadId: "provider-last-message",
      item: { type: "agentMessage", id, text: "done" },
    }),
  };
}

function commandCompleted(threadId: string): AppendDaemonEventInput {
  return {
    threadId,
    type: "item/completed",
    ...turnFields,
    itemId: "cmd-last-message",
    itemKind: "commandExecution",
    data: JSON.stringify({
      providerThreadId: "provider-last-message",
      item: {
        type: "commandExecution",
        id: "cmd-last-message",
        command: "true",
        cwd: "/tmp/last-message",
        status: "completed",
        approvalStatus: null,
        aggregatedOutput: "",
      },
    }),
  };
}

function appendAt(
  db: DbConnection,
  at: number,
  inputs: AppendDaemonEventInput[],
): void {
  vi.spyOn(Date, "now").mockReturnValue(at);
  db.transaction((tx) => appendDaemonEventsInTransaction(tx, inputs), {
    behavior: "immediate",
  });
  vi.restoreAllMocks();
}

it("tracks the latest user or agent message and ignores other events", () => {
  const { db, thread } = setup();
  expect(getThread(db, thread.id)?.lastMessageAt).toBeNull();

  appendAt(db, 1_000, [turnStarted(thread.id), userMessage(thread.id)]);
  expect(getThread(db, thread.id)?.lastMessageAt).toBe(1_000);

  appendAt(db, 2_000, [agentMessage(thread.id, "msg-1")]);
  expect(getThread(db, thread.id)?.lastMessageAt).toBe(2_000);

  appendAt(db, 3_000, [commandCompleted(thread.id)]);
  expect(getThread(db, thread.id)?.lastMessageAt).toBe(2_000);
});

it("gives a fork the time of the latest copied message", () => {
  const { db, project, thread } = setup();

  const fork = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  insertEvents(
    db,
    noopNotifier,
    [
      turnStarted(thread.id),
      userMessage(thread.id),
      agentMessage(thread.id, "msg-1"),
      commandCompleted(thread.id),
    ].map((input, index) => ({
      ...input,
      sequence: index + 1,
      createdAt: 10_000 + index,
    })),
  );

  db.transaction(
    (tx) =>
      copyStoredThreadEventsInTransaction(tx, {
        rows: listStoredEventRows(db, { threadId: thread.id }),
        targetEnvironmentId: null,
        targetThreadId: fork.id,
      }),
    { behavior: "immediate" },
  );

  expect(getThread(db, fork.id)?.lastMessageAt).toBe(10_002);
});

it("backfills existing threads from their stored message events", () => {
  const { db, project, thread } = setup();

  const silent = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  insertEvents(
    db,
    noopNotifier,
    [
      turnStarted(thread.id),
      userMessage(thread.id),
      agentMessage(thread.id, "msg-1"),
      commandCompleted(thread.id),
    ].map((input, index) => ({
      ...input,
      sequence: index + 1,
      createdAt: 20_000 + index,
    })),
  );
  insertEvents(db, noopNotifier, [
    { ...turnStarted(silent.id), sequence: 1, createdAt: 30_000 },
  ]);
  db.$client.exec("UPDATE threads SET last_message_at = NULL");

  const migration = readFileSync(
    resolve(__dirname, "../../drizzle/0146_wet_alice.sql"),
    "utf8",
  ).split("--> statement-breakpoint");

  db.$client.exec(migration[1] ?? "");

  expect(getThread(db, thread.id)?.lastMessageAt).toBe(20_002);
  expect(getThread(db, silent.id)?.lastMessageAt).toBeNull();
});

it("tracks server-appended user messages and ignores identity events", () => {
  const { db, thread } = setup();
  vi.spyOn(Date, "now").mockReturnValue(4_000);

  appendStoredThreadEvent(db, noopNotifier, {
    threadId: thread.id,
    scope: threadScope(),
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      source: "spawn",
      initiator: "user",
      senderThreadId: null,
      requestId: "creq_last_message",
      input: [{ type: "text", text: "start", mentions: [] }],
      target: { kind: "thread-start" },
      request: { method: "thread/start", params: {} },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    },
  });
  expect(getThread(db, thread.id)?.lastMessageAt).toBe(4_000);

  vi.spyOn(Date, "now").mockReturnValue(5_000);
  appendStoredThreadEvent(db, noopNotifier, {
    threadId: thread.id,
    scope: threadScope(),
    providerThreadId: "provider_last_message",
    type: "thread/identity",
    data: { providerThreadId: "provider_last_message" },
  });
  expect(getThread(db, thread.id)?.lastMessageAt).toBe(4_000);
});
