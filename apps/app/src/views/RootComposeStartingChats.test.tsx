// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { ThreadResponse } from "@omnyo/server-contract";
import type { NewThreadComposerSubmission } from "@/components/promptbox/NewThreadComposer";
import { createPendingChat } from "@/lib/pending-chat-creations";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { RootComposeStartingChats } from "./RootComposeStartingChats";
import {
  PaneContext,
  type PaneContextValue,
} from "./thread-detail/PaneContext";

const noop = () => {};

function renderStartingChats(projectId: string) {
  const navigateInPane = vi.fn();

  const pane: PaneContextValue = {
    paneId: "pane-starting-chats",
    isFocused: true,
    isSplitPane: false,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: false,
    onRequestClose: null,
    isMaximized: false,
    onToggleMaximize: null,
    isBoundedPane: false,
    isTopRow: true,
    ownsWindowTopLeft: true,
    navigateInPane,
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <PaneContext.Provider value={pane}>{children}</PaneContext.Provider>
  );

  render(<RootComposeStartingChats projectId={projectId} />, { wrapper });

  return { navigateInPane };
}

function startChat({
  projectId,
  text,
  prepare = async () => {},
}: {
  projectId: string;
  text: string;
  prepare?: (threadId: string) => Promise<void>;
}) {
  const creation = createDeferredPromise<ThreadResponse>();

  const request: NewThreadComposerSubmission = {
    projectId,
    providerId: "codex",
    model: "model",
    reasoningLevel: "high",
    permissionMode: "full",
    environment: { type: "reuse", environmentId: "environment-starting" },
    executionInputSources: { providerId: "explicit" },
    input: [{ type: "text", text, mentions: [] }],
  };

  const pending = createPendingChat({
    queueOwner: {},
    request,
    create: () => creation.promise,
    send: async () => {},
    renderer: () => null,
    prepare,
  });

  return { pending, creation };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("RootComposeStartingChats", () => {
  it("shows a chat only while the server is still creating it and opens its provisional route", async () => {
    const projectId = "project-starting-open";

    const { pending, creation } = startChat({
      projectId,
      text: "fit the resources rail\n  vertically",
    });

    const { navigateInPane } = renderStartingChats(projectId);

    const row = screen.getByRole("button", {
      name: /Starting chat…\s*fit the resources rail vertically/,
    });

    fireEvent.click(row);
    expect(navigateInPane).toHaveBeenCalledWith({
      projectId,
      threadId: pending.id,
    });

    await act(async () => {
      creation.resolve(makeThreadResponse({ id: "real-open", projectId }));
      await pending.completion;
    });

    expect(screen.queryByRole("button", { name: /Starting chat/ })).toBeNull();
  });

  it("stays hidden once the chat exists even when its timeline never loads", async () => {
    const projectId = "project-starting-open-failed";

    const { pending, creation } = startChat({
      projectId,
      text: "never loads",
      prepare: async () => {
        throw new Error("The new chat could not load yet.");
      },
    });

    renderStartingChats(projectId);
    expect(screen.getByRole("button", { name: /never loads/ })).toBeTruthy();

    await act(async () => {
      creation.resolve(makeThreadResponse({ id: "real-failed", projectId }));
      await pending.completion;
    });

    expect(screen.queryByRole("button", { name: /never loads/ })).toBeNull();
  });

  it("hides a chat whose creation failed because its prompt returns to the draft", async () => {
    const projectId = "project-starting-failed";
    const { pending, creation } = startChat({ projectId, text: "rejected" });
    renderStartingChats(projectId);

    await act(async () => {
      creation.reject(new Error("offline"));
      await pending.completion.catch(noop);
    });

    expect(screen.queryByRole("button", { name: /rejected/ })).toBeNull();
  });

  it("ignores chats starting in another project", () => {
    startChat({ projectId: "project-starting-other", text: "elsewhere" });
    renderStartingChats("project-starting-here");

    expect(screen.queryByRole("status", { name: "Starting chats" })).toBeNull();
  });
});
