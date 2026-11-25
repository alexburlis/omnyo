import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  getPendingSentMessages,
  withPendingSentMessages,
} from "@/hooks/cache-owners/pending-sent-messages";
import { stageTimelineFollowUp } from "./stage-timeline-follow-up";
import { pendingTimelineSubmissions } from "./timeline-submissions";
import * as outbox from "./send-outbox";
import type { OutboxEntry } from "./send-outbox-entry";

vi.mock("../ws", () => ({
  wsManager: {
    getConnectionState: () => "connected",
    onConnected: () => () => undefined,
    onResumed: () => () => undefined,
  },
}));

vi.mock("./send-outbox", async (importOriginal) => {
  const original = await importOriginal<typeof outbox>();

  return {
    ...original,
    trackOutboxThreadMessage: vi.fn(original.trackOutboxThreadMessage),
    isSendOutboxAvailable: vi.fn(),
    stageThreadMessageInOutbox: vi.fn(),
  };
});

afterEach(() => {
  for (const result of vi.mocked(outbox.trackOutboxThreadMessage).mock
    .results) {
    if (result.type === "return") result.value.discard();
  }

  vi.clearAllMocks();
});

it("renders identical sends immediately and replaces only the confirmed submission", async () => {
  const queryClient = new QueryClient();
  const threadId = "thr_a";
  let resume!: (available: boolean) => void;
  vi.mocked(outbox.isSendOutboxAvailable).mockReturnValue(
    new Promise((resolve) => {
      resume = resolve;
    }),
  );
  const entries: OutboxEntry[] = [];
  vi.mocked(outbox.stageThreadMessageInOutbox).mockImplementation(
    async (args) => {
      entries.push({
        schema: 1,
        sequence: entries.length + 1,
        state: { kind: "waiting" },
        storeId: "store",
        submissionId: args.submissionId,
        createdAt: entries.length + 1,
        attachments: [],
        action: {
          kind: "thread-message",
          target: { threadId },
          projectId: "project",
          message: args.message,
        },
      });

      return "staged";
    },
  );

  const send = () =>
    stageTimelineFollowUp({
      queryClient,
      threadId,
      projectId: "project",
      execution: null,
      sourceOf: () => null,
      submission: {
        input: [{ type: "text", text: "same words", mentions: [] }],
        prepareInput: undefined,
        getDraft: () => ({ text: "same words", mentions: [], attachments: [] }),
      },
    });

  const first = send(),
    second = send();

  const immediate = getPendingSentMessages(queryClient, threadId);
  expect(immediate.map((item) => item.row.text)).toEqual([
    "same words",
    "same words",
  ]);
  expect(entries).toHaveLength(0);
  resume(true);
  expect(await Promise.all([first, second])).toEqual([true, true]);
  const staged = pendingTimelineSubmissions(threadId, entries, []);
  expect(staged.map((item) => item.row.id)).toEqual(
    immediate.map((item) => item.row.id),
  );
  const confirmed = { ...staged[0]!.row, id: "server:1" };
  expect(
    withPendingSentMessages({
      threadId,
      rows: [confirmed],
      pending: staged,
      maxSeq: 1,
    }).map((row) => row.id),
  ).toEqual(["server:1", immediate[1]!.row.id]);
  expect(
    pendingTimelineSubmissions(
      threadId,
      [
        {
          ...entries[0]!,
          state: { kind: "paused", code: "denied", message: "Denied" },
        },
      ],
      [],
    ),
  ).toHaveLength(0);
});

it.each(["unavailable", "failure"] as const)(
  "removes the click prediction after %s staging",
  async (outcome) => {
    vi.mocked(outbox.isSendOutboxAvailable).mockResolvedValue(
      outcome !== "unavailable",
    );
    vi.mocked(outbox.stageThreadMessageInOutbox).mockRejectedValue(
      new Error("Disk full"),
    );
    const queryClient = new QueryClient();

    const send = stageTimelineFollowUp({
      queryClient,
      threadId: "thr_failed",
      projectId: "proj_a",
      execution: null,
      sourceOf: () => null,
      submission: {
        input: [{ type: "text", text: "Send", mentions: [] }],
        prepareInput: undefined,
        getDraft: () => ({ text: "Send", mentions: [], attachments: [] }),
      },
    });

    const prediction = vi
      .mocked(outbox.trackOutboxThreadMessage)
      .mock.results.at(-1);

    if (prediction?.type !== "return") throw new Error("No click prediction");
    const discard = vi.spyOn(prediction.value, "discard");

    if (outcome === "failure") await expect(send).rejects.toThrow("Disk full");
    else expect(await send).toBe(false);
    expect(discard).toHaveBeenCalledOnce();
    expect(getPendingSentMessages(queryClient, "thr_failed")).toEqual([]);
    queryClient.clear();
  },
);
