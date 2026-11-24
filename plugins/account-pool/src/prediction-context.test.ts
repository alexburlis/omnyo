import { expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import {
  PREDICTION_CONTEXT_BUDGET_BYTES,
  predictionContext,
} from "./prediction-context.js";

type TestEvent = { seq: number; type: string; data: unknown };

function eventHost(events: TestEvent[]) {
  return createFakePluginHost({
    pluginId: "account-pool",
    sdk: {
      threads: {
        events: {
          list: async (input: {
            types?: readonly string[];
            afterSeq?: string;
            beforeSeq?: string;
            order?: "asc" | "desc";
            limit?: string;
          }) => {
            const page = events.filter(
              (event) =>
                (input.types === undefined ||
                  input.types.includes(event.type)) &&
                event.seq > Number(input.afterSeq) &&
                event.seq < Number(input.beforeSeq),
            );

            return (input.order === "desc" ? page.reverse() : page).slice(
              0,
              Number(input.limit),
            );
          },
        },
      },
    },
  });
}

it("retains earlier unfinished work and later corrections across Omnyo event pages", async () => {
  const events = [
    {
      seq: 1,
      type: "client/turn/requested",
      data: {
        requestId: "first",
        input: [{ type: "text", text: "Ship and verify the repair." }],
      },
    },
    { seq: 2, type: "turn/input/accepted", data: { clientRequestId: "first" } },
    ...Array.from({ length: 98 }, (_, index) => ({
      seq: index + 3,
      type: "item/completed",
      data: {
        item: {
          id: String(index),
          type: "agentMessage",
          text: "Verification remains.",
        },
      },
    })),
    {
      seq: 101,
      type: "client/turn/requested",
      data: {
        requestId: "correction",
        input: [
          { type: "text", text: "Also verify Claude background predictions." },
        ],
      },
    },
    {
      seq: 102,
      type: "turn/input/accepted",
      data: { clientRequestId: "correction" },
    },
    {
      seq: 103,
      type: "item/completed",
      data: {
        item: {
          id: "latest",
          type: "agentMessage",
          text: "Local checks passed; production is unverified.",
        },
      },
    },
  ];

  const host = eventHost(events);

  const context = JSON.parse(
    await predictionContext(
      host.api,
      "claude",
      103,
      new AbortController().signal,
    ),
  );

  expect(context).toHaveLength(101);
  expect(context[0]).toEqual({
    seq: 1,
    role: "user",
    text: "Ship and verify the repair.",
  });
  expect(context.slice(-2)).toEqual([
    {
      seq: 101,
      role: "user",
      text: "Also verify Claude background predictions.",
    },
    {
      seq: 103,
      role: "assistant",
      text: "Local checks passed; production is unverified.",
    },
  ]);
  await host.harness.dispose();
});

it("labels loop, agent and Omnyo messages so they are not mistaken for the user", async () => {
  const requested = (
    seq: number,
    requestId: string,
    text: string,
    origin: Record<string, unknown>,
  ) => [
    {
      seq,
      type: "client/turn/requested",
      data: { requestId, input: [{ type: "text", text }], ...origin },
    },
    {
      seq: seq + 1,
      type: "turn/input/accepted",
      data: { clientRequestId: requestId },
    },
  ];

  const events = [
    ...requested(1, "typed", "Watch the App Store review.", {
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
    }),
    ...requested(3, "loop", "Review check: reply in one line.", {
      senderThreadId: null,
      systemMessageKind: "external-message",
      systemMessageSubject: {
        kind: "message-source",
        source: { kind: "plugin", pluginId: "pursue" },
      },
    }),
    ...requested(5, "peer", "Send me the release result.", {
      senderThreadId: "thr_owner",
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
    }),
    ...requested(7, "child", "Child finished.", {
      senderThreadId: null,
      systemMessageKind: "child-completed",
      systemMessageSubject: null,
    }),
    {
      seq: 9,
      type: "item/completed",
      data: {
        item: { id: "reply", type: "agentMessage", text: "Still waiting." },
      },
    },
  ];

  const host = eventHost(events);

  const context = JSON.parse(
    await predictionContext(
      host.api,
      "claude",
      9,
      new AbortController().signal,
    ),
  );

  expect(context).toEqual([
    { seq: 1, role: "user", text: "Watch the App Store review." },
    {
      seq: 3,
      role: "automation",
      from: "plugin pursue",
      text: "Review check: reply in one line.",
    },
    {
      seq: 5,
      role: "agent",
      from: "thr_owner",
      text: "Send me the release result.",
    },
    { seq: 7, role: "omnyo", from: "child-completed", text: "Child finished." },
    { seq: 9, role: "assistant", text: "Still waiting." },
  ]);
  await host.harness.dispose();
});

it("reads complete message context past ten thousand irrelevant tool completions", async () => {
  const events = [
    {
      seq: 1,
      type: "client/turn/requested",
      data: {
        requestId: "first",
        input: [{ type: "text", text: "Verify the installation." }],
      },
    },
    { seq: 2, type: "turn/input/accepted", data: { clientRequestId: "first" } },
    ...Array.from({ length: 10_001 }, (_, index) => ({
      seq: index + 3,
      type: "item/completed",
      data: {
        item: {
          id: String(index),
          type: "commandExecution",
          text: "Tool output is excluded.",
        },
      },
    })),
    {
      seq: 10_004,
      type: "item/completed",
      data: {
        item: {
          id: "latest",
          type: "agentMessage",
          text: "Installation verification remains unfinished.",
        },
      },
    },
  ];

  const host = eventHost(events);

  try {
    const context = JSON.parse(
      await predictionContext(
        host.api,
        "claude",
        10_004,
        new AbortController().signal,
      ),
    );

    expect(context).toEqual([
      { seq: 1, role: "user", text: "Verify the installation." },
      {
        seq: 10_004,
        role: "assistant",
        text: "Installation verification remains unfinished.",
      },
    ]);
  } finally {
    await host.harness.dispose();
  }
});

it("keeps the first request and the newest messages when the chat exceeds the size limit", async () => {
  const filler = "x".repeat(20_000);

  const events: TestEvent[] = [
    {
      seq: 1,
      type: "client/turn/requested",
      data: {
        requestId: "first",
        input: [{ type: "text", text: "Install Kasten on the server." }],
      },
    },
    { seq: 2, type: "turn/input/accepted", data: { clientRequestId: "first" } },
    ...Array.from({ length: 60 }, (_, index) => ({
      seq: index + 3,
      type: "item/completed",
      data: {
        item: { id: String(index), type: "agentMessage", text: filler },
      },
    })),
    {
      seq: 63,
      type: "client/turn/requested",
      data: {
        requestId: "latest",
        input: [{ type: "text", text: "Continue with the key setup." }],
      },
    },
    {
      seq: 64,
      type: "turn/input/accepted",
      data: { clientRequestId: "latest" },
    },
    {
      seq: 65,
      type: "item/completed",
      data: {
        item: { id: "reply", type: "agentMessage", text: "Waiting on you." },
      },
    },
  ];

  const host = eventHost(events);

  try {
    const serialized = await predictionContext(
      host.api,
      "claude",
      65,
      new AbortController().signal,
    );

    const context = JSON.parse(serialized);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      PREDICTION_CONTEXT_BUDGET_BYTES,
    );
    expect(context.slice(0, 2)).toEqual([
      { seq: 1, role: "user", text: "Install Kasten on the server." },
      {
        role: "omnyo",
        from: "omitted-history",
        text: "Earlier messages are omitted to fit the prediction size limit.",
      },
    ]);
    expect(context[2].seq).toBeGreaterThan(3);
    expect(context.slice(-2)).toEqual([
      { seq: 63, role: "user", text: "Continue with the key setup." },
      { seq: 65, role: "assistant", text: "Waiting on you." },
    ]);
    expect(
      context
        .slice(2)
        .every((message: { seq: number }, index: number) =>
          index === 0 ? true : message.seq > context[index + 1].seq,
        ),
    ).toBe(true);
  } finally {
    await host.harness.dispose();
  }
});
