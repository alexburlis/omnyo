import { describe, expect, it } from "vitest";
import type { PromptInput, QueuedMessageWaitingOn } from "@omnyo/domain";
import { makeThreadQueuedMessage } from "@omnyo/test-helpers/domain-fixtures";
import {
  describeQueuedMessageWait,
  formatQueuedMessageCountdown,
  isQueuedMessageSendNowAllowed,
  queuedMessageCountdownInstant,
  queuedMessageFallbackTitle,
  queuedMessageHasWaitLine,
  queuedMessageSystemTitle,
  queuedMessageWaitIcon,
  projectQueuedMessagesForUpdate,
} from "./queued-message-wait";

const NOW = new Date(2026, 7, 28, 9, 0, 0).getTime();

function clockAt(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

function describeWait(
  waitingOn: QueuedMessageWaitingOn | null,
  overrides: {
    failureReason?: string | null;
    now?: number;
    pluginDisplayName?: string | null;
    sendAt?: number | null;
  } = {},
): string | null {
  return describeQueuedMessageWait({
    failureReason: overrides.failureReason ?? null,
    now: overrides.now ?? NOW,
    payload: { kind: "inline" },
    pluginDisplayName: overrides.pluginDisplayName ?? null,
    sendAt: overrides.sendAt ?? null,
    waitingOn,
  });
}

describe("describeQueuedMessageWait", () => {
  it("leaves an ordinary queued message unexplained", () => {
    expect(describeWait({ kind: "thread-busy" })).toBeNull();
    expect(describeWait(null)).toBeNull();
  });

  it("names each core wait a reader cannot otherwise explain", () => {
    expect(describeWait({ kind: "stopping" })).toBe(
      "Sending when the thread stops",
    );
    expect(describeWait({ kind: "turn-starting" })).toBe(
      "Waiting for turn to start",
    );
    expect(describeWait({ kind: "provisioning" })).toBe(
      "Waiting for workspace",
    );
    expect(describeWait({ kind: "interaction" })).toBe(
      "Waiting for your reply",
    );
    expect(describeWait({ kind: "server-update" })).toBe(
      "Sending after the update",
    );
    expect(describeWait({ kind: "superseded" })).toBe(
      "Not sent · a newer message was sent after it",
    );
  });

  it("names the absent machine a host-offline row is waiting on", () => {
    expect(describeWait({ kind: "host-offline", hostName: "M4" })).toBe(
      "Waiting for M4 to be ready",
    );
  });

  it("lets a failure outrank the wait the row is still waiting on", () => {
    expect(
      describeWait(
        { kind: "thread-busy" },
        { failureReason: "Host is not connected" },
      ),
    ).toBe("Host is not connected");
    expect(
      queuedMessageHasWaitLine({
        failureReason: "Host is not connected",
        payload: { kind: "inline" },
        waitingOn: { kind: "thread-busy" },
      }),
    ).toBe(true);
  });

  it("attributes a plugin wait by display name, falling back to its id", () => {
    const waitingOn: QueuedMessageWaitingOn = {
      kind: "plugin",
      pluginId: "concurrency-limit",
      reason: "4 of 4 running",
    };

    expect(
      describeWait(waitingOn, { pluginDisplayName: "Concurrency Limit" }),
    ).toBe("Held by Concurrency Limit · 4 of 4 running");
    expect(describeWait(waitingOn)).toBe(
      "Held by concurrency-limit · 4 of 4 running",
    );
  });

  it("carries the scheduled instant but never the countdown", () => {
    const label = describeWait({ kind: "time" }, { sendAt: NOW + 3 * HOUR });
    expect(label).toBe(`Scheduled for ${clockAt(NOW + 3 * HOUR)}`);
    expect(label).not.toMatch(/\bin \d/);
    expect(describeWait({ kind: "time" })).toBe("Scheduled");
  });

  it("leads a retry with why it is being retried, then when and which attempt", () => {
    expect(
      describeQueuedMessageWait({
        failureReason: null,
        now: NOW,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req-1",
          attempt: 2,
          reason: "Rate limited",
        },
        pluginDisplayName: null,
        sendAt: NOW + HOUR,
        waitingOn: { kind: "time" },
      }),
    ).toBe(`Rate limited · retrying at ${clockAt(NOW + HOUR)} · attempt 2`);
    expect(
      describeQueuedMessageWait({
        failureReason: null,
        now: NOW,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req-1",
          attempt: 2,
          reason: "Rate limited",
        },
        pluginDisplayName: "Concurrency limit",
        sendAt: null,
        waitingOn: {
          kind: "plugin",
          pluginId: "concurrency-limit",
          reason: "2 of 2 running on all hosts",
        },
      }),
    ).toBe(
      "Rate limited · held by Concurrency limit · 2 of 2 running on all hosts · attempt 2",
    );
    expect(
      describeQueuedMessageWait({
        failureReason: null,
        now: NOW,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req-1",
          attempt: 2,
          reason: "Rate limited",
        },
        pluginDisplayName: "Provider Retry",
        sendAt: NOW + HOUR,
        waitingOn: {
          kind: "plugin",
          pluginId: "provider-retry",
          reason: "Rate limited",
        },
      }),
    ).toBe(
      `Rate limited · held by Provider Retry · retrying at ${clockAt(NOW + HOUR)} · attempt 2`,
    );
    expect(
      describeQueuedMessageWait({
        failureReason: null,
        now: NOW,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req-1",
          attempt: 3,
          reason: "Rate limited",
        },
        pluginDisplayName: "Provider Retry",
        sendAt: null,
        waitingOn: {
          kind: "plugin",
          pluginId: "provider-retry",
          reason: "Rate limited until the account resets",
        },
      }),
    ).toBe(
      "Rate limited until the account resets · held by Provider Retry · attempt 3",
    );
  });
});

describe("queuedMessageWaitIcon", () => {
  it("gives every explained wait a glyph and the ordinary row none", () => {
    const icon = (
      waitingOn: QueuedMessageWaitingOn | null,
      failureReason: string | null = null,
    ) =>
      queuedMessageWaitIcon({
        failureReason,
        payload: { kind: "inline" },
        waitingOn,
      });

    expect(icon({ kind: "time" })).toBe("TimeSchedule");
    expect(icon({ kind: "turn-starting" })).toBe("TimeSchedule");
    expect(icon({ kind: "provisioning" })).toBe("Folder");
    expect(icon({ kind: "host-offline", hostName: "M4" })).toBe("CloudOff");
    expect(icon({ kind: "interaction" })).toBe("CircleQuestion");
    expect(icon({ kind: "plugin", pluginId: "p", reason: "r" })).toBeNull();
    expect(icon({ kind: "superseded" })).toBe("AlertCircle");
    expect(icon({ kind: "thread-busy" })).toBeNull();
    expect(icon(null)).toBeNull();
    expect(icon({ kind: "time" }, "Host is not connected")).toBe("AlertCircle");
  });

  it("marks a retry with the reload glyph regardless of its wait", () => {
    expect(
      queuedMessageWaitIcon({
        failureReason: null,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req-1",
          attempt: 2,
          reason: "Rate limited",
        },
        waitingOn: { kind: "plugin", pluginId: "provider-retry", reason: "r" },
      }),
    ).toBe("RotateCcw");
  });
});

describe("queuedMessageFallbackTitle", () => {
  it("names the failed turn a retry row re-submits", () => {
    expect(
      queuedMessageFallbackTitle({
        createdAt: NOW,
        now: NOW,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req-1",
          attempt: 2,
          reason: "Rate limited",
        },
      }),
    ).toBe(`Retry failed turn from ${clockAt(NOW)}`);
  });
});

describe("isQueuedMessageSendNowAllowed", () => {
  it.each([
    { waitingOn: null, allowed: true },
    { waitingOn: { kind: "time" }, allowed: true },
    { waitingOn: { kind: "superseded" }, allowed: true },
    {
      waitingOn: { kind: "plugin", pluginId: "limiter", reason: "busy" },
      allowed: true,
    },
    { waitingOn: { kind: "thread-busy" }, allowed: true },
    { waitingOn: { kind: "stopping" }, allowed: false },
    { waitingOn: { kind: "turn-starting" }, allowed: false },
    { waitingOn: { kind: "provisioning" }, allowed: false },
    { waitingOn: { kind: "interaction" }, allowed: false },
    { waitingOn: { kind: "host-offline", hostName: "M4" }, allowed: false },
    { waitingOn: { kind: "server-update" }, allowed: false },
  ] as const)(
    "allows manual recovery for $waitingOn",
    ({ waitingOn, allowed }) => {
      expect(
        isQueuedMessageSendNowAllowed({ waitingOn, failureReason: null }),
      ).toBe(allowed);
      expect(
        isQueuedMessageSendNowAllowed({
          waitingOn,
          failureReason: "Provider unavailable",
        }),
      ).toBe(waitingOn?.kind !== "server-update");
    },
  );
});

describe("projectQueuedMessagesForUpdate", () => {
  it("gives the actual update pause precedence while preserving the stored plugin hold", () => {
    const messages = [
      makeThreadQueuedMessage({
        waitingOn: { kind: "plugin", pluginId: "drafts", reason: "Draft" },
        failureReason: "The previous attempt failed",
      }),
    ];

    const paused = projectQueuedMessagesForUpdate({
      queuedMessages: messages,
      threadStatus: "idle",
      newTurnsPausedForUpdate: true,
    });

    const message = paused[0]!;
    expect(message.waitingOn).toEqual({ kind: "server-update" });
    expect(isQueuedMessageSendNowAllowed(message)).toBe(false);
    expect(
      describeQueuedMessageWait({
        ...message,
        now: NOW,
        pluginDisplayName: "Drafts",
      }),
    ).toBe("Sending after the update");
    expect(queuedMessageWaitIcon(message)).toBe("Download");
    expect(messages[0]?.waitingOn).toEqual({
      kind: "plugin",
      pluginId: "drafts",
      reason: "Draft",
    });
    expect(
      projectQueuedMessagesForUpdate({
        queuedMessages: messages,
        threadStatus: "idle",
        newTurnsPausedForUpdate: false,
      }),
    ).toBe(messages);
  });

  it.each(["active", "starting", "stopping"] as const)(
    "preserves the existing wait for a %s thread",
    (threadStatus) => {
      const messages = [
        makeThreadQueuedMessage({ waitingOn: { kind: "thread-busy" } }),
      ];

      expect(
        projectQueuedMessagesForUpdate({
          queuedMessages: messages,
          threadStatus,
          newTurnsPausedForUpdate: true,
        }),
      ).toBe(messages);
    },
  );
});

describe("formatQueuedMessageCountdown", () => {
  it("stays silent once the instant is due", () => {
    expect(formatQueuedMessageCountdown(0)).toBeNull();
    expect(formatQueuedMessageCountdown(-1)).toBeNull();
  });

  it("steps up a unit exactly at each boundary", () => {
    expect(formatQueuedMessageCountdown(1)).toBe("in 1s");
    expect(formatQueuedMessageCountdown(MINUTE - 1)).toBe("in 60s");
    expect(formatQueuedMessageCountdown(MINUTE)).toBe("in 1m");
    expect(formatQueuedMessageCountdown(HOUR - 1)).toBe("in 59m");
    expect(formatQueuedMessageCountdown(HOUR)).toBe("in 1h");
    expect(formatQueuedMessageCountdown(24 * HOUR - 1)).toBe("in 23h");
    expect(formatQueuedMessageCountdown(24 * HOUR)).toBe("in 1d");
  });
});

describe("queuedMessageCountdownInstant", () => {
  it("ticks only for a scheduled row", () => {
    expect(
      queuedMessageCountdownInstant({
        payload: { kind: "inline" },
        sendAt: NOW + HOUR,
        waitingOn: { kind: "time" },
      }),
    ).toBe(NOW + HOUR);
    expect(
      queuedMessageCountdownInstant({
        payload: { kind: "inline" },
        sendAt: NOW + HOUR,
        waitingOn: { kind: "provisioning" },
      }),
    ).toBeNull();
    expect(
      queuedMessageCountdownInstant({
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req-1",
          attempt: 2,
          reason: "Rate limited",
        },
        sendAt: NOW + HOUR,
        waitingOn: { kind: "time" },
      }),
    ).toBeNull();
  });
});

describe("queuedMessageSystemTitle", () => {
  const hiddenText: PromptInput = {
    type: "text",
    text: "Omnyo paused this turn to install an update.",
    mentions: [],
    visibility: "agent-only",
  };

  it("names a continuation held by an Omnyo update", () => {
    const message = makeThreadQueuedMessage({
      initiator: "system",
      payload: { kind: "continuation" },
      waitingOn: { kind: "server-update" },
      content: [hiddenText],
    });

    expect(queuedMessageSystemTitle(message)).toBe("Resume after update");
    expect(
      describeQueuedMessageWait({
        ...message,
        now: NOW,
        pluginDisplayName: null,
      }),
    ).toBe("Omnyo continues this turn when the update finishes");
    expect(queuedMessageWaitIcon(message)).toBe("Spinner");
  });

  it("names a continuation that is not held by an update", () => {
    expect(
      queuedMessageSystemTitle(
        makeThreadQueuedMessage({
          initiator: "system",
          payload: { kind: "continuation" },
          waitingOn: { kind: "thread-busy" },
          content: [hiddenText],
        }),
      ),
    ).toBe("Continue this turn");
  });

  it("names a wait wake-up instead of showing its marker", () => {
    expect(
      queuedMessageSystemTitle(
        makeThreadQueuedMessage({
          initiator: "system",
          messageSource: { kind: "script", label: "Wait" },
          content: [
            {
              type: "text",
              text: "[callback-wait:0f0e5b9d-5a7e-4c22-9d1f-4d3a8e6b1c2a] Ready: build.",
              mentions: [],
            },
          ],
        }),
      ),
    ).toBe("Wait check-in");
  });

  it("does not treat a user script named Wait as a system wake-up", () => {
    expect(
      queuedMessageSystemTitle(
        makeThreadQueuedMessage({
          messageSource: { kind: "script", label: "Wait" },
        }),
      ),
    ).toBeNull();
  });

  it("names inline input that only the agent can read", () => {
    expect(
      queuedMessageSystemTitle(
        makeThreadQueuedMessage({
          initiator: "system",
          content: [hiddenText],
        }),
      ),
    ).toBe("Message for the agent");
  });

  it("leaves retries and visible messages to their existing titles", () => {
    expect(
      queuedMessageSystemTitle(
        makeThreadQueuedMessage({
          payload: {
            kind: "retry",
            retryOfTurnRequestId: "req_1",
            attempt: 2,
            reason: "Network error",
          },
          content: [hiddenText],
        }),
      ),
    ).toBeNull();
    expect(queuedMessageSystemTitle(makeThreadQueuedMessage())).toBeNull();
    expect(
      queuedMessageSystemTitle(
        makeThreadQueuedMessage({
          initiator: "system",
          messageSource: { kind: "script", label: "Inbox" },
          content: [
            {
              type: "text",
              text: "1 chat waits on your result.",
              mentions: [],
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
