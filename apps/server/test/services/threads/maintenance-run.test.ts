import { describe, expect, it } from "vitest";
import {
  getLastStoredTurnRequestEvent,
  getLatestThreadSequence,
  getThread,
  getThreadConversationSequences,
  getThreadExecutionOverride,
  setThreadExecutionOverride,
} from "@omnyo/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  turnScope,
} from "@omnyo/domain";
import { compactThreadContext } from "../../../src/services/threads/dispatch-attempt.js";
import { applyLoggedThreadLifecycleEvent } from "../../../src/services/threads/lifecycle-outcome.js";
import {
  countActiveMaintenanceRuns,
  getLatestMaintenanceRequest,
  isMaintenanceRunActive,
  readAutoCompactionMetadata,
} from "../../../src/services/threads/maintenance-run.js";
import { parseStoredTurnRequestEvent } from "../../../src/services/threads/thread-events.js";
import { availableModelFixture } from "../../helpers/available-models.js";
import {
  currentWorkspaceIdentity,
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const providerThreadId = "provider-thread-maintenance";

function seedIdleClaudeThread(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps);

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });

  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: "claude-code",
    status: "idle",
  });

  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId,
    threadId: thread.id,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    providerThreadId,
    threadId: thread.id,
    turnId: "turn-owner",
  });

  const responder = registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle: ({ command }): HostRpcHandlerResult => {
      if (command.type === "host.prepare_workspace_identity_v1") {
        return { ok: true, result: currentWorkspaceIdentity(command.rootPath) };
      }

      if (command.type === "host.read_workspace_agent_context") {
        return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
      }

      if (command.type === "provider.list_models") {
        return {
          ok: true,
          result: {
            models: [
              availableModelFixture({
                model: "claude-opus-4-8[1m]",
                reasoningLevels: ["low", "high"],
              }),
              availableModelFixture({
                model: "claude-sonnet-5",
                reasoningLevels: ["low", "high"],
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        };
      }

      if (command.type === "turn.submit") {
        return { ok: true, result: { trace: { spans: [] } } };
      }

      return { ok: true, result: {} };
    },
  });

  return { environment, responder, thread };
}

function latestRequest(harness: TestAppHarness, threadId: string) {
  const row = getLastStoredTurnRequestEvent(harness.db, threadId);

  if (row === null) throw new Error("Expected a stored turn request");

  return { sequence: row.sequence, data: parseStoredTurnRequestEvent(row) };
}

function requireThread(harness: TestAppHarness, threadId: string) {
  const thread = getThread(harness.db, threadId);

  if (thread === null) throw new Error("Expected the thread");

  return thread;
}

describe("maintenance compaction runs", () => {
  it("marks the request as system maintenance, pins execution and keeps the owner's state", async () => {
    await withTestHarness(async (harness) => {
      const { environment, responder, thread } = seedIdleClaudeThread(harness);
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "claude-sonnet-5",
        reasoningLevelOverride: "low",
      });

      const before = requireThread(harness, thread.id);

      const conversationBefore = getThreadConversationSequences(harness.db, [
        thread.id,
      ])[thread.id];

      await compactThreadContext(harness.deps, before, {
        maintenance: "auto-compaction",
        execution: {
          model: "claude-opus-4-8[1m]",
          reasoningLevel: "high",
          serviceTier: "default",
        },
      });

      const request = latestRequest(harness, thread.id);

      expect(request.data).toMatchObject({
        initiator: "system",
        maintenance: "auto-compaction",
        senderThreadId: null,
        input: createStandaloneBuiltinCompactCommandInput(),
        execution: { model: "claude-opus-4-8[1m]", reasoningLevel: "high" },
      });
      expect(request.data.systemMessageKind).toBe("unlabeled");
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "claude-sonnet-5",
        reasoningLevelOverride: "low",
      });

      const submits = responder.requests.filter(
        ({ command }) => command.type === "turn.submit",
      );

      expect(submits).toHaveLength(1);
      expect(submits[0]?.command).toMatchObject({
        type: "turn.submit",
        input: createStandaloneBuiltinCompactCommandInput(),
        options: { model: "claude-opus-4-8[1m]", reasoningLevel: "high" },
      });

      expect(readAutoCompactionMetadata(harness.db, thread.id)).toEqual({
        disabled: false,
        basisSnapshot: {
          requestSequence: request.sequence,
          lastInput: conversationBefore?.lastInput ?? -1,
          lastStarted: conversationBefore?.lastStarted ?? -1,
          lastCompleted: conversationBefore?.lastCompleted ?? -1,
        },
        lastOutcome: null,
      });
      expect(conversationBefore?.lastStarted).toBeGreaterThan(0);

      const after = requireThread(harness, thread.id);

      expect(after.lastReadAt).toBe(before.lastReadAt);
      expect(after.latestAttentionAt).toBe(before.latestAttentionAt);
      expect(after.status).toBe("active");

      expect(getLatestMaintenanceRequest(harness.db, thread.id)).toEqual({
        sequence: request.sequence,
        kind: "auto-compaction",
        turnId: null,
      });

      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId,
        threadId: thread.id,
        turnId: "turn-maintenance",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/input/accepted",
        scope: turnScope("turn-maintenance"),
        data: { providerThreadId, clientRequestId: request.data.requestId },
      });

      expect(getLatestMaintenanceRequest(harness.db, thread.id)?.turnId).toBe(
        "turn-maintenance",
      );
      expect(isMaintenanceRunActive(harness.db, after)).toBe(true);
      expect(countActiveMaintenanceRuns(harness.db)).toBe(1);

      expect(
        applyLoggedThreadLifecycleEvent(harness.deps, {
          threadId: thread.id,
          event: { type: "run.succeeded" },
        }).applied,
      ).toBe(true);

      const finished = requireThread(harness, thread.id);

      expect(finished.status).toBe("idle");
      expect(isMaintenanceRunActive(harness.db, finished)).toBe(false);
      expect(countActiveMaintenanceRuns(harness.db)).toBe(0);
      expect(getLatestMaintenanceRequest(harness.db, thread.id)?.sequence).toBe(
        request.sequence,
      );
    });
  });

  it("refuses a maintenance compaction whose preflight rejects inside the append transaction", async () => {
    await withTestHarness(async (harness) => {
      const { responder, thread } = seedIdleClaudeThread(harness);

      const sequenceBefore = getLatestThreadSequence(harness.db, {
        threadId: thread.id,
      });

      await expect(
        compactThreadContext(harness.deps, thread, {
          maintenance: "auto-compaction",
          execution: {
            model: "claude-opus-4-8[1m]",
            reasoningLevel: "high",
            serviceTier: "default",
          },
          beforeAppendInTransaction: () => {
            throw new Error("superseded");
          },
        }),
      ).rejects.toThrow("superseded");

      expect(getLatestThreadSequence(harness.db, { threadId: thread.id })).toBe(
        sequenceBefore,
      );
      expect(
        readAutoCompactionMetadata(harness.db, thread.id).basisSnapshot,
      ).toBeNull();
      expect(
        responder.requests.some(
          ({ command }) => command.type === "turn.submit",
        ),
      ).toBe(false);
      expect(requireThread(harness, thread.id).status).toBe("idle");
    });
  });

  it("leaves a manual compaction an owner turn", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedIdleClaudeThread(harness);
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "claude-sonnet-5",
        reasoningLevelOverride: "low",
      });

      await compactThreadContext(harness.deps, thread);

      const request = latestRequest(harness, thread.id);

      expect(request.data.initiator).toBe("user");
      expect(request.data.maintenance).toBeUndefined();
      expect(request.data.execution).toMatchObject({
        model: "claude-sonnet-5",
        reasoningLevel: "low",
      });
      expect(readAutoCompactionMetadata(harness.db, thread.id)).toEqual({
        disabled: false,
        basisSnapshot: null,
        lastOutcome: null,
      });

      const active = requireThread(harness, thread.id);

      expect(active.status).toBe("active");
      expect(getLatestMaintenanceRequest(harness.db, thread.id)).toBeNull();
      expect(isMaintenanceRunActive(harness.db, active)).toBe(false);
      expect(countActiveMaintenanceRuns(harness.db)).toBe(0);
    });
  });
});
