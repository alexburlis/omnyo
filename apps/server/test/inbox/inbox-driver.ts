import { getThread } from "@omnyo/db";
import {
  INBOX_CALLER_THREAD_HEADER,
  inboxSnapshotSchema,
  turnScope,
  type InboxEntry,
  type InboxSnapshot,
  type Thread,
} from "@omnyo/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@omnyo/host-daemon-contract";
import { expect } from "vitest";
import { z } from "zod";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { stubHostArtifact } from "../helpers/provider-registry.js";

export interface InboxWorld {
  harness: TestAppHarness;
  sessionId: string;
  projectId: string;
  environmentId: string;
  providerThreadIds: Map<string, string>;
  turnCounter: { value: number };
}

export function seedInboxWorld(
  harness: TestAppHarness,
  hostId: string,
): InboxWorld {
  const { host, session } = seedHostSession(harness.deps, { id: hostId });
  const registration = harness.deps.providerRegistry.get("codex");

  if (registration === null) throw new Error("Inbox Codex fixture is missing");
  harness.deps.pluginHostArtifacts.set(
    registration.pluginId,
    stubHostArtifact(registration.pluginId),
  );
  const path = `/tmp/inbox-${hostId}`;

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path,
    status: "ready",
  });

  return {
    harness,
    sessionId: session.id,
    projectId: project.id,
    environmentId: environment.id,
    providerThreadIds: new Map(),
    turnCounter: { value: 0 },
  };
}

export function seedChat(
  world: InboxWorld,
  args: {
    lifecycleOwnerThreadId?: string;
    parentThreadId?: string;
    visibility?: "visible" | "hidden";
  } = {},
): Thread {
  const thread = seedThread(world.harness.deps, {
    projectId: world.projectId,
    environmentId: world.environmentId,
    status: "idle",
    ...(args.parentThreadId ? { parentThreadId: args.parentThreadId } : {}),
    ...(args.lifecycleOwnerThreadId
      ? { lifecycleOwnerThreadId: args.lifecycleOwnerThreadId }
      : {}),
    ...(args.visibility ? { visibility: args.visibility } : {}),
  });

  const providerThreadId = `provider-${thread.id}`;

  seedThreadRuntimeState(world.harness.deps, {
    environmentId: world.environmentId,
    providerThreadId,
    threadId: thread.id,
  });
  world.providerThreadIds.set(thread.id, providerThreadId);

  return thread;
}

export async function postDaemonEvents(
  world: InboxWorld,
  envelopes: HostDaemonEventEnvelope[],
): Promise<void> {
  const response = await world.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(world.harness),
    body: JSON.stringify({
      sessionId: world.sessionId,
      eventGroups: groupHostDaemonEvents(envelopes),
    }),
  });

  expect(response.status).toBe(200);
}

export interface RunningTurn {
  threadId: string;
  turnId: string;
}

function providerThreadOf(world: InboxWorld, threadId: string): string {
  const id = world.providerThreadIds.get(threadId);

  if (id === undefined) throw new Error(`unknown chat ${threadId}`);

  return id;
}

export function pendingSubmitCount(
  world: InboxWorld,
  threadId: string,
): number {
  return listQueuedThreadCommands(world.harness, "turn.submit", threadId)
    .length;
}

export async function startSubmittedTurn(
  world: InboxWorld,
  threadId: string,
  options: { beforeTurnStarted?: () => Promise<void> } = {},
): Promise<RunningTurn> {
  const queued = await waitForQueuedCommand(
    world.harness,
    ({ command }) =>
      command.type === "turn.submit" && command.threadId === threadId,
  );

  if (queued.command.type !== "turn.submit")
    throw new Error("Expected a turn.submit command");

  const requestId = queued.command.requestId;

  await reportQueuedCommandSuccess(world.harness, queued, {
    trace: { spans: [] },
  });
  await options.beforeTurnStarted?.();

  world.turnCounter.value += 1;

  const turnId = `turn-${world.turnCounter.value}`;
  const providerThreadId = providerThreadOf(world, threadId);

  await postDaemonEvents(world, [
    {
      threadId,
      event: {
        type: "turn/started",
        threadId,
        providerThreadId,
        scope: turnScope(turnId),
      },
    },
    {
      threadId,
      event: {
        type: "turn/input/accepted",
        threadId,
        providerThreadId,
        scope: turnScope(turnId),
        clientRequestId: requestId,
      },
    },
  ]);

  return { threadId, turnId };
}

export async function acceptSteer(
  world: InboxWorld,
  turn: RunningTurn,
): Promise<void> {
  const queued = await waitForQueuedCommand(
    world.harness,
    ({ command }) =>
      command.type === "turn.submit" && command.threadId === turn.threadId,
  );

  if (queued.command.type !== "turn.submit")
    throw new Error("Expected a turn.submit command");

  const requestId = queued.command.requestId;

  await reportQueuedCommandSuccess(world.harness, queued, {
    trace: { spans: [] },
  });
  await postDaemonEvents(world, [
    {
      threadId: turn.threadId,
      event: {
        type: "turn/input/accepted",
        threadId: turn.threadId,
        providerThreadId: providerThreadOf(world, turn.threadId),
        scope: turnScope(turn.turnId),
        clientRequestId: requestId,
      },
    },
  ]);
}

export async function endTurn(
  world: InboxWorld,
  turn: RunningTurn,
  status: "completed" | "failed" | "interrupted",
): Promise<void> {
  await postDaemonEvents(world, [
    {
      threadId: turn.threadId,
      event: {
        type: "turn/completed",
        threadId: turn.threadId,
        providerThreadId: providerThreadOf(world, turn.threadId),
        status,
        ...(status === "failed"
          ? { error: { message: "Provider overloaded" } }
          : {}),
        scope: turnScope(turn.turnId),
      },
    },
  ]);
}

export async function ownerSend(
  world: InboxWorld,
  threadId: string,
  text: string,
): Promise<unknown> {
  const response = await world.harness.app.request(
    `/api/v1/threads/${threadId}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: [{ type: "text", text, mentions: [] }],
        mode: "auto",
      }),
    },
  );

  const error =
    response.status === 200
      ? null
      : z
          .object({
            code: z.string().regex(/^[a-z_]{1,64}$/u),
            message: z.string().max(1000),
          })
          .parse(await response.clone().json());

  expect(response.status, JSON.stringify(error)).toBe(200);

  return response.json();
}

export async function agentRequest(
  world: InboxWorld,
  callerThreadId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return world.harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INBOX_CALLER_THREAD_HEADER]: callerThreadId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function ownerRequest(
  world: InboxWorld,
  path: string,
  body: unknown,
): Promise<Response> {
  return world.harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function snapshot(world: InboxWorld): Promise<InboxSnapshot> {
  const response = await world.harness.app.request("/api/v1/inbox");

  expect(response.status).toBe(200);

  return inboxSnapshotSchema.parse(await response.json());
}

export function entryOf(
  inbox: InboxSnapshot,
  threadId: string,
): InboxEntry | null {
  return (
    [...inbox.inbox, ...inbox.waiting, ...inbox.running, ...inbox.shelf].find(
      (entry) => entry.threadId === threadId,
    ) ?? null
  );
}

export function statusOf(world: InboxWorld, threadId: string): string | null {
  return getThread(world.harness.db, threadId)?.status ?? null;
}
