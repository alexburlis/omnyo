import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import { registerAsyncQuestions } from "./async-questions.js";
import { CODEX_ASYNC_QUESTION_RENDERER_ID } from "./async-question-form.js";

const THREAD_ID = "thr_async";

const PARENT_THREAD_ID = "thr_parent";

interface CodexQuestion {
  title: string;
  options: string[] | null;
}

function questionRow(
  seq: number,
  questions: CodexQuestion[] = [
    { title: "Choose a, b, or c.", options: ["a", "b", "c"] },
  ],
) {
  return {
    id: `event-${seq}`,
    threadId: THREAD_ID,
    seq,
    createdAt: seq,
    scope: { kind: "thread" },
    type: "thread/extensionState/updated",
    data: {
      kind: "provider-codex/async-question",
      payload: { itemId: `call-${seq}`, questions },
    },
  };
}

function nativeOption(value: string, label: string) {
  return { value, label, description: null, preview: null, recommended: false };
}

function nativeQuestion(
  index: number,
  prompt: string,
  options: ReturnType<typeof nativeOption>[] = [],
  context: string | null = null,
) {
  return {
    key: null,
    prompt,
    context,
    shortLabel: `Question ${index}`,
    mode: "required",
    multiSelect: false,
    allowFreeText: true,
    additiveNotes: true,
    delegable: false,
    options,
  };
}

function createHost(rows: ReturnType<typeof questionRow>[]): FakePluginHost {
  const host = createFakePluginHost({ pluginId: "provider-codex" });
  host.harness.sdk.stub(
    "threads.events.list",
    async (args: { afterSeq: string }) =>
      rows.filter((row) => row.seq > Number(args.afterSeq)),
  );
  host.harness.sdk.stub("threads.send", async () => ({}));
  registerAsyncQuestions(
    host.api as unknown as Parameters<typeof registerAsyncQuestions>[0],
  );

  return host;
}

async function notify(
  host: FakePluginHost,
  thread: Parameters<typeof makeThreadResponse>[0] = {},
) {
  await host.harness.emitThreadEvent("experimental_thread.events", {
    thread: makeThreadResponse({
      id: THREAD_ID,
      providerId: "codex",
      ...thread,
    }),
    sequence: 10,
  });
}

function stubAttention(host: FakePluginHost) {
  host.harness.sdk.stub("experimental_attention.command", async () => ({
    questions: [],
    callbacks: [],
    cleared: false,
    callbackMarker: null,
    routedToThreadId: PARENT_THREAD_ID,
  }));
}

const attentionCalls = (host: FakePluginHost) =>
  host.harness.sdk.callsTo("experimental_attention.command");

describe("Codex async questions", () => {
  it("retries a failed history scan on the next stream without advancing its cursor or duplicating the question", async () => {
    const rows = [questionRow(5)];
    const host = createHost(rows);
    let fail = true;
    host.harness.sdk.stub(
      "threads.events.list",
      async (args: { afterSeq: string }) => {
        if (fail) {
          fail = false;
          throw new Error("Temporary history read failure");
        }

        return rows.filter((row) => row.seq > Number(args.afterSeq));
      },
    );
    const thread = makeThreadResponse({ id: THREAD_ID, providerId: "codex" });

    try {
      const first = await host.harness.emitThreadEvent(
        "experimental_thread.events",
        {
          thread,
          sequence: 10,
          experimental_eventTypes: ["thread/extensionState/updated"],
          experimental_coveredSequence: { from: 10, to: 10 },
        },
      );

      expect(first.errors).toHaveLength(1);
      expect(
        await host.api.storage.kv.get(`async-question-cursor:${THREAD_ID}`),
      ).toBeUndefined();
      await host.harness.emitThreadEvent("experimental_thread.events", {
        thread,
        sequence: 11,
        experimental_eventTypes: ["item/agentMessage/delta"],
        experimental_coveredSequence: { from: 11, to: 11 },
      });
      await vi.waitFor(() =>
        expect(host.harness.pendingInteractions).toHaveLength(1),
      );
      await host.harness.emitThreadEvent("experimental_thread.events", {
        thread,
        sequence: 12,
        experimental_eventTypes: ["item/agentMessage/delta"],
        experimental_coveredSequence: { from: 12, to: 12 },
      });
      expect(host.harness.pendingInteractions).toHaveLength(1);
      expect(host.harness.sdk.callsTo("threads.events.list")).toEqual([
        [expect.objectContaining({ afterSeq: "0" })],
        [expect.objectContaining({ afterSeq: "0" })],
      ]);
      expect(
        await host.api.storage.kv.get(`async-question-cursor:${THREAD_ID}`),
      ).toBe(5);
    } finally {
      await host.harness.dispose();
    }
  });

  it("catches older pending questions after restart without rereading unchanged streams or advancing an unread cursor", async () => {
    const rows = [questionRow(5)];
    const original = createHost(rows);

    const host = await original.harness.reload((api) => {
      registerAsyncQuestions(api);
    });

    host.harness.sdk.stub(
      "threads.events.list",
      async (args: { afterSeq: string }) =>
        rows.filter((row) => row.seq > Number(args.afterSeq)),
    );

    const thread = makeThreadResponse({
      id: THREAD_ID,
      providerId: "codex",
    });

    try {
      await host.harness.emitThreadEvent("experimental_thread.events", {
        thread,
        sequence: 20,
        experimental_eventTypes: ["item/agentMessage/delta"],
        experimental_coveredSequence: { from: 20, to: 20 },
      });
      await vi.waitFor(() =>
        expect(host.harness.pendingInteractions).toHaveLength(1),
      );

      for (let sequence = 21; sequence <= 40; sequence += 1) {
        await host.harness.emitThreadEvent("experimental_thread.events", {
          thread,
          sequence,
          experimental_eventTypes: ["item/agentMessage/delta"],
          experimental_coveredSequence: { from: sequence, to: sequence },
        });
      }

      expect(host.harness.sdk.callsTo("threads.events.list")).toHaveLength(1);
      rows.push(questionRow(41));
      await host.harness.emitThreadEvent("experimental_thread.events", {
        thread,
        sequence: 99,
        experimental_eventTypes: ["thread/extensionState/updated"],
        experimental_coveredSequence: { from: 41, to: 41 },
      });
      await vi.waitFor(() =>
        expect(host.harness.pendingInteractions).toHaveLength(2),
      );
      expect(host.harness.sdk.callsTo("threads.events.list")).toEqual([
        [expect.objectContaining({ afterSeq: "0" })],
        [expect.objectContaining({ afterSeq: "5" })],
      ]);

      await host.harness.emitThreadEvent("experimental_thread.events", {
        thread,
        sequence: 100,
      });
      await vi.waitFor(() =>
        expect(host.harness.sdk.callsTo("threads.events.list")).toHaveLength(3),
      );
      expect(host.harness.sdk.callsTo("threads.events.list")[2]).toEqual([
        expect.objectContaining({ afterSeq: "41" }),
      ]);
    } finally {
      await host.harness.dispose();
    }
  });

  it("asks once in the thread and sends the answer as a message", async () => {
    const host = createHost([questionRow(5)]);

    await notify(host);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    expect(pending).toMatchObject({
      threadId: THREAD_ID,
      rendererId: CODEX_ASYNC_QUESTION_RENDERER_ID,
      presentation: {
        label: { pending: "Asking a question", completed: "Asked a question" },
      },
      payload: {
        questions: [{ title: "Choose a, b, or c.", options: ["a", "b", "c"] }],
      },
    });
    expect(attentionCalls(host)).toEqual([]);

    await notify(host);
    host.harness.submitInteraction(pending.id, {
      answers: { "question-1": { selected: ["option-2"] } },
    });

    await vi.waitFor(() =>
      expect(host.harness.sdk.callsTo("threads.send")).toEqual([
        [
          {
            threadId: THREAD_ID,
            mode: "auto",
            input: [
              {
                type: "text",
                text: "> Choose a, b, or c.\n\nb",
                mentions: [],
              },
            ],
          },
        ],
      ]),
    );
    await vi.waitFor(() =>
      expect(host.harness.sdk.callsTo("threads.events.list")).toHaveLength(2),
    );
    expect(host.harness.sdk.callsTo("threads.events.list")[1]?.[0]).toEqual(
      expect.objectContaining({ afterSeq: "5" }),
    );
    expect(host.harness.pendingInteractions).toHaveLength(0);
    expect(await pending.describeSubmission?.({ answers: {} })).toEqual({
      title: "Answered",
    });
  });

  it("opens every question without waiting for earlier answers", async () => {
    const host = createHost([questionRow(5), questionRow(6)]);

    await notify(host);

    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(2),
    );
  });

  it("does not send anything when the question is dismissed", async () => {
    const host = createHost([questionRow(5)]);

    await notify(host);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);

    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(0),
    );
    expect(host.harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("reads once for a burst of event batches and once more a second later", async () => {
    vi.useFakeTimers();

    try {
      let open = () => {};

      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });

      const host = createFakePluginHost({ pluginId: "provider-codex" });
      host.harness.sdk.stub("threads.events.list", async () => {
        await gate;

        return [];
      });
      registerAsyncQuestions(
        host.api as unknown as Parameters<typeof registerAsyncQuestions>[0],
      );
      const reads = () => host.harness.sdk.callsTo("threads.events.list");

      const notifications = Array.from({ length: 5 }, () => notify(host));
      await vi.advanceTimersByTimeAsync(0);
      expect(reads()).toHaveLength(1);

      open();
      await vi.advanceTimersByTimeAsync(999);
      expect(reads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads()).toHaveLength(2);
      await Promise.all(notifications);
      await vi.advanceTimersByTimeAsync(5000);
      expect(reads()).toHaveLength(2);

      await notify(host);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores threads from other providers", async () => {
    const host = createHost([questionRow(5)]);

    await notify(host, { providerId: "claude-code" });

    expect(host.harness.sdk.callsTo("threads.events.list")).toEqual([]);
  });

  it("opens a child chat's questions natively for its parent instead of asking the owner", async () => {
    const host = createHost([questionRow(5)]);
    stubAttention(host);

    await notify(host, { parentThreadId: PARENT_THREAD_ID });

    await vi.waitFor(() =>
      expect(attentionCalls(host)).toEqual([
        [
          {
            threadId: THREAD_ID,
            command: {
              action: "open",
              questions: [
                nativeQuestion(1, "Choose a, b, or c.", [
                  nativeOption("a", "a"),
                  nativeOption("b", "b"),
                  nativeOption("c", "c"),
                ]),
              ],
            },
          },
        ],
      ]),
    );
    expect(host.harness.pendingInteractions).toHaveLength(0);
    expect(host.harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it.each(["fork", "handoff"] as const)(
    "keeps asking in the chat itself for a %s with a parent",
    async (originKind) => {
      const host = createHost([questionRow(5)]);

      await notify(host, { parentThreadId: PARENT_THREAD_ID, originKind });

      await vi.waitFor(() =>
        expect(host.harness.pendingInteractions).toHaveLength(1),
      );
      expect(attentionCalls(host)).toEqual([]);
    },
  );

  it("maps odd Codex questions to valid native questions, ten per command", async () => {
    const extra = Array.from({ length: 7 }, (_unused, index) => ({
      title: `Extra ${index + 6}?`,
      options: null,
    }));

    const host = createHost([
      questionRow(5, [
        { title: "x".repeat(2500), options: null },
        { title: "Delete the branch?", options: ["Yes, delete it"] },
        { title: "Keep tests?", options: ["Yes", " yes ", "YES", "No"] },
        {
          title: "Pick a region.",
          options: Array.from({ length: 9 }, (_unused, index) => `r${index}`),
        },
        { title: "Name it.", options: ["y".repeat(200), "Short"] },
        ...extra,
      ]),
    ]);

    stubAttention(host);

    await notify(host, { parentThreadId: PARENT_THREAD_ID });

    const expected = [
      nativeQuestion(1, `${"x".repeat(1999)}…`),
      nativeQuestion(2, "Delete the branch?", [], "Choice:\n- Yes, delete it"),
      nativeQuestion(3, "Keep tests?", [
        nativeOption("a", "Yes"),
        nativeOption("b", "No"),
      ]),
      nativeQuestion(
        4,
        "Pick a region.",
        [],
        [
          "Choices:",
          ...Array.from({ length: 9 }, (_unused, index) => `- r${index}`),
        ].join("\n"),
      ),
      nativeQuestion(5, "Name it.", [
        nativeOption("a", `${"y".repeat(119)}…`),
        nativeOption("b", "Short"),
      ]),
      ...extra.map((question, index) =>
        nativeQuestion(index + 6, question.title),
      ),
    ];

    await vi.waitFor(() =>
      expect(attentionCalls(host)).toEqual([
        [
          {
            threadId: THREAD_ID,
            command: { action: "open", questions: expected.slice(0, 10) },
          },
        ],
        [
          {
            threadId: THREAD_ID,
            command: { action: "open", questions: expected.slice(10) },
          },
        ],
      ]),
    );
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });
});
