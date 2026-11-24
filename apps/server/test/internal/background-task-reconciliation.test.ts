import {
  closeSession,
  events,
  getLatestThreadSequence,
  getStoredProviderSession,
  getThread,
  hostDaemonSessions,
  listActiveBackgroundTaskCountsByThreadIds,
  listEvents,
  listQueuedThreadMessages,
  isThreadQueueAutoSendPaused,
  threads,
} from "@omnyo/db";
import { eq } from "drizzle-orm";
import { HOST_RECONNECT_GRACE_MS } from "../../src/constants.js";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  groupHostDaemonEvents,
  hostDaemonServerWsMessageSchema,
  type HostDaemonEventEnvelope,
} from "@omnyo/host-daemon-contract";
import {
  createStandaloneBuiltinCompactCommandInput,
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
} from "@omnyo/domain";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { settleDanglingBackgroundTasks } from "../../src/services/threads/background-task-reconciliation.js";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import {
  hasLiveThreadStopInFlight,
  reconcileDaemonReportedThreads,
} from "../../src/services/threads/thread-lifecycle.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { isQueuedMessageHeldByFailurePause } from "../../src/services/threads/queued-messages.js";
import { setServerUpdateDraining } from "../../src/services/system/server-update-drain.js";
import { onDaemonSocketOpen } from "../../src/ws/daemon-protocol.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { createUserQuestionPayload } from "../helpers/pending-interactions.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const HOST_DISCONNECTED_FOR_MS = 10 * 60_000;

function backgroundTaskItemData(args: {
  itemId: string;
  taskStatus: string;
  status: string;
}): Record<string, unknown> {
  return {
    providerThreadId: "claude-session-1",
    item: {
      id: args.itemId,
      type: "backgroundTask",
      taskType: "local_workflow",
      description: "fixture workflow",
      status: args.status,
      taskStatus: args.taskStatus,
      skipTranscript: false,
      workflowName: "fixture-mini",
      usage: { totalTokens: 100, toolUses: 2, durationMs: 1500 },
    },
  };
}

interface SeedOpenBackgroundTaskArgs {
  itemId?: string;
  taskStatus?: string;
  status?: string;
}

function seedOpenBackgroundTaskThread(
  harness: TestAppHarness,
  args: SeedOpenBackgroundTaskArgs = {},
) {
  const fixture = seedThreadFixture(harness, {});
  const itemId = args.itemId ?? "wf-1";
  seedStoredEvent(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    sequence: 1,
    type: "turn/started",
    scope: turnScope("turn-1"),
    providerThreadId: "claude-session-1",
    data: { providerThreadId: "claude-session-1" },
  });
  seedStoredEvent(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    sequence: 2,
    type: "item/started",
    scope: turnScope("turn-1"),
    providerThreadId: "claude-session-1",
    itemId,
    itemKind: "backgroundTask",
    data: backgroundTaskItemData({
      itemId,
      status: "pending",
      taskStatus: "running",
    }),
  });
  seedStoredEvent(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    sequence: 3,
    type: "item/backgroundTask/progress",
    scope: threadScope(),
    providerThreadId: "claude-session-1",
    itemId,
    itemKind: "backgroundTask",
    data: backgroundTaskItemData({
      itemId,
      status: args.status ?? "pending",
      taskStatus: args.taskStatus ?? "running",
    }),
  });

  return { ...fixture, itemId };
}

function seedActiveTurnThread(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, {
    thread: { status: "active" },
  });

  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    threadId: fixture.thread.id,
    turnId: "turn-live-1",
  });

  return fixture;
}

function seedRecoverableActiveTurnThread(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, {
    thread: { status: "active" },
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: "provider-recoverable-turn",
    inputText: "Do not repeat this original request",
    model: "gpt-5",
    permissionMode: "auto",
    reasoningLevel: "high",
    serviceTier: "default",
  });
  seedTurnStarted(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: "provider-recoverable-turn",
    turnId: "recoverable-turn",
  });

  return fixture;
}

async function reopenSessionWithoutThreads(
  harness: TestAppHarness,
  session: { hostId: string; instanceId: string },
): Promise<string> {
  const response = await harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: session.hostId }),
    body: JSON.stringify({
      hostId: session.hostId,
      instanceId: session.instanceId,
      hostName: "Test Host",
      hasMachineCredential: false,
      platform: "darwin",
      dataDir: "/tmp/host-daemon-reopened",
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: [],
      openThreadWork: [],
    }),
  });

  expect(response.status).toBe(201);

  const { sessionId } = (await response.json()) as { sessionId: string };

  return sessionId;
}

async function reopenSessionBeforeSlowSocket(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedThreadFixture>,
): Promise<string> {
  handleDaemonSocketClosed(harness.deps, { sessionId: fixture.session.id });
  harness.hub.cancelPendingDaemonDisconnect(fixture.session.id);

  const socketWait = vi
    .spyOn(harness.hub, "waitForDaemonForHost")
    .mockResolvedValue(false);

  try {
    const response = await harness.app.request("/internal/session/open", {
      method: "POST",
      headers: internalAuthHeaders(harness, { hostId: fixture.host.id }),
      body: JSON.stringify({
        hostId: fixture.host.id,
        instanceId: fixture.session.instanceId,
        hostName: fixture.host.name,
        hasMachineCredential: false,
        platform: "darwin",
        dataDir: "/tmp/host-daemon-slow-socket",
        localApiPort: null,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [{ threadId: fixture.thread.id }],
        openThreadWork: [],
      }),
    });

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(socketWait).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(hasLiveThreadStopInFlight(fixture.thread.id)).toBe(false),
    );

    const { sessionId } = (await response.json()) as { sessionId: string };

    return sessionId;
  } finally {
    socketWait.mockRestore();
  }
}

function seedStoppedTurnStillRunning(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, { thread: { status: "idle" } });

  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    threadId: fixture.thread.id,
    turnId: "turn-stopped",
  });
  seedStoredEvent(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    sequence: 2,
    type: "system/thread/interrupted",
    scope: threadScope(),
    data: { reason: "manual-stop" },
  });

  return fixture;
}

function openDaemonSocket(
  harness: TestAppHarness,
  args: { hostId: string; sessionId: string },
): void {
  onDaemonSocketOpen(harness.deps, {
    ...args,
    socket: registerTestHostRpcCapture(harness, args),
  });
}

function workflowEvent(
  threadId: string,
  type: "item/backgroundTask/progress" | "item/backgroundTask/completed",
  status: "pending" | "completed",
): HostDaemonEventEnvelope["event"] {
  return {
    type,
    threadId,
    providerThreadId: "claude-session-1",
    scope: threadScope(),
    item: {
      id: "wf-1",
      type: "backgroundTask",
      taskType: "local_workflow",
      description: "fixture workflow",
      status,
      taskStatus: status === "pending" ? "running" : "completed",
      skipTranscript: false,
      workflowName: "fixture-mini",
    },
  };
}

async function postWorkflowEvents(
  harness: TestAppHarness,
  args: {
    hostId: string;
    retainedFrom?: string;
    sessionId: string;
    threadId: string;
  },
  workflowEvents: HostDaemonEventEnvelope["event"][],
): Promise<void> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(
        workflowEvents.map((event) => ({ threadId: args.threadId, event })),
      ),
      ...(args.retainedFrom === undefined
        ? {}
        : { firstEventIndex: 1, sourceInstanceId: args.retainedFrom }),
    }),
  });

  expect(response.status).toBe(200);
}

function activeWorkflowCount(harness: TestAppHarness, threadId: string) {
  return (
    listActiveBackgroundTaskCountsByThreadIds(harness.deps.db, {
      threadIds: [threadId],
    })[0]?.activeWorkflowCount ?? 0
  );
}

function countStoredEvents(
  harness: TestAppHarness,
  threadId: string,
  type: string,
): number {
  return listEvents(harness.deps.db, { threadId }).filter(
    (row) => row.type === type,
  ).length;
}

function listSettledBackgroundTaskItems(
  harness: TestAppHarness,
  threadId: string,
): Array<{ status: string; taskStatus: string }> {
  return listEvents(harness.deps.db, { threadId })
    .filter((row) => row.type === "item/backgroundTask/completed")
    .map((row) => {
      const { item } = JSON.parse(row.data) as {
        item: { status: string; taskStatus: string };
      };

      return { status: item.status, taskStatus: item.taskStatus };
    });
}

describe("settleDanglingBackgroundTasks", () => {
  it("provider session ended persists one failed turn and interrupted reporting without replaying independent work", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);
      const independent = seedOpenBackgroundTaskThread(harness);

      const queued = seedQueuedMessage(harness.deps, {
        threadId: independent.thread.id,
        content: [
          { type: "text", text: "Existing independent work", mentions: [] },
        ],
        waitingOn: {
          kind: "plugin",
          pluginId: "existing-owner",
          reason: "Keep existing hold",
        },
      });

      const providerThreadId = "provider-turn-live-1";

      for (const [ownerThread, turnId] of [
        [thread, "turn-live-1"],
        [independent.thread, "turn-1"],
      ] as const) {
        expect(
          harness.deps.pendingInteractions.registerPendingInteraction({
            interaction: {
              threadId: ownerThread.id,
              turnId,
              providerId: "codex",
              providerThreadId,
              providerRequestId: `question-${ownerThread.id}`,
              payload: createUserQuestionPayload(),
            },
          }).outcome,
        ).toBe("created");
      }

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/started",
        scope: turnScope("other-provider-turn"),
        providerThreadId,
        data: { providerThreadId, parentToolCallId: "independent-tool" },
      });
      expect(
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "other-provider-turn",
            providerId: "codex",
            providerThreadId,
            providerRequestId: "other-turn-question",
            payload: createUserQuestionPayload(),
          },
        }).outcome,
      ).toBe("created");
      const pluginController = new AbortController();

      const pluginResult =
        harness.deps.pendingInteractions.requestPluginInteraction({
          pluginId: "existing-plugin",
          owner: { pluginId: "existing-plugin" },
          threadId: thread.id,
          rendererId: "synthetic-question",
          title: "Independent plugin input",
          payload: {},
          presentation: {
            label: { pending: "Waiting", completed: "Answered" },
            icon: { glyph: "MessageQuestion" },
          },
          describeSubmission: null,
          timeoutMs: 10000,
          signal: pluginController.signal,
        });

      onTestFinished(async () => {
        pluginController.abort();
        await pluginResult;
      });

      const background = {
        id: "provider-shell",
        type: "backgroundTask" as const,
        taskType: "local_bash",
        description: "Synthetic provider shell",
        status: "pending" as const,
        taskStatus: "running" as const,
        skipTranscript: false,
      };

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "item/started",
                threadId: thread.id,
                providerThreadId,
                scope: turnScope("turn-live-1"),
                item: background,
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId,
                scope: turnScope("turn-live-1"),
                status: "failed",
                error: {
                  message:
                    "Provider reporting ended; execution outcome is unknown",
                },
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "item/backgroundTask/completed",
                threadId: thread.id,
                providerThreadId,
                scope: threadScope(),
                item: {
                  ...background,
                  status: "interrupted",
                  taskStatus: "stopped",
                  summary:
                    "Provider reporting ended; execution outcome is unknown",
                },
              },
            },
          ]),
        }),
      });

      expect(response.status).toBe(200);
      const stored = listEvents(harness.db, { threadId: thread.id });
      expect(
        stored.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(1);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
      expect(getThread(harness.db, thread.id)?.status).toBe("error");

      const remaining =
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );

      expect(remaining).toHaveLength(2);
      expect(remaining).toContainEqual(
        expect.objectContaining({ turnId: "other-provider-turn" }),
      );
      expect(remaining).toContainEqual(
        expect.objectContaining({
          origin: expect.objectContaining({
            kind: "plugin",
            pluginId: "existing-plugin",
          }),
        }),
      );
      expect(
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          independent.thread.id,
        ),
      ).toHaveLength(1);
      expect(
        listSettledBackgroundTaskItems(harness, independent.thread.id),
      ).toEqual([]);
      expect(
        listQueuedThreadMessages(harness.db, independent.thread.id).map(
          (message) => message.id,
        ),
      ).toEqual([queued.id]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("settles open backgroundTask items as interrupted and is idempotent", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });

      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-1"),
        providerThreadId: "claude-session-1",
        data: { providerThreadId: "claude-session-1" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope("turn-1"),
        providerThreadId: "claude-session-1",
        itemId: "wf-1",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "wf-1",
          status: "pending",
          taskStatus: "running",
        }),
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 3,
        type: "item/backgroundTask/progress",
        scope: threadScope(),
        providerThreadId: "claude-session-1",
        itemId: "wf-1",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "wf-1",
          status: "pending",
          taskStatus: "running",
        }),
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      const rows = listEvents(harness.deps.db, { threadId: thread.id });

      const completed = rows.filter(
        (row) => row.type === "item/backgroundTask/completed",
      );

      expect(completed).toHaveLength(1);

      const data = JSON.parse(completed[0]!.data) as {
        item: { status: string; taskStatus: string; workflowName: string };
      };

      expect(data.item.status).toBe("interrupted");
      expect(data.item.taskStatus).toBe("stopped");
      expect(data.item.workflowName).toBe("fixture-mini");

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });
      expect(
        listEvents(harness.deps.db, { threadId: thread.id }).filter(
          (row) => row.type === "item/backgroundTask/completed",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not touch already-settled tasks or other hosts", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

      const otherHost = seedHost(harness.deps, {
        id: "host_other",
        name: "Other Host",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });

      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-1"),
        data: { providerThreadId: "claude-session-1" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope("turn-1"),
        itemId: "wf-done",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "wf-done",
          status: "pending",
          taskStatus: "running",
        }),
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 3,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        itemId: "wf-done",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "wf-done",
          status: "completed",
          taskStatus: "completed",
        }),
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: otherHost.id });
      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      const completed = listEvents(harness.deps.db, {
        threadId: thread.id,
      }).filter((row) => row.type === "item/backgroundTask/completed");

      expect(completed).toHaveLength(1);

      const data = JSON.parse(completed[0]!.data) as {
        item: { status: string };
      };

      expect(data.item.status).toBe("completed");
    });
  });

  it("settles again a task the provider reported running after an earlier settlement", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, itemId, thread } =
        seedOpenBackgroundTaskThread(harness);

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 4,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        providerThreadId: "claude-session-1",
        itemId,
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId,
          status: "interrupted",
          taskStatus: "stopped",
        }),
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 5,
        type: "item/backgroundTask/progress",
        scope: threadScope(),
        providerThreadId: "claude-session-1",
        itemId,
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId,
          status: "pending",
          taskStatus: "running",
        }),
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });
      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });

  it("preserves an already-finished task status instead of stomping it to interrupted", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedOpenBackgroundTaskThread(harness, {
        status: "completed",
        taskStatus: "completed",
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "completed", taskStatus: "completed" },
      ]);
    });
  });
});

describe("background-task lifecycle reconciliation triggers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles open tasks when a restarted daemon re-registers after its previous session already closed", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-settle-restart",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          openThreadWork: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });

  it("does not settle tasks the same daemon instance still runs when it reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-1",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-settle-same-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          openThreadWork: [
            {
              threadId: thread.id,
              backgroundItemIds: ["task:wf-1"],
              interactiveRequests: [],
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);
    });
  });

  it("settles a task the same daemon instance no longer runs when it reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-1",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-settle-same-instance-gone",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          openThreadWork: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });

  it("keeps a task the same daemon instance no longer reports while the thread's buffered events are still arriving", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-1",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-settle-same-instance-buffered",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          openThreadWork: [],
          undeliveredEventThreadIds: [thread.id],
        }),
      });

      expect(response.status).toBe(201);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);
    });
  });

  it("does not tell a live daemon to shut down when that same instance reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);
      const previousSocket = createMockHubSocket();
      harness.deps.hub.registerDaemon(session.id, host.id, previousSocket);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-live-same-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          openThreadWork: [
            {
              threadId: thread.id,
              backgroundItemIds: ["task:wf-1"],
              interactiveRequests: [],
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(
        previousSocket.messages.map((message) =>
          hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
        ),
      ).toEqual([
        { type: "command-catalog-retain", scopes: [] },
        {
          type: "diagnostics-policy.replace",
          policy: { revision: expect.any(Number), crashReportsEnabled: true },
        },
        {
          type: "machine-environment.replace",
          environment: { revision: expect.any(Number), entries: [] },
        },
      ]);
      expect(previousSocket.closed).toEqual([
        { code: 1000, reason: "replaced" },
      ]);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);
    });
  });

  it("still tells a superseded daemon instance to shut down", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);
      const previousSocket = createMockHubSocket();
      harness.deps.hub.registerDaemon(session.id, host.id, previousSocket);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-live-restarted",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          openThreadWork: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(
        previousSocket.messages.map((message) =>
          hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
        ),
      ).toEqual([
        { type: "command-catalog-retain", scopes: [] },
        {
          type: "diagnostics-policy.replace",
          policy: { revision: expect.any(Number), crashReportsEnabled: true },
        },
        {
          type: "machine-environment.replace",
          environment: { revision: expect.any(Number), entries: [] },
        },
        { type: "session-close", reason: "replaced" },
      ]);
      expect(previousSocket.closed).toEqual([
        { code: 1000, reason: "replaced" },
      ]);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });

  it("keeps open tasks while the host stays disconnected", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedOpenBackgroundTaskThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      vi.advanceTimersByTime(HOST_DISCONNECTED_FOR_MS);

      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);
      harness.hub.cancelPendingDaemonDisconnect(session.id);
    });
  });

  it("drops a previous daemon instance's retained pending progress for a task its restart settled", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const sessionId = await reopenSessionWithoutThreads(harness, {
        hostId: host.id,
        instanceId: "instance-restarted",
      });

      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);

      const progressType = "item/backgroundTask/progress";

      const progressBefore = countStoredEvents(
        harness,
        thread.id,
        progressType,
      );

      await postWorkflowEvents(
        harness,
        {
          hostId: host.id,
          retainedFrom: session.instanceId,
          sessionId,
          threadId: thread.id,
        },
        [workflowEvent(thread.id, progressType, "pending")],
      );

      expect(countStoredEvents(harness, thread.id, progressType)).toBe(
        progressBefore,
      );
      expect(activeWorkflowCount(harness, thread.id)).toBe(0);
    });
  });

  it("stores a previous daemon instance's retained settled progress after its restart settled the task", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);
      const progressType = "item/backgroundTask/progress";

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const sessionId = await reopenSessionWithoutThreads(harness, {
        hostId: host.id,
        instanceId: "instance-restarted",
      });

      const progressBefore = countStoredEvents(
        harness,
        thread.id,
        progressType,
      );

      await postWorkflowEvents(
        harness,
        {
          hostId: host.id,
          retainedFrom: session.instanceId,
          sessionId,
          threadId: thread.id,
        },
        [
          workflowEvent(thread.id, progressType, "completed"),
          workflowEvent(
            thread.id,
            "item/backgroundTask/completed",
            "completed",
          ),
        ],
      );

      expect(countStoredEvents(harness, thread.id, progressType)).toBe(
        progressBefore + 1,
      );
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
      expect(activeWorkflowCount(harness, thread.id)).toBe(0);
    });
  });
});

describe("active thread disconnect reconciliation triggers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not interrupt active turns when the same daemon instance reconnects with the thread active", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);

      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-1",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-active-same-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
          openThreadWork: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id })
          .filter((row) => row.type !== "turn/started")
          .map((row) => row.type),
      ).toEqual([]);
    });
  });

  it.each(["instance-1", "instance-restarted"])(
    "distinguishes a missing turn from a daemon restart for %s",
    async (instanceId) => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } = seedActiveTurnThread(harness);

        handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

        const response = await harness.app.request("/internal/session/open", {
          method: "POST",
          headers: internalAuthHeaders(harness, {
            hostId: host.id,
          }),
          body: JSON.stringify({
            hostId: host.id,
            instanceId,
            hostName: host.name,
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-daemon-active-restarted-instance",
            localApiPort: null,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            activeThreads: [],
            openThreadWork: [],
          }),
        });

        expect(response.status).toBe(201);
        expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");

        const rows = listEvents(harness.deps.db, {
          threadId: thread.id,
        }).filter((row) => row.type !== "turn/started");

        expect(rows.map((row) => row.type)).toEqual([
          "turn/completed",
          "system/error",
          "system/thread/interrupted",
        ]);
        expect(JSON.parse(rows[0]!.data)).toMatchObject({
          status: "interrupted",
        });
        expect(JSON.parse(rows[1]!.data)).toMatchObject({
          code: "thread_command_failed",
          message:
            instanceId === "instance-1"
              ? "Thread interrupted because the connection to the host was lost"
              : "Thread interrupted because the host daemon disconnected",
          detail: "Please retry the thread to continue.",
        });
        expect(JSON.parse(rows[2]!.data)).toEqual({
          reason: "host-daemon-restarted",
          ...(instanceId === "instance-1"
            ? { cause: "host-connection-lost" }
            : {}),
        });
      });
    },
  );

  it.each(["instance-1", "instance-restarted"])(
    "persists one continuation for a lost accepted turn across repeated reconnects: %s",
    async (instanceId) => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } =
          seedRecoverableActiveTurnThread(harness);

        handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
        vi.useFakeTimers();

        const reconnect = { hostId: host.id, instanceId };
        await reopenSessionWithoutThreads(harness, reconnect);
        await reopenSessionWithoutThreads(harness, reconnect);

        const queued = listQueuedThreadMessages(harness.db, thread.id);
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({
          payloadKind: "continuation",
          model: "gpt-5",
          permissionMode: "auto",
          reasoningLevel: "high",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
        });
        expect(JSON.parse(queued[0]!.content)).toEqual([
          {
            type: "text",
            text: "Please continue.",
            mentions: [],
            visibility: "agent-only",
          },
        ]);
        expect(
          listEvents(harness.db, { threadId: thread.id }).filter(
            (event) => event.type === "client/turn/requested",
          ),
        ).toHaveLength(1);
      });
    },
  );

  it.each([
    { minutesAgo: 10, continued: false },
    { minutesAgo: 31, continued: true },
  ])(
    "automatically continues a lost turn only once per restart window: $minutesAgo minutes after the previous restart",
    async ({ minutesAgo, continued }) => {
      await withTestHarness(async (harness) => {
        const { environment, host, session, thread } =
          seedRecoverableActiveTurnThread(harness);

        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          sequence:
            getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
          type: "system/thread/interrupted",
          scope: threadScope(),
          createdAt: Date.now() - minutesAgo * 60_000,
          data: { reason: "host-daemon-restarted" },
        });

        handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
        await reopenSessionWithoutThreads(harness, {
          hostId: host.id,
          instanceId: "instance-restarted",
        });

        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(
          continued ? 1 : 0,
        );
      });
    },
  );

  it.each([
    "live",
    "held-events",
    "completed",
    "callback-wait",
    "manual-stop",
    "manual-stop-with-queue",
    "queued",
    "interaction",
    "archived",
    "hidden",
    "foreign-session",
    "missing-request",
    "builtin-compact",
  ] as const)("does not automatically continue %s work", async (state) => {
    await withTestHarness(async (harness) => {
      const { host, session, environment, thread } =
        state === "missing-request"
          ? seedActiveTurnThread(harness)
          : seedRecoverableActiveTurnThread(harness);

      const activeThreadIds = state === "live" ? [thread.id] : [];

      const undeliveredEventThreadIds =
        state === "held-events" ? [thread.id] : [];

      if (state === "builtin-compact") {
        const request = listEvents(harness.db, { threadId: thread.id }).find(
          (event) => event.type === "client/turn/requested",
        )!;

        const data = turnRequestEventDataSchema.parse(JSON.parse(request.data));
        harness.db
          .update(events)
          .set({
            data: JSON.stringify({
              ...data,
              input: createStandaloneBuiltinCompactCommandInput(),
            }),
          })
          .where(eq(events.id, request.id))
          .run();
      }

      if (state === "completed" || state === "callback-wait") {
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-recoverable-turn",
          sequence:
            getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
          type: "turn/completed",
          scope: turnScope("recoverable-turn"),
          data: {
            providerThreadId: "provider-recoverable-turn",
            status: "completed",
          },
        });
      }

      if (state === "callback-wait" || state === "archived")
        harness.db
          .update(threads)
          .set(
            state === "callback-wait"
              ? { status: "idle" }
              : { archivedAt: Date.now() - 60_000 },
          )
          .where(eq(threads.id, thread.id))
          .run();

      if (state === "hidden")
        harness.db
          .update(threads)
          .set({ visibility: "hidden" })
          .where(eq(threads.id, thread.id))
          .run();

      if (state === "foreign-session") {
        const owner = seedThread(harness.deps, {
          projectId: thread.projectId,
          environmentId: environment.id,
        });

        seedStoredEvent(harness.deps, {
          threadId: owner.id,
          environmentId: environment.id,
          providerThreadId: "provider-recoverable-turn",
          createdAt: 1,
          sequence: 1,
          type: "thread/identity",
          scope: threadScope(),
          data: {},
        });
        expect(getStoredProviderSession(harness.db, thread.id).kind).toBe(
          "foreign",
        );
      }

      if (state === "manual-stop" || state === "manual-stop-with-queue")
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          sequence:
            getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
          type: "system/thread/interrupted",
          scope: threadScope(),
          data: { reason: "manual-stop" },
        });

      if (state === "queued" || state === "manual-stop-with-queue")
        seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: [{ type: "text", text: "Existing held work", mentions: [] }],
          waitingOn: {
            kind: "plugin",
            pluginId: "existing-owner",
            reason: "Keep this hold",
          },
        });

      if (state === "interaction")
        expect(
          harness.deps.pendingInteractions.registerPendingInteraction({
            interaction: {
              threadId: thread.id,
              turnId: "recoverable-turn",
              providerId: "codex",
              providerThreadId: "provider-recoverable-turn",
              providerRequestId: "recovery-question",
              payload: createUserQuestionPayload(),
            },
          }).outcome,
        ).toBe("created");

      const existingQueue = listQueuedThreadMessages(harness.db, thread.id);
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      vi.useFakeTimers();
      await reconcileDaemonReportedThreads(harness.deps, {
        hostId: host.id,
        activeThreadIds,
        undeliveredEventThreadIds,
        sameDaemonInstance: true,
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual(
        existingQueue,
      );

      if (state === "manual-stop" || state === "manual-stop-with-queue")
        expect(isThreadQueueAutoSendPaused(harness.db, thread.id)).toBe(true);
    });
  });

  it.each([false, true])(
    "holds a restart continuation behind its failure until the owner continues, and keeps it after a manual stop: %s",
    async (stopped) => {
      await withTestHarness(async (harness) => {
        const { host, thread } = seedRecoverableActiveTurnThread(harness);
        vi.useFakeTimers();
        await reconcileDaemonReportedThreads(harness.deps, {
          hostId: host.id,
          activeThreadIds: [],
          undeliveredEventThreadIds: [],
          sameDaemonInstance: true,
        });

        const [continuation] = listQueuedThreadMessages(harness.db, thread.id);

        expect(continuation).toBeDefined();
        expect(
          isQueuedMessageHeldByFailurePause(harness.db, continuation!),
        ).toBe(true);

        const requests = () =>
          listEvents(harness.db, { threadId: thread.id }).filter(
            (event) => event.type === "client/turn/requested",
          );

        setServerUpdateDraining(harness.db, true);
        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
        setServerUpdateDraining(harness.db, false);
        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });

        expect(requests()).toHaveLength(1);
        expect(
          listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
        ).toEqual([continuation!.id]);

        if (stopped) {
          const stopping = harness.app.request(
            `/api/v1/threads/${thread.id}/stop`,
            { method: "POST" },
          );

          const stop = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "thread.stop" && command.threadId === thread.id,
          );

          await reportQueuedCommandSuccess(harness, stop, {
            providerCheckpointId: null,
          });
          expect((await stopping).status).toBe(200);
          await runQueuedMessageDispatch(harness.deps, {
            kind: "idle-recovery",
            now: Date.now(),
          });

          expect(requests()).toHaveLength(1);
          expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(
            1,
          );

          return;
        }

        const continued = await harness.app.request(
          `/api/v1/threads/${thread.id}/continue`,
          { method: "POST" },
        );

        expect(continued.status).toBe(200);
        expect(requests()).toHaveLength(2);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
        expect(
          turnRequestEventDataSchema.parse(JSON.parse(requests()[1]!.data)),
        ).toMatchObject({
          initiator: "system",
          input: [{ text: "Please continue.", visibility: "agent-only" }],
          execution: {
            model: "gpt-5",
            permissionMode: "auto",
            reasoningLevel: "high",
          },
        });
      });
    },
  );

  it("queues the parent notice when a reconnect interrupts a child and the parent shares the host", async () => {
    await withTestHarness(async (harness) => {
      const {
        session,
        project,
        environment,
        thread: parent,
      } = seedThreadFixture(harness);

      seedThreadRuntimeState(harness.deps, {
        threadId: parent.id,
        environmentId: environment.id,
        providerThreadId: "parent-provider-thread",
      });

      const child = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parent.id,
        status: "active",
        title: "Worker child",
      });

      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: child.id,
        turnId: "child-turn",
      });

      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      vi.useFakeTimers();
      await reopenSessionWithoutThreads(harness, session);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.runOnlyPendingTimersAsync();

      const parentNotices = listQueuedThreadMessages(
        harness.deps.db,
        parent.id,
      );

      expect(parentNotices).toHaveLength(1);
      expect(JSON.parse(parentNotices[0]!.waitingOn!)).toEqual({
        kind: "host-offline",
        hostName: "Test Host",
      });
      expect(JSON.parse(parentNotices[0]!.systemNotice!)).toEqual({
        kind: "child-interrupted",
        subject: {
          kind: "thread",
          threadId: child.id,
          threadName: "Worker child",
          outcomes: [
            {
              threadId: child.id,
              status: "interrupted",
              interruption: {
                reason: "host-daemon-restarted",
                cause: "host-connection-lost",
              },
            },
          ],
        },
      });
      expect(JSON.stringify(parentNotices[0]!.content)).toContain(
        "because its host connection was lost",
      );
    });
  });

  it("notifies a parent on another host when a reconnect interrupts its child", async () => {
    await withTestHarness(async (harness) => {
      const {
        project,
        environment: parentEnvironment,
        thread: parent,
      } = seedThreadFixture(harness);

      seedThreadRuntimeState(harness.deps, {
        threadId: parent.id,
        environmentId: parentEnvironment.id,
        providerThreadId: "parent-provider-thread",
      });
      const { host, session } = seedHostSession(harness.deps);

      const childEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });

      const child = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: childEnvironment.id,
        parentThreadId: parent.id,
        status: "active",
        title: "Worker child",
      });

      seedTurnStarted(harness.deps, {
        environmentId: childEnvironment.id,
        threadId: child.id,
        turnId: "child-turn",
      });

      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      vi.useFakeTimers();
      await reopenSessionWithoutThreads(harness, session);
      await vi.advanceTimersByTimeAsync(2_000);

      const parentNotices = await vi.waitFor(() => {
        const notices = listEvents(harness.deps.db, {
          threadId: parent.id,
        })
          .filter((row) => row.type === "client/turn/requested")
          .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
          .filter((data) => data.initiator === "system");

        expect(notices).toHaveLength(1);

        return notices;
      });

      expect(parentNotices[0]).toMatchObject({
        systemMessageKind: "child-interrupted",
        systemMessageSubject: {
          kind: "thread",
          threadId: child.id,
          threadName: "Worker child",
          outcomes: [
            {
              threadId: child.id,
              status: "interrupted",
              interruption: {
                reason: "host-daemon-restarted",
                cause: "host-connection-lost",
              },
            },
          ],
        },
      });
      expect(JSON.stringify(parentNotices[0]?.input)).toContain(
        "because its host connection was lost",
      );
    });
  });

  it("finishes a turn that ended while the host was away once the reconnected daemon delivers its held events", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-held-events",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          openThreadWork: [],
          undeliveredEventThreadIds: [thread.id],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");

      const { sessionId } = (await response.json()) as { sessionId: string };
      const providerThreadId = "provider-turn-live-1";

      const eventsResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId,
            eventGroups: groupHostDaemonEvents([
              {
                threadId: thread.id,
                event: {
                  type: "item/completed",
                  threadId: thread.id,
                  providerThreadId,
                  scope: turnScope("turn-live-1"),
                  item: {
                    id: "msg-final",
                    type: "agentMessage",
                    text: "done",
                  },
                },
              },
              {
                threadId: thread.id,
                event: {
                  type: "turn/completed",
                  threadId: thread.id,
                  providerThreadId,
                  scope: turnScope("turn-live-1"),
                  status: "completed",
                },
              },
            ]),
          }),
        },
      );

      expect(eventsResponse.status).toBe(200);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("idle");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id }).map(
          (row) => row.type,
        ),
      ).toEqual(["turn/started", "item/completed", "turn/completed"]);
    });
  });

  it("settles a stop requested while the host is offline and stops the run when the same daemon reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      harness.hub.cancelPendingDaemonDisconnect(session.id);
      harness.deps.db
        .update(hostDaemonSessions)
        .set({ closedAt: Date.now() - HOST_RECONNECT_GRACE_MS - 1 })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      await harness.app.request(`/api/v1/threads/${thread.id}/stop`, {
        method: "POST",
      });
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("idle");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id })
          .filter((row) => row.type === "turn/completed")
          .map((row) => JSON.parse(row.data).status),
      ).toEqual(["interrupted"]);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-stop-after-reconnect",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
          openThreadWork: [],
        }),
      });

      expect(response.status).toBe(201);
      const { sessionId } = (await response.json()) as { sessionId: string };
      const commandTypes: string[] = [];
      harness.hub.registerDaemon(sessionId, host.id, {
        close() {},
        send(data) {
          const message = hostDaemonServerWsMessageSchema.parse(
            JSON.parse(data),
          );

          if (message.type === "host-rpc.request") {
            commandTypes.push(message.command.type);
          }
        },
      });

      await vi.waitFor(() => expect(commandTypes).toContain("thread.stop"));
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("idle");
    });
  });

  it("revives rather than stops a thread that started a new turn after its last stop", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, session, thread } = seedThreadFixture(
        harness,
        { thread: { status: "idle" } },
      );

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        data: { reason: "manual-stop" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "turn/started",
        scope: turnScope("turn-after-stop"),
        providerThreadId: "provider-thread-after-stop",
        data: { providerThreadId: "provider-thread-after-stop" },
      });
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      harness.hub.cancelPendingDaemonDisconnect(session.id);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-revive-after-new-turn",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
          openThreadWork: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
    });
  });

  it("re-sends a reconnect stop that missed the daemon once its socket opens", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedStoppedTurnStillRunning(harness);
      const sessionId = await reopenSessionBeforeSlowSocket(harness, fixture);

      expect(getThread(harness.deps.db, fixture.thread.id)?.status).toBe(
        "idle",
      );
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toEqual([]);

      openDaemonSocket(harness, { hostId: fixture.host.id, sessionId });

      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );

      expect(stop.command).toMatchObject({
        environmentId: fixture.environment.id,
        intent: "interrupt",
      });
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toHaveLength(1);

      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      await vi.waitFor(() =>
        expect(hasLiveThreadStopInFlight(fixture.thread.id)).toBe(false),
      );
      expect(getThread(harness.deps.db, fixture.thread.id)?.status).toBe(
        "idle",
      );
    });
  });

  it("does not re-send a missed stop once a newer run was requested", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedStoppedTurnStillRunning(harness);
      const sessionId = await reopenSessionBeforeSlowSocket(harness, fixture);

      seedStoredEvent(harness.deps, {
        threadId: fixture.thread.id,
        environmentId: fixture.environment.id,
        sequence:
          getLatestThreadSequence(harness.deps.db, {
            threadId: fixture.thread.id,
          }) + 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: turnRequestEventDataSchema.parse({
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 3 }),
          input: [{ type: "text", text: "Next task" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        }),
      });

      openDaemonSocket(harness, { hostId: fixture.host.id, sessionId });

      expect(hasLiveThreadStopInFlight(fixture.thread.id)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toEqual([]);
    });
  });

  it("keeps an active turn running while the host stays disconnected", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedActiveTurnThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      await vi.advanceTimersByTimeAsync(HOST_DISCONNECTED_FOR_MS);

      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id })
          .filter((row) => row.type !== "turn/started")
          .map((row) => row.type),
      ).toEqual([]);
      harness.hub.cancelPendingDaemonDisconnect(session.id);
    });
  });
});
