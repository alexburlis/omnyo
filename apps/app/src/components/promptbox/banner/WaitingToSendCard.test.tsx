// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "@/lib/send-outbox/send-outbox-entry";

const outbox = vi.hoisted(() => ({
  discardOutboxEntry: vi.fn(async () => undefined),
  retryOutboxEntry: vi.fn(async () => undefined),
}));

vi.mock("@/lib/send-outbox/send-outbox", () => ({
  discardOutboxEntry: outbox.discardOutboxEntry,
  outboxEntriesForConversation: () => [],
  readSendOutboxSnapshot: () => [],
  retryOutboxEntry: outbox.retryOutboxEntry,
  subscribeSendOutbox: () => () => undefined,
}));

import { WaitingToSendCard } from "./WaitingToSendCard";

function entry(
  submissionId: string,
  text: string,
  state: OutboxEntry["state"],
  files = 0,
): OutboxEntry {
  return {
    schema: 1,
    submissionId,
    storeId: "store-test",
    sequence: 1,
    createdAt: 1,
    action: {
      kind: "thread-message",
      projectId: "proj-1",
      target: { threadId: "thr-1" },
      message: {
        input: [
          { type: "text", text, mentions: [] },
          ...Array.from({ length: files }, (_, index) => ({
            type: "localFile" as const,
            path: `omnyo-outbox-attachment:${index}`,
            name: `file-${index}.txt`,
          })),
        ],
      },
    },
    attachments: [],
    state,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WaitingToSendCard", () => {
  it("renders nothing without waiting messages", () => {
    const { container } = render(<WaitingToSendCard entries={[]} />);

    expect(container.firstChild).toBeNull();
  });

  it("shows a waiting message with its files and offers no action that could duplicate it", () => {
    render(
      <WaitingToSendCard
        entries={[
          entry(
            "sub_00000000000000000000000000000001",
            "Fix the flaky test",
            { kind: "waiting" },
            2,
          ),
        ]}
      />,
    );

    expect(screen.getByText("Fix the flaky test")).not.toBeNull();
    expect(screen.getByText("Waiting to send")).not.toBeNull();
    expect(screen.getByText("Retrying automatically")).not.toBeNull();
    expect(screen.getByText("2 files")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows why a message was not sent and lets the person try again or discard it", () => {
    render(
      <WaitingToSendCard
        entries={[
          entry("sub_00000000000000000000000000000002", "Summarise changes", {
            kind: "paused",
            code: "thread_not_found",
            message: "Thread not found",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Not sent")).not.toBeNull();
    expect(screen.getByText("Thread not found")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(outbox.retryOutboxEntry).toHaveBeenCalledWith(
      "sub_00000000000000000000000000000002",
    );
    expect(outbox.discardOutboxEntry).toHaveBeenCalledWith(
      "sub_00000000000000000000000000000002",
    );
  });
});
