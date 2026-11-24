import { applyRealtimeThreadPatches } from "./realtime-cache-registry";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
  makeThreadQueuedMessage,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { toPluginSidebarThread } from "@/lib/plugin-sidebar-threads";
import {
  sidebarNavigationQueryKey,
  systemAppUpdateQueryKey,
  threadListQueryKey,
  threadQueryKey,
  threadQueuedMessagesQueryKey,
} from "../queries/query-keys";
import {
  applySendThreadMessageSuccess,
  applyQueuedMessageSendResult,
  beginSendQueuedMessageTransaction,
  beginStopThreadTransaction,
  beginSendThreadMessageTransaction,
  rollbackRemoveQueuedMessageTransaction,
  rollbackSendThreadMessageTransaction,
  rollbackStopThreadTransaction,
} from "./thread-runtime-cache-owner";
import {
  replaceCachedThreadListEntry,
  readSidebarNavigation,
  readThreadState,
  updateCachedThreadListStatusState,
  updateCachedThreadStatusState,
} from "./query-cache";

const clients: QueryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function fixture(
  initialStatus: "idle" | "active" = "idle",
  admission: "instant" | "held" = "instant",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

  clients.push(queryClient);

  if (admission === "held")
    queryClient.setQueryData(systemAppUpdateQueryKey(), {
      newTurnsPausedForUpdate: true,
    });

  const idle = makeThreadListEntry({
    id: "thr_status",
    projectId: "proj_status",
    status: "idle",
    runtime: { displayStatus: "idle" },
    updatedAt: 100,
    lastMessageAt: 100,
  });

  const initial =
    initialStatus === "active"
      ? {
          ...idle,
          status: "active" as const,
          runtime: { ...idle.runtime, displayStatus: "active" as const },
        }
      : idle;

  const navigation = makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: idle.projectId,
        threads: [initial],
      }),
    ],
  });

  queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
  queryClient.setQueryData(threadListQueryKey({ archived: false }), [initial]);
  queryClient.setQueryData(
    threadQueryKey(idle.id),
    makeThreadResponse(initial),
  );

  const request = {
    id: idle.id,
    mode: "auto" as const,
    input: [{ type: "text" as const, text: "Continue", mentions: [] }],
  };

  const sidebarThread = () =>
    queryClient.getQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
    )?.projects[0]?.threads[0];

  const status = () => sidebarThread()?.status;

  const patch = (value: typeof idle) => {
    updateCachedThreadListStatusState(queryClient, idle.id, value);
    updateCachedThreadStatusState(queryClient, idle.id, value);
  };

  return {
    idle,
    navigation,
    queryClient,
    request,
    status,
    sidebarThread,
    patch,
  };
}

describe("thread status admission races", () => {
  it("keeps a settled send pending while delayed events from the previous turn arrive", async () => {
    const { idle, queryClient, request, status, patch } = fixture();
    patch({ ...idle, status: "active", runtime: { displayStatus: "active" } });

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    patch({
      ...idle,
      status: "active",
      runtime: { displayStatus: "active" },
      updatedAt: 101,
    });
    applySendThreadMessageSuccess({
      queryClient,
      request,
      transaction,
      realtimeConnected: true,
      result: { ok: true, delivery: "sent" },
    });
    patch({ ...idle, updatedAt: 102 });
    expect(status()).toBe("active");
  });

  it("does not acknowledge a settled send with an older initial sidebar read", async () => {
    const { navigation, queryClient, request } = fixture();

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    queryClient.removeQueries({ queryKey: sidebarNavigationQueryKey() });
    let finish!: (value: SidebarBootstrapResponse) => void;

    const reading = readSidebarNavigation(
      queryClient,
      () =>
        new Promise<SidebarBootstrapResponse>((resolve) => {
          finish = resolve;
        }),
    );

    applySendThreadMessageSuccess({
      queryClient,
      request,
      transaction,
      realtimeConnected: true,
      result: { ok: true, delivery: "sent" },
    });
    finish(navigation);
    expect((await reading).projects[0]?.threads[0]?.status).toBe("active");

    const fresh = await readSidebarNavigation(
      queryClient,
      async () => navigation,
    );

    expect(fresh.projects[0]?.threads[0]?.status).toBe("idle");
  });

  it("does not use a previous active turn as acknowledgement of the next send", async () => {
    const { idle, navigation, queryClient, request, status, patch } = fixture();
    patch({ ...idle, status: "active", runtime: { displayStatus: "active" } });

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    applySendThreadMessageSuccess({
      queryClient,
      request,
      transaction,
      realtimeConnected: true,
      result: { ok: true, delivery: "sent" },
    });
    patch(idle);
    expect(status()).toBe("active");

    const fresh = await readSidebarNavigation(
      queryClient,
      async () => navigation,
    );

    expect(fresh.projects[0]?.threads[0]?.status).toBe("idle");
  });

  it("projects pending admission into an initial sidebar response without losing newer metadata", async () => {
    const { idle, navigation, queryClient, request, sidebarThread } = fixture(
      "idle",
      "held",
    );

    await beginSendThreadMessageTransaction({ queryClient, request });
    queryClient.removeQueries({ queryKey: sidebarNavigationQueryKey() });

    const result = await readSidebarNavigation(
      queryClient,
      async () => navigation,
    );

    queryClient.setQueryData(sidebarNavigationQueryKey(), result);
    expect(sidebarThread()).toMatchObject({
      status: "idle",
      queuedWork: "waiting",
    });
    replaceCachedThreadListEntry(queryClient, {
      ...idle,
      title: "Renamed while sending",
      updatedAt: 101,
      attention: {
        kind: "required-answer",
        requiredCount: 1,
        optionalCount: 0,
        callback: null,
      },
    });
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0],
    ).toMatchObject({
      status: "idle",
      queuedWork: "waiting",
      title: "Renamed while sending",
      attention: { kind: "required-answer" },
    });
  });

  it.each(["sent", "failed"] as const)(
    "starts Send now at once, holds it against stale reads and reconciles %s",
    async (outcome) => {
      const { idle, queryClient, status, patch } = fixture();

      const queued = makeThreadQueuedMessage({
        threadId: idle.id,
        id: "qmsg_status",
      });

      queryClient.setQueryData(threadQueuedMessagesQueryKey(idle.id), [queued]);

      const request = {
        id: idle.id,
        queuedMessageId: queued.id,
        mode: "auto" as const,
      };

      const transaction = await beginSendQueuedMessageTransaction({
        queryClient,
        request,
      });

      expect(status()).toBe("active");
      expect(queryClient.getQueryData(threadQueryKey(idle.id))).toMatchObject({
        status: "active",
      });
      expect(
        queryClient.getQueryData(threadQueuedMessagesQueryKey(idle.id)),
      ).toEqual([]);

      patch(idle);
      replaceCachedThreadListEntry(queryClient, idle);
      expect(status()).toBe("active");
      expect(
        queryClient.getQueryData<SidebarBootstrapResponse>(
          sidebarNavigationQueryKey(),
        )?.projects[0]?.threads[0]?.queuedWork,
      ).toBe("none");

      if (outcome === "failed") {
        rollbackRemoveQueuedMessageTransaction({
          queryClient,
          request,
          transaction,
        });
        expect(status()).toBe("idle");
        expect(
          queryClient.getQueryData(threadQueuedMessagesQueryKey(idle.id)),
        ).toEqual([queued]);
        expect(
          queryClient.getQueryData<SidebarBootstrapResponse>(
            sidebarNavigationQueryKey(),
          )?.projects[0]?.threads[0]?.queuedWork,
        ).toBe("waiting");
      } else {
        patch({
          ...idle,
          status: "active",
          runtime: { displayStatus: "active" },
          updatedAt: 101,
        });
        applyQueuedMessageSendResult({
          queryClient,
          request,
          transaction,
          result: { ok: true, delivery: "sent" },
        });

        queryClient.setQueryData(
          sidebarNavigationQueryKey(),
          await readSidebarNavigation(queryClient, async () =>
            makeSidebarBootstrapResponse({
              projects: [
                makeProjectWithThreadsResponse({
                  id: idle.projectId,
                  threads: [{ ...idle, updatedAt: 101 }],
                }),
              ],
            }),
          ),
        );
        patch({ ...idle, updatedAt: 101 });
        expect(status()).toBe("idle");
      }
    },
  );

  it("leaves stopping as soon as the server reports a newer idle after an accepted send", async () => {
    const { idle, queryClient, request, status, patch } = fixture();

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    applySendThreadMessageSuccess({
      queryClient,
      request,
      transaction,
      realtimeConnected: true,
      result: { ok: true, delivery: "sent" },
    });
    await beginStopThreadTransaction({ queryClient, threadId: idle.id });
    expect(status()).toBe("stopping");

    patch(idle);
    expect(status()).toBe("stopping");

    patch({ ...idle, updatedAt: 101 });
    expect(status()).toBe("idle");
    expect(queryClient.getQueryData(threadQueryKey(idle.id))).toMatchObject({
      status: "idle",
    });
  });

  it("does not restore a pre-stop snapshot over a newer server state when the stop fails", async () => {
    const { idle, queryClient, status, patch } = fixture("active");

    const transaction = await beginStopThreadTransaction({
      queryClient,
      threadId: idle.id,
    });

    patch({ ...idle, updatedAt: 101 });
    rollbackStopThreadTransaction({
      queryClient,
      threadId: idle.id,
      transaction,
    });

    expect(status()).toBe("idle");
    expect(queryClient.getQueryData(threadQueryKey(idle.id))).toMatchObject({
      status: "idle",
      updatedAt: 101,
    });
    expect(queryClient.getQueryState(threadQueryKey(idle.id))).toMatchObject({
      isInvalidated: true,
    });
  });

  it("shows Stop in the sidebar without treating client time as a server revision", async () => {
    const { idle, queryClient, status, patch } = fixture();
    queryClient.setQueryData(
      threadQueryKey(idle.id),
      makeThreadResponse({
        ...idle,
        status: "active",
        runtime: { displayStatus: "active" },
      }),
    );
    await beginStopThreadTransaction({ queryClient, threadId: idle.id });
    expect(status()).toBe("stopping");
    patch({ ...idle, updatedAt: 101 });
    expect(status()).toBe("idle");
    expect(queryClient.getQueryData(threadQueryKey(idle.id))).toMatchObject({
      status: "idle",
      updatedAt: 101,
    });
  });

  it.each(["before", "during"] as const)(
    "rejects a read begun %s admission after settlement and accepts the fresh baseline",
    async (when) => {
      const { idle, navigation, queryClient, request, status } = fixture();
      let finish!: (value: SidebarBootstrapResponse) => void;

      const load = () =>
        new Promise<SidebarBootstrapResponse>((resolve) => {
          finish = resolve;
        });

      const before =
        when === "before" ? readSidebarNavigation(queryClient, load) : null;

      const transaction = await beginSendThreadMessageTransaction({
        queryClient,
        request,
      });

      const reading = before ?? readSidebarNavigation(queryClient, load);
      applySendThreadMessageSuccess({
        queryClient,
        request,
        transaction,
        realtimeConnected: true,
        result: { ok: true, delivery: "sent" },
      });
      finish(navigation);
      const result = await reading;
      expect(result.projects[0]?.threads[0]?.status).toBe("active");

      const fresh = await readSidebarNavigation(
        queryClient,
        async () => navigation,
      );

      queryClient.setQueryData(sidebarNavigationQueryKey(), fresh);
      expect(status()).toBe("idle");

      const detail = await readThreadState(queryClient, idle.id, async () =>
        makeThreadResponse(idle),
      );

      expect(detail.status).toBe("idle");
    },
  );

  it("keeps the next pending send waiting when the first fails and clears after both fail", async () => {
    const { idle, queryClient, request, sidebarThread, patch } = fixture(
      "idle",
      "held",
    );

    const first = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    const second = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    rollbackSendThreadMessageTransaction({
      queryClient,
      request,
      transaction: first,
    });
    patch({ ...idle, title: "Updated during the pending send" });
    expect(sidebarThread()).toMatchObject({
      status: "idle",
      queuedWork: "waiting",
    });
    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey(idle.id)),
    ).toHaveLength(1);
    rollbackSendThreadMessageTransaction({
      queryClient,
      request,
      transaction: second,
    });
    expect(sidebarThread()).toMatchObject({
      status: "idle",
      queuedWork: "none",
      title: "Updated during the pending send",
    });
    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey(idle.id)),
    ).toEqual([]);
  });

  it("cancels an older sidebar read before publishing the pending send", async () => {
    const { navigation, queryClient, request, sidebarThread } = fixture(
      "idle",
      "held",
    );

    let finish!: (value: SidebarBootstrapResponse) => void;

    const reading = queryClient.fetchQuery({
      queryKey: sidebarNavigationQueryKey(),
      queryFn: () =>
        new Promise<SidebarBootstrapResponse>((resolve) => {
          finish = resolve;
        }),
    });

    void reading.catch(() => {});
    await beginSendThreadMessageTransaction({ queryClient, request });
    expect(sidebarThread()).toMatchObject({
      status: "idle",
      queuedWork: "waiting",
    });
    finish(navigation);
    await reading.catch(() => {});
    expect(sidebarThread()).toMatchObject({
      status: "idle",
      queuedWork: "waiting",
    });
  });

  it.each([
    { initialStatus: "idle", source: "status" },
    { initialStatus: "idle", source: "entry" },
    { initialStatus: "active", source: "status" },
    { initialStatus: "active", source: "entry" },
  ] as const)(
    "protects $initialStatus input admission from an older $source event",
    async ({ initialStatus, source }) => {
      const { idle, queryClient, request, sidebarThread, status, patch } =
        fixture(initialStatus, initialStatus === "idle" ? "held" : "instant");

      const transaction = await beginSendThreadMessageTransaction({
        queryClient,
        request,
      });

      if (source === "status") patch(idle);
      else replaceCachedThreadListEntry(queryClient, idle);
      expect(sidebarThread()).toMatchObject(
        initialStatus === "idle"
          ? { status: "idle", queuedWork: "waiting" }
          : { status: "active" },
      );
      rollbackSendThreadMessageTransaction({
        queryClient,
        request,
        transaction,
      });
      expect(status()).toBe("idle");
    },
  );

  it("uses server ordering after acceptance despite an ahead client clock", async () => {
    const { idle, queryClient, request, status, patch } = fixture();

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    patch({
      ...idle,
      status: "active",
      runtime: { displayStatus: "active" },
      updatedAt: 101,
    });
    applySendThreadMessageSuccess({
      queryClient,
      request,
      transaction,
      result: { ok: true, delivery: "sent" },
      realtimeConnected: true,
    });
    patch(idle);
    expect(status()).toBe("active");

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      await readSidebarNavigation(queryClient, async () =>
        makeSidebarBootstrapResponse({
          projects: [
            makeProjectWithThreadsResponse({
              id: idle.projectId,
              threads: [{ ...idle, updatedAt: 101 }],
            }),
          ],
        }),
      ),
    );
    patch({ ...idle, updatedAt: 101 });
    expect(status()).toBe("idle");
    expect(queryClient.getQueryData(threadQueryKey(idle.id))).toMatchObject({
      status: "idle",
      runtime: { displayStatus: "idle" },
      updatedAt: 101,
    });
  });
});

describe("work summary freshness", () => {
  it("applies one work snapshot to the sidebar, list and detail", () => {
    const { idle, queryClient, sidebarThread } = fixture();

    const work = makeThreadWorkSummary({
      revision: "job-revision",
      basis: "job-basis",
      primary: {
        label: "working",
        reason: { code: "owned-work", text: "Release job running." },
      },
    });

    applyRealtimeThreadPatches(["work-changed"], {
      queryClient,
      threadId: idle.id,
      listEntry: { ...idle, work },
      hasPendingInteraction: undefined,
      statusChange: undefined,
    });
    expect(sidebarThread()?.work).toEqual(work);
    expect(
      queryClient.getQueryData<ReturnType<typeof makeThreadResponse>>(
        threadQueryKey(idle.id),
      )?.work,
    ).toEqual(work);
  });
  it("invalidates old readiness during a local send and rejects a delayed ready entry", async () => {
    const { idle, queryClient, request, sidebarThread } = fixture();

    const work = makeThreadWorkSummary({
      primary: {
        label: "ready-to-archive",
        reason: { code: "assessed-complete", text: "Work complete." },
      },
      archive: { eligible: true, recommended: true, reason: "Work complete." },
    });

    replaceCachedThreadListEntry(queryClient, { ...idle, work });
    expect(sidebarThread()?.work?.archive.recommended).toBe(true);
    await beginSendThreadMessageTransaction({ queryClient, request });
    expect(sidebarThread()?.work).toMatchObject({
      primary: { label: "working" },
      archive: { recommended: false },
    });
    replaceCachedThreadListEntry(queryClient, { ...idle, work });
    expect(sidebarThread()?.work).toMatchObject({
      primary: { label: "working" },
      archive: { recommended: false },
    });
  });
});

describe("sidebar badge through local sends", () => {
  const working = makeThreadWorkSummary({
    primary: {
      label: "working",
      reason: { code: "owned-work", text: "The agent is working." },
    },
    activity: [
      {
        id: "turn:thr_status",
        kind: "turn",
        label: "The agent is working.",
        phase: "running",
        actor: { kind: "agent", id: "thr_status", label: "Agent" },
      },
    ],
  });

  function badge(
    sidebarThread: ReturnType<typeof fixture>["sidebarThread"],
  ): string | null {
    const thread = sidebarThread();

    if (thread === undefined) throw new Error("sidebar row missing");

    return toPluginSidebarThread(thread).indicatorLabel;
  }

  it("keeps a working chat Working through a steer until the server answers", async () => {
    const { idle, navigation, queryClient, sidebarThread } = fixture("active");

    const active = {
      ...idle,
      status: "active" as const,
      runtime: { displayStatus: "active" as const },
      work: working,
    };

    replaceCachedThreadListEntry(queryClient, active);

    const request = {
      id: idle.id,
      mode: "steer" as const,
      input: [
        { type: "text" as const, text: "Also cover lakes", mentions: [] },
      ],
    };

    const seen = [badge(sidebarThread)];

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    seen.push(badge(sidebarThread));
    applyRealtimeThreadPatches(["events-appended", "read-state-changed"], {
      queryClient,
      threadId: idle.id,
      listEntry: { ...active, updatedAt: 101 },
      hasPendingInteraction: undefined,
      statusChange: undefined,
    });
    seen.push(badge(sidebarThread));
    applySendThreadMessageSuccess({
      queryClient,
      request,
      transaction,
      realtimeConnected: true,
      result: { ok: true, delivery: "sent" },
    });
    seen.push(badge(sidebarThread));
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      await readSidebarNavigation(queryClient, async () => ({
        ...navigation,
        projects: [
          {
            ...navigation.projects[0]!,
            threads: [{ ...active, updatedAt: 101 }],
          },
        ],
      })),
    );
    seen.push(badge(sidebarThread));
    expect(seen).toEqual([
      "Working",
      "Working",
      "Working",
      "Working",
      "Working",
    ]);
  });

  it("shows Working on Enter, before pending reads finish cancelling", () => {
    const { queryClient, request, sidebarThread } = fixture();

    void queryClient.fetchQuery({
      queryKey: threadQueryKey(request.id),
      queryFn: () => new Promise(() => {}),
    });

    const transaction = beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    expect(badge(sidebarThread)).toBe("Working");
    void transaction;
  });

  it("shows Working as soon as an idle chat sends", async () => {
    const { queryClient, request, sidebarThread, status } = fixture();

    expect(badge(sidebarThread)).toBe("Done");
    await beginSendThreadMessageTransaction({ queryClient, request });
    expect(status()).toBe("active");
    expect(badge(sidebarThread)).toBe("Working");
  });

  it("keeps Working while a stop is pending", async () => {
    const { idle, queryClient, sidebarThread } = fixture("active");

    replaceCachedThreadListEntry(queryClient, {
      ...idle,
      status: "active",
      runtime: { displayStatus: "active" },
      work: working,
    });
    await beginStopThreadTransaction({ queryClient, threadId: idle.id });
    expect(badge(sidebarThread)).toBe("Working");
  });

  it("keeps Working when a message is queued behind a busy chat", async () => {
    const { idle, queryClient, sidebarThread } = fixture("active");

    replaceCachedThreadListEntry(queryClient, {
      ...idle,
      status: "active",
      runtime: { displayStatus: "active" },
      work: working,
    });
    await beginSendThreadMessageTransaction({
      queryClient,
      request: {
        id: idle.id,
        mode: "queue-if-active",
        input: [{ type: "text", text: "After this", mentions: [] }],
      },
    });
    expect(sidebarThread()?.queuedWork).toBe("waiting");
    expect(badge(sidebarThread)).toBe("Working");
  });

  it("shows Blocked when failed setup releases the chat's machine", () => {
    const { idle, queryClient, sidebarThread } = fixture();

    const starting = {
      ...idle,
      status: "starting" as const,
      runtime: { displayStatus: "starting" as const },
      environmentHostId: "host_mac",
      work: working,
    };

    queryClient.setQueryData(sidebarNavigationQueryKey(), {
      ...queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )!,
      projects: [
        makeProjectWithThreadsResponse({
          id: idle.projectId,
          threads: [starting],
        }),
      ],
    });

    const failed = {
      ...starting,
      status: "error" as const,
      runtime: { displayStatus: "error" as const },
      environmentHostId: null,
      updatedAt: 101,
      work: makeThreadWorkSummary({
        primary: {
          label: "blocked",
          reason: {
            code: "run-failed",
            text: "The last agent run failed and needs recovery.",
          },
        },
      }),
    };

    applyRealtimeThreadPatches(["status-changed"], {
      queryClient,
      threadId: idle.id,
      listEntry: failed,
      hasPendingInteraction: undefined,
      statusChange: {
        status: failed.status,
        runtime: failed.runtime,
        activity: failed.activity,
        latestAttentionAt: failed.latestAttentionAt,
        lastMessageAt: failed.lastMessageAt,
        updatedAt: failed.updatedAt,
      },
    });
    expect(badge(sidebarThread)).toBe("Blocked");
  });

  it("shows Waiting for a send held behind the update pause", async () => {
    const { queryClient, request, sidebarThread } = fixture("idle", "held");

    await beginSendThreadMessageTransaction({ queryClient, request });
    expect(sidebarThread()?.queuedWork).toBe("waiting");
    expect(badge(sidebarThread)).toBe("Waiting");
  });
});
