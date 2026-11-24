// @vitest-environment jsdom

import { StrictMode, type ComponentType, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { ThreadResponse } from "@omnyo/server-contract";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import {
  createPendingChat,
  getPendingChatSnapshot,
  pendingChatHandoffComposerHeight,
} from "@/lib/pending-chat-creations";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { PendingChatRoute } from "./PendingChatRoute";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function startPendingChat(
  projectId: string,
  prepare: () => Promise<void>,
  renderer: ComponentType<{ pendingId: string }> = () => (
    <p>Provisional chat</p>
  ),
) {
  const creation = createDeferredPromise<ThreadResponse>();

  const pending = createPendingChat({
    queueOwner: {},
    request: {
      projectId,
      providerId: "codex",
      model: "model",
      reasoningLevel: "high",
      permissionMode: "full",
      environment: { type: "reuse", environmentId: "environment-route" },
      executionInputSources: { providerId: "explicit" },
      input: [{ type: "text", text: "start the chat", mentions: [] }],
    },
    create: () => creation.promise,
    send: async () => {},
    renderer,
    prepare,
  });

  return { creation, pending };
}

function renderRoute(
  projectId: string,
  threadId: string,
  navigateInPane: PaneContextValue["navigateInPane"],
  wrap: (route: ReactNode) => ReactNode = (route) => route,
) {
  const pane: PaneContextValue = {
    paneId: "pane-pending-route",
    isFocused: true,
    isSplitPane: true,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: false,
    onRequestClose: null,
    isMaximized: false,
    onToggleMaximize: null,
    isBoundedPane: true,
    isTopRow: true,
    ownsWindowTopLeft: true,
    navigateInPane,
  };

  return render(
    wrap(
      <PaneContext.Provider value={pane}>
        <PendingChatRoute projectId={projectId} threadId={threadId} />
      </PaneContext.Provider>,
    ),
  );
}

describe("PendingChatRoute", () => {
  it("replaces the starting chat with the real chat while it is still on screen", async () => {
    const projectId = "project-pending-route-ready";
    const prepared = createDeferredPromise<void>();

    const { creation, pending } = startPendingChat(
      projectId,
      () => prepared.promise,
    );

    const startingChatShownAtSwap: boolean[] = [];

    const navigateInPane = vi.fn(() => {
      startingChatShownAtSwap.push(
        screen.queryByText("Provisional chat") !== null,
      );
    });

    renderRoute(projectId, pending.id, navigateInPane);

    await act(async () => {
      creation.resolve(makeThreadResponse({ id: "real-ready", projectId }));
      await pending.completion;
    });
    act(() => {
      getPromptDraftAccessor({
        kind: "thread",
        projectId,
        threadId: pending.id,
      }).setTextAndMentions("follow-up typed while starting", []);
    });

    expect(screen.getByText("Provisional chat")).toBeTruthy();
    expect(navigateInPane).not.toHaveBeenCalled();

    await act(async () => {
      prepared.resolve();
      await prepared.promise;
    });

    expect(navigateInPane).toHaveBeenCalledTimes(1);
    expect(navigateInPane).toHaveBeenCalledWith(
      { projectId, threadId: "real-ready" },
      { replace: true },
    );
    expect(startingChatShownAtSwap).toEqual([true]);
    expect(screen.queryByText(/Opening chat/)).toBeNull();
    expect(
      getPromptDraftAccessor({
        kind: "thread",
        projectId,
        threadId: "real-ready",
      }).getCurrent().text,
    ).toBe("follow-up typed while starting");
  });

  it("hands the starting chat's own composer height to the real chat at the swap", async () => {
    const projectId = "project-pending-route-measured";

    const composerWithHeight =
      (height: number) => (node: HTMLElement | null) => {
        if (node) node.getBoundingClientRect = () => ({ height }) as DOMRect;
      };

    const { creation, pending } = startPendingChat(
      projectId,
      async () => {},
      () => <form data-promptbox="" ref={composerWithHeight(126)} />,
    );

    renderRoute(projectId, pending.id, vi.fn(), (route) => (
      <>
        <form data-promptbox="" ref={composerWithHeight(300)} />
        {route}
      </>
    ));

    await act(async () => {
      creation.resolve(makeThreadResponse({ id: "real-measured", projectId }));
      await pending.completion;
    });

    expect(pendingChatHandoffComposerHeight("real-measured")).toBe(126);
  });

  it("opens the real chat when it exists but its first load failed", async () => {
    const projectId = "project-pending-route-open-failed";
    const navigateInPane = vi.fn();

    const { creation, pending } = startPendingChat(projectId, async () => {
      throw new Error("The new chat could not load yet.");
    });

    renderRoute(projectId, pending.id, navigateInPane);

    expect(screen.getByText("Provisional chat")).toBeTruthy();

    await act(async () => {
      creation.resolve(makeThreadResponse({ id: "real-route", projectId }));
      await pending.completion;
    });

    await waitFor(() => {
      expect(navigateInPane).toHaveBeenCalledWith(
        { projectId, threadId: "real-route" },
        { replace: true },
      );
    });
    expect(navigateInPane).toHaveBeenCalledTimes(1);
  });

  it("hands off once when it mounts after the chat became ready", async () => {
    const projectId = "project-pending-route-strict";
    const navigateInPane = vi.fn();
    const { creation, pending } = startPendingChat(projectId, async () => {});

    await act(async () => {
      creation.resolve(makeThreadResponse({ id: "real-strict", projectId }));
      await pending.completion;
    });
    await waitFor(() => {
      expect(getPendingChatSnapshot(pending.id)?.status).toBe("ready");
    });

    renderRoute(projectId, pending.id, navigateInPane, (route) => (
      <StrictMode>{route}</StrictMode>
    ));

    expect(navigateInPane).toHaveBeenCalledTimes(1);
    expect(navigateInPane).toHaveBeenCalledWith(
      { projectId, threadId: "real-strict" },
      { replace: true },
    );
    expect(screen.queryByText(/Opening chat/)).toBeNull();
  });

  it("redirects once from a starting chat that already opened", async () => {
    const projectId = "project-pending-route-redirect";
    const { creation, pending } = startPendingChat(projectId, async () => {});

    await act(async () => {
      creation.resolve(makeThreadResponse({ id: "real-redirect", projectId }));
      await pending.completion;
    });
    await waitFor(() => {
      expect(getPendingChatSnapshot(pending.id)?.status).toBe("ready");
    });
    renderRoute(projectId, pending.id, vi.fn());
    cleanup();

    const navigateInPane = vi.fn();

    const { container } = renderRoute(
      projectId,
      pending.id,
      navigateInPane,
      (route) => <StrictMode>{route}</StrictMode>,
    );

    expect(container.textContent).toBe("");
    await waitFor(() => {
      expect(navigateInPane).toHaveBeenCalledWith(
        { projectId, threadId: "real-redirect" },
        { replace: true },
      );
    });
    expect(navigateInPane).toHaveBeenCalledTimes(1);
  });

  it("keeps a chat that failed to start on screen and returns its draft to New chat", async () => {
    const projectId = "project-pending-route-failed";
    const navigateInPane = vi.fn();
    const { creation, pending } = startPendingChat(projectId, async () => {});

    renderRoute(projectId, pending.id, navigateInPane);
    act(() => {
      getPromptDraftAccessor({
        kind: "thread",
        projectId,
        threadId: pending.id,
      }).setTextAndMentions("keep this draft", []);
    });

    await act(async () => {
      creation.reject(new Error("create failed"));
      await pending.completion.catch(() => {});
    });

    expect(screen.getByText("Provisional chat")).toBeTruthy();
    expect(navigateInPane).not.toHaveBeenCalled();
    expect(
      getPromptDraftAccessor({ kind: "new-thread" }).getCurrent().text,
    ).toBe("keep this draft");
  });

  it("offers New chat for a starting chat that this tab no longer knows", () => {
    const navigateInPane = vi.fn();

    renderRoute(
      "project-pending-route-unknown",
      "pending_unknown",
      navigateInPane,
    );

    expect(
      screen.getByText(/Unfinished messages were recovered to New chat/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open New chat" })).toBeTruthy();
    expect(navigateInPane).not.toHaveBeenCalled();
  });
});
