import { afterEach, expect, it, vi } from "vitest";
import {
  appendStoredThreadEvent,
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
} from "@omnyo/db";
import { encodeClientTurnRequestIdNumber, threadScope } from "@omnyo/domain";
import * as reporting from "@omnyo/process-utils/error-reporting";
import { insertFailure } from "../../../src/services/inbox/store.js";
import { captureActionableProviderFailures } from "../../../src/services/threads/provider-error-reporting.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["claude_model_confirmation_rejected", "sdk-rejected"],
  ["claude_model_confirmation_timeout", "timeout"],
  ["claude_model_confirmation_transport", "connection"],
  ["claude_model_confirmation_unknown", "unknown"],
])(
  "reports bounded model confirmation diagnostics for %s",
  (providerCode, failureClass) => {
    const capture = vi
      .spyOn(reporting, "captureProcessError")
      .mockImplementation(() => {});

    const db = createConnection(":memory:");

    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, { name: "diagnostics-test" });

      const { project } = createProject(db, noopNotifier, {
        name: "diagnostics-test",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/diagnostics-test",
        },
      });

      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "claude-code",
        status: "error",
      });

      const requestId = encodeClientTurnRequestIdNumber({ value: 1 });
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: thread.id,
        scope: threadScope(),
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          initiator: "user",
          senderThreadId: null,
          requestId,
          input: [
            { type: "text", text: "private-prompt-marker", mentions: [] },
          ],
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "claude-haiku-4-5",
            reasoningLevel: "low",
            permissionMode: "accept-edits",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          source: "tell",
        },
      });
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: thread.id,
        scope: threadScope(),
        type: "system/error",
        data: {
          code: "thread_command_failed",
          commandErrorCode: "command_failed",
          expectedFailure: false,
          message: "private-provider-message",
          errorInfo: {
            category: "unknown",
            providerCode,
            httpStatusCode: null,
          },
        },
      });
      insertFailure(db, {
        threadId: thread.id,
        turnId: null,
        requestId,
        waitId: null,
        state: "actionable",
        reason: "private-failure-reason",
        decisionDeadline: null,
        now: Date.now(),
      });

      captureActionableProviderFailures(db, [thread.id]);

      expect(capture).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        expect.objectContaining({
          diagnostic: expect.objectContaining({
            operation: "claude-model-confirmation",
            failureClass,
            dependency: "provider",
            operationId: expect.any(String),
          }),
        }),
      );
      expect(JSON.stringify(capture.mock.calls)).not.toMatch(
        /private-|providerCode/u,
      );
    } finally {
      db.$client.close();
    }
  },
);
