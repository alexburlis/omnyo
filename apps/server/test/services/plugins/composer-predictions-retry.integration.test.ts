import { readStoredThreadWork } from "@omnyo/db";
import { turnScope } from "@omnyo/domain";
import { createNodeOmnyoSdk } from "@omnyo/sdk";
import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@omnyo/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { setThreadWorkContributorStates } from "../../../src/services/threads/thread-work.js";
import {
  seedChatCompletionReport,
  seedEvent,
  seedThreadRuntimeState,
  seedThreadFixture,
} from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

type PluginModule = { default(api: PluginApi): Promise<void> };

it("stores a completion assessment after consecutive admission timeouts without a manual retry", async () => {
  const plugin = await vi.importActual<PluginModule>(
    new URL(
      "../../../../../plugins/composer-predictions/server.ts",
      import.meta.url,
    ).pathname,
  );

  await withTestHarness(async (server) => {
    const { thread, host, environment } = seedThreadFixture(server);
    seedThreadRuntimeState(server.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "native-completed-thread",
    });
    seedChatCompletionReport(server.db, thread.id, "completed-turn", 2);
    seedEvent(server.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "native-completed-thread",
      sequence: 3,
      scope: turnScope("completed-turn"),
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          id: "final-reply",
          text: "The requested work and verification are complete.",
        },
      },
    });
    seedEvent(server.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "native-completed-thread",
      sequence: 4,
      scope: turnScope("completed-turn"),
      type: "turn/completed",
      data: {
        status: "completed",
        providerThreadId: "native-completed-thread",
        providerCheckpointId: "completed-turn",
      },
    });

    let timeoutNextList = true;
    let timedOutReads = 0;
    let predictions = 0;

    const sdk = createNodeOmnyoSdk({
      baseUrl: "http://localhost",
      fetch: async (input, init) => {
        const request = new Request(input, init);

        if (
          new URL(request.url).pathname === "/api/v1/threads" &&
          timeoutNextList
        ) {
          timeoutNextList = false;
          timedOutReads += 1;
          await new Promise<never>((_resolve, reject) => {
            if (request.signal.aborted) reject(request.signal.reason);
            else
              request.signal.addEventListener(
                "abort",
                () => reject(request.signal.reason),
                { once: true },
              );
          });
        }

        return server.app.request(request);
      },
    });

    const runtime = createFakePluginHost({
      pluginId: "omnyo--composer-predictions",
      settings: { enabled: true, provider: "codex" },
      sdk: {
        threads: {
          get: sdk.threads.get,
          list: sdk.threads.list,
          events: { list: sdk.threads.events.list },
          experimental_publishWork: sdk.threads.experimental_publishWork,
        },
        hosts: {
          get: () => makeHostResponse({ id: host.id, status: "connected" }),
        },
        plugins: {
          list: sdk.plugins.list,
          callRpc: async ({ pluginId, method, outputSchema }) => {
            expect(pluginId).toBe("account-pool");
            expect(method).toBe("experimental_composer-predictions.v1.predict");
            predictions += 1;

            return outputSchema.parse({
              text: null,
              noSuggestionReason: "The requested work is complete.",
              promptVersion: "desktop-v1",
              archiveReadiness: {
                ready: true,
                reason: "The requested work and verification are complete.",
                waitingOn: null,
              },
              tag: null,
            });
          },
        },
      },
    });

    await plugin.default(runtime.api);
    setThreadWorkContributorStates(
      server.db,
      () =>
        new Map([
          ...server.pluginService.getThreadWorkContributorStates(),
          ["omnyo--composer-predictions", true],
        ]),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const deadlines = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException("Timed out", "TimeoutError")),
          milliseconds,
        );

        return controller.signal;
      });

    try {
      await runtime.harness.emitThreadEvent("thread.idle", {
        thread: await sdk.threads.get({ threadId: thread.id }),
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(timedOutReads).toBe(1));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(async () =>
        expect(
          await sdk.threads.experimental_work({ threadId: thread.id }),
        ).toMatchObject({ assessment: { availability: "failed" } }),
      );
      expect(
        await runtime.harness.callRpc("diagnostics", { threadId: thread.id }),
      ).toMatchObject({
        lastFailure: {
          stage: "preparation",
          message: "Checking chat work status timed out. Retry the prediction.",
        },
      });
      expect(predictions).toBe(0);

      timeoutNextList = true;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(timedOutReads).toBe(2));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(predictions).toBe(0);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.waitFor(async () => {
        expect(predictions).toBe(1);
        expect(
          await sdk.threads.experimental_work({ threadId: thread.id }),
        ).toMatchObject({
          primary: { label: "ready-to-archive" },
          assessment: { availability: "available", sourceSeq: 4 },
          archive: { recommended: true },
        });
      });
      expect(
        readStoredThreadWork(server.db, [thread.id]).get(thread.id),
      ).toMatchObject({
        assessments: [
          {
            pluginId: "omnyo--composer-predictions",
            value: {
              availability: "available",
              sourceSeq: 4,
              archiveReady: true,
            },
          },
        ],
      });
    } finally {
      await runtime.harness.dispose();
      deadlines.mockRestore();
      vi.useRealTimers();
      setThreadWorkContributorStates(server.db, () =>
        server.pluginService.getThreadWorkContributorStates(),
      );
    }
  });
});
