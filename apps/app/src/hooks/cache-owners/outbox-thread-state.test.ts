import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  sidebarNavigationQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import { beginOutboxThreadMessageTransaction } from "./outbox-thread-state-cache-owner";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  readPredictedInboxSnapshot,
} from "./inbox-snapshot-cache-owner";
import {
  readSidebarNavigation,
  replaceCachedThreadListEntry,
} from "./query-cache";

const clients: QueryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function fixture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

  clients.push(queryClient);

  const idle = makeThreadListEntry({
    id: "thr_outbox",
    projectId: "proj_outbox",
    title: "Saved chat",
    status: "idle",
    runtime: { displayStatus: "idle" },
    updatedAt: 100,
    work: makeThreadWorkSummary({
      primary: {
        label: "ready-to-archive",
        reason: { code: "assessed-complete", text: "Work complete." },
      },
    }),
  });

  const navigation = makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({ id: idle.projectId, threads: [idle] }),
    ],
  });

  queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
  queryClient.setQueryData(threadQueryKey(idle.id), makeThreadResponse(idle));
  queryClient.setQueryData(INBOX_SNAPSHOT_QUERY_KEY, {
    revision: "server:1",
    generatedAt: 1,
    inbox: [],
    waiting: [],
    running: [],
    shelf: [],
    lastMove: null,
    counts: {
      needsYou: 0,
      inbox: 0,
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
  });

  const sidebar = () =>
    queryClient.getQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
    )?.projects[0]?.threads[0];

  const begin = (connected: boolean, submissionId = "sub_test") =>
    beginOutboxThreadMessageTransaction({
      queryClient,
      threadId: idle.id,
      submissionId,
      connected,
    });

  return { queryClient, idle, navigation, sidebar, begin };
}

describe("durable outbox thread state", () => {
  it.each([true, false])(
    "shows a staged send immediately without claiming a run (connected=%s)",
    (connected) => {
      const { queryClient, sidebar, begin } = fixture();
      const transaction = begin(connected);
      expect(sidebar()).toMatchObject({
        status: "idle",
        runtime: { displayStatus: "idle" },
        queuedWork: "waiting",
      });
      expect(sidebar()?.work?.archive.recommended).toBe(false);
      expect(sidebar()?.work?.primary.label).toBe("waiting");
      const inbox = readPredictedInboxSnapshot(queryClient);
      expect(inbox?.running).toEqual([]);
      expect(inbox?.waiting).toMatchObject([
        {
          threadId: "thr_outbox",
          title: "Saved chat",
          waiting: {
            reason: connected
              ? "Sending message"
              : "Waiting for a connection to send your message.",
            guaranteed: false,
          },
        },
      ]);
      expect(inbox?.counts).toMatchObject({ running: 0, waiting: 1 });
      transaction.discard();
      expect(sidebar()?.work?.primary.label).toBe("ready-to-archive");
      expect(readPredictedInboxSnapshot(queryClient)?.waiting).toEqual([]);
    },
  );

  it("keeps the queued state through stale reads until real server acceptance", async () => {
    const { queryClient, navigation, sidebar, begin } = fixture();
    const transaction = begin(false);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      await readSidebarNavigation(queryClient, async () => navigation),
    );
    expect(sidebar()?.work?.primary.label).toBe("waiting");
    transaction.settle();

    const active = {
      ...navigation,
      projects: [
        {
          ...navigation.projects[0]!,
          threads: [
            {
              ...navigation.projects[0]!.threads[0]!,
              status: "active" as const,
              runtime: { displayStatus: "active" as const },
              updatedAt: 101,
              work: makeThreadWorkSummary({
                primary: {
                  label: "working",
                  reason: { code: "runtime", text: "Working" },
                },
              }),
            },
          ],
        },
      ],
    };

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      await readSidebarNavigation(queryClient, async () => active),
    );
    expect(sidebar()).toMatchObject({
      status: "active",
      work: { primary: { label: "working" } },
    });
    expect(sidebar()?.work?.waits).toEqual([]);
  });

  it("preserves an existing run while an offline follow-up waits to send", () => {
    const { queryClient, idle, sidebar, begin } = fixture();

    const active = {
      ...idle,
      status: "active" as const,
      runtime: { displayStatus: "active" as const },
      work: makeThreadWorkSummary({
        primary: {
          label: "working",
          reason: { code: "runtime", text: "Working" },
        },
      }),
    };

    replaceCachedThreadListEntry(queryClient, active);
    queryClient.setQueryData(
      threadQueryKey(idle.id),
      makeThreadResponse(active),
    );
    const transaction = begin(false);
    expect(sidebar()).toMatchObject({
      status: "active",
      runtime: { displayStatus: "active" },
      work: { primary: { label: "working" } },
    });
    transaction.discard();
  });

  it("removes only the failed submission when two sends overlap", () => {
    const { sidebar, begin } = fixture();
    const first = begin(false, "first");
    const second = begin(false, "second");
    first.discard();
    expect(sidebar()?.work?.waits.map((wait) => wait.id)).toEqual([
      "outbox:second",
    ]);
    second.discard();
    expect(sidebar()?.work?.waits).toEqual([]);
  });
  it.each(["question", "failure"] as const)(
    "preserves a required %s through staging, realtime and discard",
    (kind) => {
      const { queryClient, idle, sidebar, begin } = fixture();

      const work = makeThreadWorkSummary({
        primary: {
          label: kind === "question" ? "needs-you" : "failed",
          reason: { code: "pending", text: "Keep this" },
        },
        requiredInput:
          kind === "question"
            ? [
                {
                  id: "question",
                  kind: "question",
                  label: "Choose the destination",
                },
              ]
            : [],
        failures:
          kind === "failure"
            ? [
                {
                  code: "run-failed",
                  text: "The last run failed",
                  sourceId: "run_1",
                },
              ]
            : [],
      });

      replaceCachedThreadListEntry(queryClient, { ...idle, work });
      queryClient.setQueryData(
        threadQueryKey(idle.id),
        makeThreadResponse({ ...idle, work }),
      );
      const transaction = begin(false);
      const updated = { ...idle, title: "New title", updatedAt: 101, work };
      replaceCachedThreadListEntry(queryClient, updated);
      expect(sidebar()?.work?.primary.label).toBe(
        kind === "question" ? "needs-you" : "failed",
      );
      transaction.discard();
      expect(sidebar()).toMatchObject({
        title: "New title",
        queuedWork: "none",
      });
      expect(sidebar()?.work?.requiredInput).toEqual(work.requiredInput);
      expect(sidebar()?.work?.failures).toEqual(work.failures);
      expect(sidebar()?.work?.waits).toEqual([]);
    },
  );

  it("retires local queue work after realtime arrives before the receipt, with no later event", async () => {
    const { queryClient, idle, navigation, sidebar, begin } = fixture();
    const transaction = begin(true);

    const active = {
      ...idle,
      status: "active" as const,
      runtime: { displayStatus: "active" as const },
      queuedWork: "none" as const,
      updatedAt: 101,
      work: makeThreadWorkSummary({
        primary: {
          label: "working",
          reason: { code: "runtime", text: "Working" },
        },
      }),
    };

    replaceCachedThreadListEntry(queryClient, active);
    expect(sidebar()?.queuedWork).toBe("waiting");

    const read = vi.fn(() =>
      readSidebarNavigation(queryClient, async () => ({
        ...navigation,
        projects: [{ ...navigation.projects[0]!, threads: [active] }],
      })),
    );

    const stop = new QueryObserver(queryClient, {
      queryKey: sidebarNavigationQueryKey(),
      queryFn: read,
      staleTime: Infinity,
    }).subscribe(() => {});

    try {
      expect(read).not.toHaveBeenCalled();
      transaction.settle();
      await vi.waitFor(() => expect(sidebar()?.queuedWork).toBe("none"));
      expect(read).toHaveBeenCalledOnce();
    } finally {
      stop();
    }

    expect(sidebar()).toMatchObject({ status: "active", queuedWork: "none" });
    expect(sidebar()?.work?.waits).toEqual([]);
  });
});
