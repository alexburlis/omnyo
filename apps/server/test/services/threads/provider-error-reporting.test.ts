import { afterEach, describe, expect, it, vi } from "vitest";
import * as reporting from "@omnyo/process-utils/error-reporting";
import { eq } from "drizzle-orm";
import {
  getAppSettings,
  setAppSettings,
  getLatestThreadSequence,
  threadFailures,
  threads,
} from "@omnyo/db";
import type { ProviderErrorInfo } from "@omnyo/domain";
import {
  captureActionableProviderFailures,
  captureDueProviderFailures,
} from "../../../src/services/threads/provider-error-reporting.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "../../../src/services/threads/lifecycle-outcome.js";
import { NotificationBuffer } from "../../../src/services/lib/notification-buffer.js";
import {
  insertFailure,
  updateFailure,
} from "../../../src/services/inbox/store.js";
import { loadFailedTurn } from "../../../src/services/threads/turn-failed.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

afterEach(() => vi.restoreAllMocks());

function seedFailure(
  harness: TestAppHarness,
  info: ProviderErrorInfo | null,
  state: "actionable" | "deciding" | "held" = "actionable",
  createdAt = Date.now(),
  providerError?: { providerId: string; detail: string },
) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });

  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: providerError?.providerId,
    status: "error",
  });

  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider",
    threadId: thread.id,
    inputText: "private-prompt-marker",
  });
  seedEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "provider",
    sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
    type: "provider/error",
    scope: { kind: "thread" },
    data: {
      providerThreadId: "provider",
      message: "private-error-marker",
      ...(providerError === undefined ? {} : { detail: providerError.detail }),
      ...(info === null ? {} : { errorInfo: info }),
    },
  });
  const request = loadFailedTurn(harness.db, thread.id);

  if (request === null) throw new Error("Missing request");

  const failure = insertFailure(harness.db, {
    threadId: thread.id,
    turnId: null,
    requestId: request.request.requestId,
    waitId: null,
    state,
    reason: "private-reason-marker",
    decisionDeadline: null,
    now: createdAt,
  });

  return { thread, failure };
}

const unexpected: ProviderErrorInfo = {
  category: "bad-request",
  providerCode: "badRequest",
  httpStatusCode: 422,
};

describe("terminal provider diagnostics", () => {
  it("excludes the retired Claude pool response while reporting other conflicts", async () => {
    const capture = vi
      .spyOn(reporting, "captureProcessError")
      .mockImplementation(() => {});

    await withTestHarness(async (harness) => {
      const detail =
        "API Error: 409 This conversation used an older Claude account pool. Use Account Pooler bypass for this thread to sign in directly through Claude Code, or start a new conversation to use a pooled Anthropic API key.";

      const info: ProviderErrorInfo = {
        category: "bad-request",
        providerCode: null,
        httpStatusCode: 409,
      };

      const retired = seedFailure(harness, info, "actionable", Date.now(), {
        providerId: "claude-code",
        detail,
      });

      const upstream = seedFailure(harness, info, "actionable", Date.now(), {
        providerId: "claude-code",
        detail: `API Error: 409 private-upstream-marker: ${detail}`,
      });

      const otherProvider = seedFailure(
        harness,
        info,
        "actionable",
        Date.now(),
        { providerId: "codex", detail },
      );

      captureActionableProviderFailures(harness.db, [retired.thread.id]);
      expect(capture).not.toHaveBeenCalled();
      captureActionableProviderFailures(harness.db, [
        upstream.thread.id,
        otherProvider.thread.id,
      ]);
      captureDueProviderFailures(harness.db);
      expect(capture).toHaveBeenCalledTimes(2);

      for (const [, options] of capture.mock.calls) {
        expect(options?.diagnostic).toMatchObject({
          failureClass: "upstream-rejected",
          status: 409,
        });
      }
    });
  });

  it("captures one actionable bound failure with safe deterministic correlation", async () => {
    const capture = vi
      .spyOn(reporting, "captureProcessError")
      .mockImplementation(() => {});

    await withTestHarness(async (harness) => {
      const { thread } = seedFailure(harness, unexpected);
      captureActionableProviderFailures(harness.db, [thread.id]);
      captureDueProviderFailures(harness.db);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          eventId: expect.stringMatching(/^[a-f0-9]{32}$/u),
          diagnostic: expect.objectContaining({
            operation: "provider-request",
            failureClass: "upstream-rejected",
            status: 422,
            outcome: "terminal",
          }),
        }),
      );
      expect(JSON.stringify(capture.mock.calls)).not.toMatch(
        /private-|providerCode|threadId|requestId/u,
      );
    });
  });

  it.each(["deciding", "held"] as const)(
    "waits while the failure is %s",
    async (state) => {
      const capture = vi
        .spyOn(reporting, "captureProcessError")
        .mockImplementation(() => {});

      await withTestHarness(async (harness) => {
        const { thread, failure } = seedFailure(harness, unexpected, state);
        captureActionableProviderFailures(harness.db, [thread.id]);
        expect(capture).not.toHaveBeenCalled();
        updateFailure(
          harness.db,
          failure.id,
          { state: "actionable" },
          Date.now(),
        );
        captureDueProviderFailures(harness.db);
        expect(capture).toHaveBeenCalledTimes(1);
      });
    },
  );

  it.each(["rate-limit", "billing", "budget-exceeded"] as const)(
    "does not report expected %s",
    async (category) => {
      const capture = vi
        .spyOn(reporting, "captureProcessError")
        .mockImplementation(() => {});

      await withTestHarness(async (harness) => {
        const { thread } = seedFailure(harness, { ...unexpected, category });
        captureActionableProviderFailures(harness.db, [thread.id]);
        expect(capture).not.toHaveBeenCalled();
      });
    },
  );

  it("does not report historical, unbound, mismatched or resolved failures", async () => {
    const capture = vi
      .spyOn(reporting, "captureProcessError")
      .mockImplementation(() => {});

    await withTestHarness(async (harness) => {
      seedFailure(harness, unexpected, "actionable", Date.now() - 60_000);
      const unbound = seedFailure(harness, unexpected);
      updateFailure(
        harness.db,
        unbound.failure.id,
        { requestId: null },
        Date.now(),
      );
      const mismatched = seedFailure(harness, unexpected);
      updateFailure(
        harness.db,
        mismatched.failure.id,
        { requestId: "creq_bbbbbbbbbb" },
        Date.now(),
      );
      const resolved = seedFailure(harness, unexpected);
      updateFailure(
        harness.db,
        resolved.failure.id,
        { state: "resolved" },
        Date.now(),
      );
      captureDueProviderFailures(harness.db);
      expect(capture).not.toHaveBeenCalled();
    });
  });

  it("does not emit from a transaction that rolls back", async () => {
    const capture = vi
      .spyOn(reporting, "captureProcessError")
      .mockImplementation(() => {});

    await withTestHarness(async (harness) => {
      const { thread, failure } = seedFailure(harness, unexpected);
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, thread.id))
        .run();
      harness.db
        .delete(threadFailures)
        .where(eq(threadFailures.id, failure.id))
        .run();
      expect(() =>
        harness.db.transaction((tx) => {
          applyLoggedThreadLifecycleEventInTransaction(
            {
              db: tx,
              hub: new NotificationBuffer(),
              logger: harness.deps.logger,
            },
            { threadId: thread.id, event: { type: "run.failed" } },
          );
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      captureDueProviderFailures(harness.db);
      expect(capture).not.toHaveBeenCalled();
    });
  });
});

it.each([true, undefined, false])(
  "respects explicit startup expected-failure classification %s",
  async (expectedFailure) => {
    const capture = vi
      .spyOn(reporting, "captureProcessError")
      .mockImplementation(() => {});

    await withTestHarness(async (harness) => {
      const { thread } = seedFailure(harness, null);
      seedEvent(harness.deps, {
        threadId: thread.id,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "system/error",
        scope: { kind: "thread" },
        data: {
          code: "thread_command_failed",
          commandErrorCode: "command_failed",
          expectedFailure,
          message: "private-provider-message",
        },
      });
      captureActionableProviderFailures(harness.db, [thread.id]);
      expect(capture).toHaveBeenCalledTimes(expectedFailure === false ? 1 : 0);
    });
  },
);

it("does not replay a failure observed while diagnostic choice was off", async () => {
  const capture = vi
    .spyOn(reporting, "captureProcessError")
    .mockImplementation(() => {});

  await withTestHarness(async (harness) => {
    const { thread } = seedFailure(harness, unexpected);
    setAppSettings(harness.db, {
      ...getAppSettings(harness.db),
      crashReportsEnabled: false,
    });
    captureActionableProviderFailures(harness.db, [thread.id]);
    setAppSettings(harness.db, {
      ...getAppSettings(harness.db),
      crashReportsEnabled: true,
    });
    captureDueProviderFailures(harness.db);
    expect(capture).not.toHaveBeenCalled();
  });
});
