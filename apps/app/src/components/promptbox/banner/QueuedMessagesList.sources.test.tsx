// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { threadsQueryKey } from "@/hooks/queries/query-keys";
import {
  makeThreadListEntry,
  makeThreadQueuedMessage,
} from "@omnyo/test-helpers/domain-fixtures";
import type { QueuedMessagesListProps } from "./LazyQueuedMessagesList";
import { QueuedMessagesList as Queue } from "./QueuedMessagesList";

const noop = () => {};

afterEach(cleanup);

function QueuedMessagesList(
  props: Omit<
    QueuedMessagesListProps,
    "attachedToComposer" | "sendAction" | "expanded" | "onExpandedChange"
  >,
) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Queue
      {...props}
      attachedToComposer
      sendAction="send-now"
      expanded={expanded}
      onExpandedChange={setExpanded}
    />
  );
}

function makeQueuedMessage(id: string, text: string) {
  return makeThreadQueuedMessage({
    id,
    content: [{ type: "text", text, mentions: [] }],
  });
}

describe("Queued message sources", () => {
  it.each(["agent", "user", "system"] as const)(
    "labels queued sources for %s senders and refreshes their names",
    async (initiator) => {
      const queryClient = new QueryClient();

      const messages = [
        makeQueuedMessage("q_user", "User follow-up"),
        makeThreadQueuedMessage({
          id: "q_agent",
          initiator,
          senderThreadId: "thr_sender",
        }),
        makeThreadQueuedMessage({
          id: "q_system",
          initiator: "system",
          waitingOn: { kind: "provisioning" },
        }),
      ];

      const { container, getByText, getByRole } = render(
        <QueryClientProvider client={queryClient}>
          <QueuedMessagesList
            queuedMessages={messages}
            sendDisabled={false}
            actionDisabled={false}
            processingMessageId={null}
            processingAction={null}
            onSend={noop}
            onReorder={noop}
            onSetGroupBoundary={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </QueryClientProvider>,
      );

      fireEvent.click(
        getByRole("button", { name: /(?:Toggle|Show).*queued messages/ }),
      );
      expect(
        container.querySelector(
          '[data-queued-message-id="q_user"] [data-queued-message-sender]',
        ),
      ).toBeNull();
      expect(
        getByText("thr_sender").closest("[data-queued-message-metadata]"),
      ).not.toBeNull();
      expect(
        getByText("System")
          .closest("[data-queued-message-metadata]")
          ?.querySelector("[data-queued-message-wait]"),
      ).not.toBeNull();
      expect(
        getByText("thr_sender").closest(".prompt-mention-pill"),
      ).not.toBeNull();
      act(() => {
        queryClient.setQueryData(threadsQueryKey(), [
          makeThreadListEntry({ id: "thr_sender", title: "Code review" }),
        ]);
      });
      await waitFor(() => expect(getByText("Code review")).toBeTruthy());
      fireEvent.click(
        getByRole("button", { name: /(?:Toggle|Show).*queued messages/ }),
      );
      fireEvent.click(
        getByRole("button", { name: /(?:Toggle|Show).*queued messages/ }),
      );
      expect(getByText("Code review")).toBeTruthy();
      expect(getByText("System")).toBeTruthy();
      queryClient.clear();
    },
  );
});
