// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as renderBase,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderedMentionSuggestions } from "@omnyo/client-core";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  FollowUpPromptBox,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { sdk } from "@/lib/sdk";
import type { PromptBoxChatMenu } from "@/components/promptbox/PromptBoxActionsMenu";
import { MOTION_DURATION_MS, MOTION_EASE } from "@omnyo/shared-ui/motion";

function render(ui: ReactElement) {
  return renderBase(ui, { wrapper: createQueryClientTestHarness().wrapper });
}

const mocks = vi.hoisted(() => {
  const values = {
    captureHeight: vi.fn(),
    executionControls: vi.fn(),
    isCompactViewport: false,
    isPointerCoarse: false,
    scrollToBottom: vi.fn(),
    permissionModePicker: vi.fn(),
  };

  return Object.assign(values, {});
});

const NO_MENTION_SUGGESTIONS: OrderedMentionSuggestions = {
  groups: [],
  suggestions: [],
};

let resizeObserverCallback: ResizeObserverCallback | null = null;

vi.mock("@/components/ui/bottom-anchored-scroll-body.js", () => ({
  useBottomAnchoredScroll: () => ({
    isAtBottom: false,
    scrollToBottom: mocks.scrollToBottom,
    scrollElementIntoView: vi.fn(),
    scrollElementIntoViewClampedToMaxScroll: vi.fn(),
    holdContentPosition: vi.fn(),
  }),
}));

vi.mock("@omnyo/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => mocks.isCompactViewport,
}));

vi.mock("@omnyo/shared-ui/hooks/use-pointer-coarse", () => ({
  usePointerCoarse: () => mocks.isPointerCoarse,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      keybindings: [
        {
          command: "composer.focus",
          desktopOnly: false,
          shortcut: {
            key: "c",
            mod: false,
            meta: true,
            control: false,
            alt: false,
            shift: true,
          },
          when: {
            all: ["mainSurface", "promptAvailable"],
            none: [],
          },
        },
        {
          command: "composer.terminal.toggle",
          desktopOnly: false,
          shortcut: {
            key: "j",
            mod: false,
            meta: true,
            control: false,
            alt: false,
            shift: false,
          },
          when: {
            all: ["mainSurface", "promptAvailable"],
            none: ["modalOpen"],
          },
        },
      ],
    },
  }),
}));

vi.mock("@/components/promptbox/PromptBoxInternal", async () => {
  const { ComposerCommand, ComposerCommandOwnerProvider } =
    await import("@/components/promptbox/composer-commands");

  const { PromptBoxActionsMenu } =
    await import("@/components/promptbox/PromptBoxActionsMenu");

  return {
    DEFAULT_COMPOSER_SCOPE: { kind: "new-thread", projectId: null },
    PromptBoxInternal: ({
      chatMenu,
      footerStart,
      modeHeader,
      compact,
      onSubmit,
      onEscape,
      blurOnPointerSubmit,
      promptBoxRef,
      submission,
      submitAccessory,
      suppressPluginComposerCustomizations,
      onCollapse,
      heightAnimationKey,
      minHeight,
      placeholder,
      onFocusCommand,
    }: {
      chatMenu?: PromptBoxChatMenu;
      footerStart?: ReactNode;
      modeHeader?: ReactNode;
      compact?: {
        isCompact: boolean;
        placeholder?: string;
      };
      onSubmit: () => void;
      onEscape?: () => void;
      blurOnPointerSubmit?: boolean;
      promptBoxRef?: {
        current: {
          captureHeightForLayoutChange: () => void;
          focusEnd: () => void;
        } | null;
      };
      submission?: {
        onModifierSubmit?: () => void;
        swapSubmitActions?: boolean;
        showModifierSubmitAction?: boolean;
        title?: string;
        icon?: string;
        label?: string;
      };
      submitAccessory?: ReactNode;
      suppressPluginComposerCustomizations?: boolean;
      onCollapse?: () => void;
      heightAnimationKey?: string | number;
      minHeight?: number;
      placeholder?: string;
      onFocusCommand?: () => void;
    }) => (
      <>
        <ComposerCommandOwnerProvider value={() => true}>
          {onFocusCommand ? (
            <ComposerCommand command="composer.focus" run={onFocusCommand} />
          ) : null}
        </ComposerCommandOwnerProvider>
        <div
          data-testid="prompt-box"
          data-promptbox=""
          data-compact={compact?.isCompact}
          data-height-animation-key={heightAnimationKey}
          data-min-height={minHeight}
          data-placeholder={placeholder}
          data-submit-icon={submission?.icon}
          data-submit-label={submission?.label}
          data-plugin-customizations-suppressed={
            suppressPluginComposerCustomizations ? "true" : "false"
          }
        >
          {modeHeader}
          {chatMenu ? (
            <PromptBoxActionsMenu onAction={() => {}} chat={chatMenu} />
          ) : null}
          {footerStart}
          <input
            aria-label="Follow-up prompt"
            ref={(node) => {
              if (!promptBoxRef) return;
              promptBoxRef.current = node
                ? {
                    captureHeightForLayoutChange: mocks.captureHeight,
                    focusEnd: () => {
                      node.focus();
                      node.setSelectionRange(
                        node.value.length,
                        node.value.length,
                      );
                    },
                  }
                : null;
            }}
          />
          {compact?.isCompact ? <span>{compact.placeholder}</span> : null}
          <button
            type="button"
            onClick={(event) => {
              if (submission?.swapSubmitActions) {
                submission.onModifierSubmit?.();
              } else {
                onSubmit();
              }

              if (
                blurOnPointerSubmit &&
                event.detail > 0 &&
                document.activeElement instanceof HTMLElement
              ) {
                document.activeElement.blur();
              }
            }}
          >
            Submit
          </button>
          <button
            type="button"
            title={submission?.title}
            data-show-modifier-action={submission?.showModifierSubmitAction}
            onClick={
              submission?.swapSubmitActions
                ? onSubmit
                : submission?.onModifierSubmit
            }
          >
            Modifier submit
          </button>
          {submitAccessory}
          {onCollapse ? (
            <button type="button" onClick={onCollapse}>
              Collapse prompt box
            </button>
          ) : null}
          {onEscape ? (
            <button type="button" onClick={onEscape}>
              Escape
            </button>
          ) : null}
        </div>
      </>
    ),
  };
});

vi.mock("@/components/promptbox/usePromptVoice", () => ({
  usePromptVoice: () => ({
    state: "idle",
    isSupported: false,
    stream: null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  }),
}));

vi.mock("@/components/promptbox/ExecutionControls", () => ({
  ExecutionControls: (props: { disabled?: boolean }) => {
    mocks.executionControls(props);

    return <span data-testid="execution-controls" />;
  },
}));

vi.mock("@/components/pickers/PermissionModePicker", () => ({
  PermissionModePicker: (props: {
    disabled?: boolean;
    presentation?: "label" | "icon";
  }) => {
    mocks.permissionModePicker(props);

    return (
      <button type="button" disabled={props.disabled}>
        Permission mode
      </button>
    );
  },
}));

vi.mock("@/components/secondary-panel/lazySecondaryPanelComponents", () => ({
  LazyThreadTerminalPanel: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="composer-terminal-view" data-terminal-id={terminalId} />
  ),
}));

vi.mock("@/hooks/queries/host-queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHosts: () => ({
    data: [{ id: "host_test", name: "Studio Mac", status: "connected" }],
    isPending: false,
  }),
}));

vi.mock("@/views/thread-detail/ThreadTimelineScrollToBottomButton", () => ({
  ThreadTimelineScrollToBottomButton: () => null,
}));

vi.mock("@/components/thread/timeline", () => ({
  ThreadContextWindowIndicator: () => (
    <button type="button">Context window</button>
  ),
}));

const CONTEXT_WINDOW_USAGE = {
  usedTokens: 1000,
  modelContextWindow: 10000,
  estimated: false,
};

function createFollowUpPromptBoxProps(
  submitMode: FollowUpSubmitMode,
): Parameters<typeof FollowUpPromptBox>[0] {
  return {
    attachments: {
      items: [],
      projectId: "proj_test",
      isAttaching: false,
      error: null,
      onAttachFiles: vi.fn(),
      onUpdate: vi.fn(),
    },
    attention: null,
    stack: null,
    queuedMessageCount: 0,
    composer: {
      history: {
        currentDraft: { text: "Follow up", mentions: [], attachments: [] },
        entries: [],
        onSelectEntry: vi.fn(),
      },
      isFollowUpSubmitting: false,
      message: "Follow up",
      mentionRanges: [],
      onChangeMessage: vi.fn(),
      onModifierSubmit: vi.fn(),
      onSubmit: vi.fn(),
      compactPromptPlaceholder: "Ask a follow-up",
      promptPlaceholder: "Ask for a follow-up",
      canModifierSubmit: true,
      steerActiveThreadOnEnter: false,
      submitMode,
      threadRuntimeDisplayStatus:
        submitMode.kind === "queue" ? "active" : "idle",
    },
    contextWindowUsage: null,
    execution: {
      provider: {
        selectedId: "codex",
      },
      model: {
        selected: "gpt-5",
        options: [],
        moreOptions: [],
        isLoading: false,
        loadFailed: false,
        onChange: vi.fn(),
      },
      reasoning: {
        value: "medium",
        options: [],
        onChange: vi.fn(),
      },
      selection: { onChange: vi.fn() },
      catalog: { providers: [], verified: true, modelOptions: [] },
    },
    permission: {
      value: "accept-edits",
      options: [{ value: "accept-edits", label: "Accept Edits" }],
      onChange: vi.fn(),
      supported: true,
    },
    typeahead: {
      mention: {
        results: NO_MENTION_SUGGESTIONS,
        isLoading: false,
        isRefreshing: false,
        isError: false,
        onQueryChange: vi.fn(),
      },
      command: {
        triggers: [],
        suggestions: [],
        isLoading: false,
        isError: false,
        hasMore: false,
        isLoadingMore: false,
        loadMore: vi.fn(),
        onQueryChange: vi.fn(),
      },
    },
    collapseResetKey: "thr_test",
  };
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mocks.isCompactViewport = false;
  mocks.isPointerCoarse = false;
  resizeObserverCallback = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

describe("FollowUpPromptBox", () => {
  it("keeps the empty composer one height while stack cards come and go", () => {
    render(
      <FollowUpPromptBox
        {...createFollowUpPromptBoxProps({ kind: "ready" })}
        stack={<div data-testid="measured-stack">Stack</div>}
      />,
    );
    const promptBox = screen.getByTestId("prompt-box");
    const stackElement = screen.getByTestId("measured-stack").parentElement;

    if (!stackElement) throw new Error("Expected measured composer stack");
    expect(promptBox.dataset.minHeight).toBe("40");

    for (const height of [64, 35, 0]) {
      act(() => {
        resizeObserverCallback?.(
          [
            {
              target: stackElement,
              borderBoxSize: [{ blockSize: height }],
              contentRect: { height },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });
      expect(promptBox.dataset.minHeight).toBe("40");
    }
  });

  it("shows the empty phone composer as one row until it is used", async () => {
    mocks.isCompactViewport = true;
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    if (props.composer === null) throw new Error("Missing composer");
    props.composer.message = "";
    render(<FollowUpPromptBox {...props} />);
    const promptBox = screen.getByTestId("prompt-box");

    expect(promptBox.dataset.compact).toBe("true");
    expect(promptBox.dataset.heightAnimationKey).toBe("compact");
    expect(promptBox.dataset.placeholder).toBe("Ask a follow-up");

    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });
    act(() => input.focus());
    expect(promptBox.dataset.compact).toBe("false");
    expect(promptBox.dataset.minHeight).toBe("44");
    expect(mocks.captureHeight).toHaveBeenCalledTimes(1);

    const settle = () =>
      act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve));
      });

    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    await settle();
    expect(promptBox.dataset.compact).toBe("false");

    fireEvent.pointerDown(document.body);
    act(() => input.blur());
    await settle();
    expect(promptBox.dataset.compact).toBe("false");

    fireEvent.pointerUp(document.body);
    await settle();
    expect(promptBox.dataset.compact).toBe("true");
    expect(mocks.captureHeight).toHaveBeenCalledTimes(2);
  });

  it("keeps a phone composer with text at full size", () => {
    mocks.isCompactViewport = true;
    render(
      <FollowUpPromptBox
        {...createFollowUpPromptBoxProps({ kind: "ready" })}
      />,
    );

    expect(screen.getByTestId("prompt-box").dataset.compact).toBe("false");
  });

  it("tucks phone status cards behind a toggle while attention stays visible", () => {
    mocks.isCompactViewport = true;
    render(
      <FollowUpPromptBox
        {...createFollowUpPromptBoxProps({ kind: "ready" })}
        attention={<div>Needs attention</div>}
        stack={<div data-testid="status-card">Workflow running</div>}
      />,
    );

    const tray = screen
      .getByTestId("status-card")
      .closest<HTMLElement>("[data-composer-status-tray]");

    if (!tray) throw new Error("Expected status tray");
    expect(
      screen
        .getByText("Needs attention")
        .closest("[data-composer-status-tray]"),
    ).toBeNull();
    expect(tray.hasAttribute("inert")).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Show chat status" }),
    ).toBeNull();

    const content = tray.firstElementChild;

    if (!content) throw new Error("Expected status tray content");
    act(() => {
      resizeObserverCallback?.(
        [
          {
            target: content,
            borderBoxSize: [{ blockSize: 40 }],
            contentRect: { height: 40 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });

    const handle = screen.getByRole("button", { name: "Show chat status" });

    expect(handle.textContent).toBe("Chat status");
    expect(handle.closest("[data-promptbox]")).toBeNull();
    expect(handle.getAttribute("aria-controls")).toBe(tray.id);
    fireEvent.click(handle);
    expect(tray.hasAttribute("inert")).toBe(false);
    expect(tray.dataset.open).toBe("");
    expect(
      screen
        .getByRole("button", { name: "Hide chat status" })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    const reportHeight = (height: number) =>
      act(() => {
        resizeObserverCallback?.(
          [
            {
              target: content,
              borderBoxSize: [{ blockSize: height }],
              contentRect: { height },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });

    reportHeight(0);
    expect(screen.queryByRole("button", { name: /chat status/ })).toBeNull();
    reportHeight(40);
    expect(tray.hasAttribute("inert")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Show chat status" }),
    ).toBeTruthy();
  });

  it("counts queued messages on the phone status toggle", () => {
    mocks.isCompactViewport = true;
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    const { rerender } = render(
      <FollowUpPromptBox
        {...props}
        queuedMessageCount={2}
        stack={<div data-testid="status-card">Queued messages</div>}
      />,
    );

    const content = screen
      .getByTestId("status-card")
      .closest<HTMLElement>("[data-composer-status-tray]")?.firstElementChild;

    if (!content) throw new Error("Expected status tray content");
    act(() => {
      resizeObserverCallback?.(
        [
          {
            target: content,
            borderBoxSize: [{ blockSize: 40 }],
            contentRect: { height: 40 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });

    const toggle = screen.getByRole("button", {
      name: "Show chat status, 2 queued messages",
    });

    expect(
      toggle.querySelector("[data-composer-status-tray-queued-count]")
        ?.textContent,
    ).toBe("2");
    expect(toggle.textContent).toBe("2 queued");

    rerender(
      <FollowUpPromptBox
        {...props}
        queuedMessageCount={0}
        stack={<div data-testid="status-card">Glance</div>}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Show chat status" })
        .querySelector("[data-composer-status-tray-queued-count]"),
    ).toBeNull();
  });

  it.each([true, false])(
    "words a forced compaction above the phone composer only while a send would compact (compactFirst: %s)",
    (compactFirst) => {
      mocks.isCompactViewport = true;
      const onCompactFirstChange = vi.fn();
      const props = createFollowUpPromptBoxProps({ kind: "ready" });

      if (props.composer === null) throw new Error("Missing composer");
      props.composer.message = "";
      render(
        <FollowUpPromptBox
          {...props}
          compactBeforeSend={{
            compactFirst,
            tokens: 120_000,
            onCompactFirstChange,
          }}
        />,
      );

      expect(screen.queryByRole("button", { name: /tokens/ })).toBeNull();

      const notice = screen.queryByRole("region", {
        name: "Compact before sending",
      });

      if (!compactFirst) {
        expect(notice).toBeNull();

        return;
      }

      if (notice === null) throw new Error("Expected a compaction notice");
      expect(notice.textContent).toContain("Next send compacts 120k tokens");
      expect(notice.closest("[data-promptbox]")).toBeNull();
      fireEvent.click(
        within(notice).getByRole("button", { name: "Keep history" }),
      );
      expect(onCompactFirstChange).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("keeps the phone row to writing controls and labels this chat's settings in the + sheet", async () => {
    mocks.isCompactViewport = true;
    const onPermissionChange = vi.fn();
    const onCompactFirstChange = vi.fn();
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        machineId="host_test"
        permission={{
          value: "accept-edits",
          options: [
            { value: "accept-edits", label: "Accept Edits" },
            { value: "auto", label: "Approve for me" },
          ],
          onChange: onPermissionChange,
          supported: true,
        }}
        compactBeforeSend={{
          compactFirst: false,
          tokens: 182_000,
          onCompactFirstChange,
        }}
      />,
    );
    const promptBox = screen.getByTestId("prompt-box");

    for (const name of [
      /Execution machine/,
      "Permission mode",
      /chat status/,
      /tokens/,
      "More composer controls",
    ]) {
      expect(within(promptBox).queryByRole("button", { name })).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Prompt actions" }));
    fireEvent.click(
      await screen.findByRole("switch", { name: /Compact before sending/ }),
    );
    expect(onCompactFirstChange).toHaveBeenCalledExactlyOnceWith(true);
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Approve for me" }),
    );
    expect(onPermissionChange).toHaveBeenCalledExactlyOnceWith("auto");
  });

  it("keeps desktop chat controls in the composer row", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        machineId="host_test"
        compactBeforeSend={{
          compactFirst: true,
          tokens: 120_000,
          onCompactFirstChange: vi.fn(),
        }}
      />,
    );
    const promptBox = screen.getByTestId("prompt-box");

    expect(
      within(promptBox).getByRole("button", { name: /Execution machine/ }),
    ).toBeTruthy();
    expect(
      within(promptBox).getByRole("button", {
        name: "Compact 120k tokens before sending",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Compact before sending" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Prompt actions" })).toBeNull();
  });

  it("starts each phone chat with an idle composer and closed status", () => {
    mocks.isCompactViewport = true;
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    if (props.composer === null) throw new Error("Missing composer");
    props.composer.message = "";

    const { rerender } = render(
      <FollowUpPromptBox {...props} collapseResetKey="thr_a" />,
    );

    act(() => {
      screen.getByRole("textbox", { name: "Follow-up prompt" }).focus();
    });
    expect(screen.getByTestId("prompt-box").dataset.compact).toBe("false");
    rerender(<FollowUpPromptBox {...props} collapseResetKey="thr_b" />);
    expect(screen.getByTestId("prompt-box").dataset.compact).toBe("true");
    rerender(<FollowUpPromptBox {...props} collapseResetKey="thr_a" />);
    expect(screen.getByTestId("prompt-box").dataset.compact).toBe("true");
  });

  it("does not capture a height when focus keeps a drafted phone composer open", () => {
    mocks.isCompactViewport = true;
    render(
      <FollowUpPromptBox
        {...createFollowUpPromptBoxProps({ kind: "ready" })}
      />,
    );

    act(() => {
      screen.getByRole("textbox", { name: "Follow-up prompt" }).focus();
    });
    expect(mocks.captureHeight).not.toHaveBeenCalled();
  });

  it("shows status cards in place on wide screens", () => {
    render(
      <FollowUpPromptBox
        {...createFollowUpPromptBoxProps({ kind: "ready" })}
        attention={<div>Needs attention</div>}
        stack={<div data-testid="status-card">Workflow running</div>}
      />,
    );

    expect(
      screen.getByTestId("status-card").closest("[data-composer-status-tray]"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show chat status" }),
    ).toBeNull();
  });

  it("renders plugin banners above native stack content", () => {
    setPluginSlotRegistrations(
      "ordered-banner",
      makePluginRegistrationSet({
        composerCustomizations: [
          {
            id: "ordered",
            banners: [
              {
                id: "header",
                component: () => <div data-testid="plugin-header">Header</div>,
              },
            ],
          },
        ],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );
    const draft = { text: "Follow up", mentions: [], attachments: [] };
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        stack={<div data-testid="queued-messages">Queued messages</div>}
        pluginComposerHost={{
          scope: { kind: "thread", threadId: "thr_test" },
          textEffectKey: "thread:thr_test",
          getCurrent: () => draft,
          subscribeDraft: () => () => {},
          setDraft: vi.fn(),
          focus: vi.fn(),
        }}
        pluginComposerScope={{ kind: "thread", threadId: "thr_test" }}
      />,
    );

    const pluginHeaderRoot = screen
      .getByTestId("plugin-header")
      .closest("[data-omnyo-plugin-root]");

    const queuedMessages = screen.getByTestId("queued-messages");
    expect(queuedMessages.previousElementSibling).toBe(pluginHeaderRoot);
  });

  it("lays the banner stack on an explicit single-column track", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        stack={<div data-testid="queued-messages">Queued messages</div>}
      />,
    );

    const stack = screen.getByTestId("queued-messages").parentElement;
    expect(stack?.className).toContain("grid-cols-[minmax(0,1fr)]");
  });

  it("does not mount plugin banners for a retained inactive composer without a real scope", () => {
    setPluginSlotRegistrations(
      "inactive-banner",
      makePluginRegistrationSet({
        composerCustomizations: [
          {
            id: "inactive",
            banners: [
              {
                id: "banner",
                component: () => (
                  <div data-testid="inactive-plugin-banner">Plugin banner</div>
                ),
              },
            ],
          },
        ],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    render(
      <FollowUpPromptBox
        {...createFollowUpPromptBoxProps({ kind: "ready" })}
        stack={<div data-testid="retained-native-stack">Queued messages</div>}
        pluginComposerHost={null}
        pluginComposerScope={null}
        suppressPluginComposerCustomizations
      />,
    );

    expect(screen.getByTestId("retained-native-stack")).toBeTruthy();
    expect(screen.queryByTestId("inactive-plugin-banner")).toBeNull();
  });

  it("keeps the bottom composer mounted when its stack changes", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    const { container, rerender } = render(<FollowUpPromptBox {...props} />);
    const promptBox = screen.getByTestId("prompt-box");
    const input = screen.getByLabelText<HTMLInputElement>("Follow-up prompt");
    input.value = "Uncommitted editor state";
    input.focus();
    input.setSelectionRange(0, 0);

    expect(
      container
        .querySelector("[data-follow-up-composer-anchor]")
        ?.querySelector('[data-testid="prompt-box"]'),
    ).toBe(promptBox);

    rerender(
      <FollowUpPromptBox
        {...props}
        stack={<div data-testid="new-stack-item">Queue</div>}
      />,
    );

    expect(screen.getByTestId("new-stack-item")).toBeTruthy();
    expect(screen.getAllByTestId("prompt-box")).toHaveLength(1);
    expect(screen.getByLabelText("Follow-up prompt")).toBe(input);
    expect(input.value).toBe("Uncommitted editor state");
    fireEvent.click(screen.getByText("Submit"));
    expect(props.composer?.onSubmit).toHaveBeenCalledOnce();
  });

  it("keeps the editor mounted and hidden while a pending interaction takes its place", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    const { container, rerender } = render(<FollowUpPromptBox {...props} />);
    const promptBox = screen.getByTestId("prompt-box");
    const input = screen.getByLabelText<HTMLInputElement>("Follow-up prompt");
    input.value = "Draft typed before the approval";

    const composerShell = container.querySelector<HTMLElement>(
      "[data-follow-up-composer]",
    );

    expect(composerShell?.hidden).toBe(false);

    rerender(
      <FollowUpPromptBox
        {...props}
        composer={{
          ...props.composer!,
          submitMode: { kind: "blocked", reason: "pending-interaction" },
        }}
        stack={<div data-testid="pending-stack">Plan mode</div>}
        pendingInteraction={
          <div data-testid="pending-interaction">Allow file write?</div>
        }
      />,
    );

    expect(screen.getByTestId("prompt-box")).toBe(promptBox);
    expect(screen.getByLabelText("Follow-up prompt")).toBe(input);
    expect(input.value).toBe("Draft typed before the approval");
    expect(composerShell?.hidden).toBe(true);
    const interaction = screen.getByTestId("pending-interaction");
    const stackItem = screen.getByTestId("pending-stack");
    expect(
      stackItem.compareDocumentPosition(interaction) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      interaction.compareDocumentPosition(promptBox) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    rerender(<FollowUpPromptBox {...props} />);

    expect(screen.getByTestId("prompt-box")).toBe(promptBox);
    expect(screen.getByLabelText("Follow-up prompt")).toBe(input);
    expect(composerShell?.hidden).toBe(false);
    expect(screen.queryByTestId("pending-interaction")).toBeNull();
  });

  it.each([
    ["main-thread", true],
    ["side-chat", false],
  ] as const)(
    "renders queued-message banners before the %s inline composer",
    (_kind, isPrimaryComposer) => {
      setPluginSlotRegistrations(
        "queued-tools",
        makePluginRegistrationSet({
          composerCustomizations: [
            {
              id: "queued-banner",
              scopes: ["queued-message"],
              banners: [
                {
                  id: "status",
                  chrome: "bare",
                  component: () => (
                    <div data-testid="queued-plugin-banner">Queued status</div>
                  ),
                },
              ],
            },
          ],
          pendingInteractions: [],
          sidebarFooterActions: [],
          fileOpeners: [],
        }),
      );
      const draft = { text: "Queued draft", mentions: [], attachments: [] };

      const scope = {
        kind: "queued-message" as const,
        threadId: "thr_test",
        queuedMessageId: "queued_1",
      };

      const props = createFollowUpPromptBoxProps({ kind: "ready" });
      render(
        <FollowUpPromptBox
          {...props}
          isPrimaryComposer={isPrimaryComposer}
          pluginComposerHost={{
            scope,
            textEffectKey: "queued:queued_1",
            getCurrent: () => draft,
            subscribeDraft: () => () => {},
            setDraft: vi.fn(),
            focus: vi.fn(),
          }}
          pluginComposerScope={scope}
        />,
      );

      const banner = screen.getByTestId("queued-plugin-banner");
      const promptBox = screen.getByTestId("prompt-box");
      expect(
        banner.compareDocumentPosition(promptBox) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(screen.getAllByTestId("queued-plugin-banner")).toHaveLength(1);
    },
  );

  it("forwards customization suppression changes without remounting the composer", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    const { rerender } = render(
      <FollowUpPromptBox {...props} suppressPluginComposerCustomizations />,
    );

    const promptBox = screen.getByTestId("prompt-box");
    const input = screen.getByLabelText("Follow-up prompt");

    expect(promptBox.dataset.pluginCustomizationsSuppressed).toBe("true");

    rerender(
      <FollowUpPromptBox
        {...props}
        suppressPluginComposerCustomizations={false}
      />,
    );

    expect(screen.getByTestId("prompt-box")).toBe(promptBox);
    expect(screen.getByLabelText("Follow-up prompt")).toBe(input);
    expect(promptBox.dataset.pluginCustomizationsSuppressed).toBe("false");
  });

  it("scrolls to the bottom after submitting a ready follow-up", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(<FollowUpPromptBox {...props} />);

    fireEvent.click(screen.getByText("Submit"));

    expect(props.composer?.onSubmit).toHaveBeenCalledOnce();
    expect(mocks.scrollToBottom).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps exit handoff available without replacing the editor (compact viewport: %s)",
    (isCompactViewport) => {
      mocks.isCompactViewport = isCompactViewport;
      const props = createFollowUpPromptBoxProps({ kind: "ready" });

      const handoff = {
        sourceProviderId: "codex",
        active: false,
        onStart: vi.fn(),
        onExit: vi.fn(),
        onSelect: vi.fn(),
      };

      props.execution.handoff = handoff;
      const { rerender } = render(<FollowUpPromptBox {...props} />);
      const editor = screen.getByLabelText("Follow-up prompt");
      expect(screen.queryByRole("button", { name: "Exit handoff" })).toBeNull();

      rerender(
        <FollowUpPromptBox
          {...props}
          execution={{
            ...props.execution,
            handoff: { ...handoff, active: true },
          }}
        />,
      );
      expect(screen.getByLabelText("Follow-up prompt")).toBe(editor);
      expect(screen.getByText("Handoff to new thread")).not.toBeNull();
      const exit = screen.getByRole("button", { name: "Exit handoff" });
      expect(exit.textContent).toBe("");
      fireEvent.click(exit);
      expect(handoff.onExit).toHaveBeenCalledOnce();

      rerender(<FollowUpPromptBox {...props} />);
      expect(screen.queryByRole("button", { name: "Exit handoff" })).toBeNull();
      expect(screen.getByLabelText("Follow-up prompt")).toBe(editor);
    },
  );

  it("forwards the composer's host Escape action", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    const onEscape = vi.fn();

    if (!props.composer) throw new Error("Expected follow-up composer props");
    props.composer.onEscape = onEscape;

    render(<FollowUpPromptBox {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Escape" }));

    expect(onEscape).toHaveBeenCalledOnce();
  });

  it.each([
    {
      setting: false,
      primaryAction: "queue",
      modifierAction: "steer",
    },
    {
      setting: true,
      primaryAction: "steer",
      modifierAction: "queue",
    },
  ] as const)(
    "routes Enter/click to $primaryAction and Command+Enter to $modifierAction when steer-on-Enter is $setting",
    ({ setting, primaryAction, modifierAction }) => {
      const props = createFollowUpPromptBoxProps({
        kind: "queue",
        onStop: vi.fn(),
      });

      if (!props.composer) {
        throw new Error("Expected follow-up composer props");
      }

      props.composer.steerActiveThreadOnEnter = setting;
      render(<FollowUpPromptBox {...props} />);

      fireEvent.click(screen.getByText("Submit"));

      const expectedPrimary =
        primaryAction === "queue"
          ? props.composer.onSubmit
          : props.composer.onModifierSubmit;

      const expectedModifier =
        modifierAction === "queue"
          ? props.composer.onSubmit
          : props.composer.onModifierSubmit;

      expect(expectedPrimary).toHaveBeenCalledOnce();
      expect(expectedModifier).not.toHaveBeenCalled();
      expect(mocks.scrollToBottom).toHaveBeenCalledTimes(
        primaryAction === "steer" ? 1 : 0,
      );

      fireEvent.click(screen.getByText("Modifier submit"));
      expect(expectedModifier).toHaveBeenCalledOnce();
      expect(mocks.scrollToBottom).toHaveBeenCalledOnce();
      expect(
        screen
          .getByText("Modifier submit")
          .getAttribute("data-show-modifier-action"),
      ).toBe("true");
    },
  );

  it.each([
    { setting: false, icon: "ListEnd" },
    { setting: true, icon: undefined },
  ])(
    "shows the queue icon only when Enter queues (steer-on-Enter $setting)",
    ({ setting, icon }) => {
      const props = createFollowUpPromptBoxProps({
        kind: "queue",
        onStop: vi.fn(),
      });

      if (!props.composer) {
        throw new Error("Expected follow-up composer props");
      }

      props.composer.steerActiveThreadOnEnter = setting;
      props.composer.queuedSendForecast = {
        waitingOn: { kind: "host-offline", hostName: "Mac Pro" },
        sendAt: null,
      };
      render(<FollowUpPromptBox {...props} />);

      expect(screen.queryByRole("status", { name: /Mac Pro/ })).toBeNull();
      expect(screen.getByTestId("prompt-box").dataset.submitIcon).toBe(icon);
      expect(
        screen.getByText("Modifier submit").getAttribute("title"),
      ).not.toBe("Queue message (Enter)");
    },
  );

  it("keeps save shortcuts without offering an alternate send action in a ready editor", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(<FollowUpPromptBox {...props} />);
    const modifier = screen.getByText("Modifier submit");
    expect(modifier.getAttribute("data-show-modifier-action")).toBe("false");
    fireEvent.click(modifier);
    expect(props.composer?.onModifierSubmit).toHaveBeenCalledOnce();
  });

  it.each([
    { setting: false, title: "Queue follow-up (Enter), Ctrl + Enter to steer" },
    {
      setting: true,
      title: "Steer current run (Enter), Ctrl + Enter to queue",
    },
  ])(
    "shows the platform modifier shortcut in the submit title when steer-on-Enter is $setting",
    ({ setting, title }) => {
      const platformMock = vi
        .spyOn(navigator, "platform", "get")
        .mockReturnValue("Win32");

      try {
        const props = createFollowUpPromptBoxProps({
          kind: "queue",
          onStop: vi.fn(),
        });

        if (!props.composer) {
          throw new Error("Expected follow-up composer props");
        }

        props.composer.steerActiveThreadOnEnter = setting;
        render(<FollowUpPromptBox {...props} />);

        expect(screen.getByText("Modifier submit").getAttribute("title")).toBe(
          title,
        );
      } finally {
        platformMock.mockRestore();
      }
    },
  );

  it("disables the permission picker while plan mode is active", () => {
    const props = createFollowUpPromptBoxProps({
      kind: "queue",
      onStop: vi.fn(),
    });

    render(
      <FollowUpPromptBox
        {...props}
        activePromptMode={{
          mode: "plan",
          providerId: "codex",
          prompt: "inspect the failing test",
        }}
      />,
    );

    expect(mocks.permissionModePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        disabled: true,
        presentation: "icon",
      }),
    );
  });

  it("keeps compaction and approvals accessible without a context ring", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        contextWindowUsage={CONTEXT_WINDOW_USAGE}
        compactBeforeSend={{
          compactFirst: true,
          tokens: 120_000,
          onCompactFirstChange: vi.fn(),
        }}
      />,
    );

    const accessoryOrder = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent)
      .filter(
        (label) =>
          label?.startsWith("Compact ") ||
          label === "Context window" ||
          label === "Permission mode",
      );

    expect(accessoryOrder).toEqual([
      expect.stringMatching(/^Compact .+ tokens before sending$/),
      "Permission mode",
    ]);

    expect(screen.queryByRole("button", { name: "Context window" })).toBeNull();
    expect(screen.queryByText("Compact 120k")).toBeNull();

    for (const name of ["Permission mode"]) {
      expect(
        screen
          .getByRole("button", { name })
          .closest("[data-promptbox-expanded-only]"),
      ).not.toBeNull();
    }
  });

  it("puts the session mode control right after the model picker", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        sessionOptionsControl={<button type="button">Session options</button>}
      />,
    );

    expect(screen.getByTestId("execution-controls").nextElementSibling).toBe(
      screen.getByRole("button", { name: "Session options" }),
    );
  });

  it("can lock permission without disabling execution controls", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    render(<FollowUpPromptBox {...props} permissionReadOnly />);

    expect(mocks.executionControls).toHaveBeenCalledWith(
      expect.objectContaining({
        disabled: false,
      }),
    );
    expect(mocks.permissionModePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        disabled: true,
      }),
    );
  });

  it.each([false, true])(
    "keeps controls steady once used, through blur and submit (compact viewport: %s)",
    (isCompactViewport) => {
      mocks.isCompactViewport = isCompactViewport;
      mocks.isPointerCoarse = isCompactViewport;
      const props = createFollowUpPromptBoxProps({ kind: "ready" });

      if (props.composer === null) throw new Error("composer required");
      props.composer = { ...props.composer, message: "" };
      props.contextWindowUsage = CONTEXT_WINDOW_USAGE;
      render(<FollowUpPromptBox {...props} />);
      const input = screen.getByRole("textbox", { name: "Follow-up prompt" });

      const controls = () => {
        expect(
          screen.queryByRole("button", { name: "Permission mode" }) !== null,
        ).toBe(!isCompactViewport);
        expect(
          document.querySelector("[data-follow-up-composer-expanded]"),
        ).not.toBeNull();
      };

      if (isCompactViewport) {
        expect(
          screen.queryByRole("button", { name: "Permission mode" }),
        ).toBeNull();
        expect(
          document.querySelector("[data-follow-up-composer-expanded]"),
        ).toBeNull();
      } else {
        controls();
      }

      act(() => input.focus());
      controls();
      act(() => input.blur());
      controls();
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
      controls();
    },
  );

  it("keeps the desktop composer available without a collapse control", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(<FollowUpPromptBox {...props} />);
    expect(
      screen.queryByRole("button", { name: "Collapse prompt box" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Permission mode" }),
    ).toBeTruthy();
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      null,
    );
  });

  describe("arriving from a starting chat", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function renderArrival(arrivalHeight: number | null) {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        height: 149,
      } as DOMRect);
      const styleChanges = new MutationObserver(() => {});
      styleChanges.observe(document.body, {
        subtree: true,
        attributeFilter: ["style"],
        attributeOldValue: true,
      });
      const props = createFollowUpPromptBoxProps({ kind: "ready" });
      render(<FollowUpPromptBox {...props} arrivalHeight={arrivalHeight} />);
      const promptBox = screen.getByTestId("prompt-box");

      const heights = styleChanges
        .takeRecords()
        .filter((record) => record.target === promptBox)
        .map((record) => record.oldValue ?? "");

      styleChanges.disconnect();

      return { heights: [...heights, promptBox.style.cssText], promptBox };
    }

    function endHeightTransition(element: HTMLElement) {
      const event = new Event("transitionend");
      Object.defineProperty(event, "propertyName", { value: "height" });
      element.dispatchEvent(event);
    }

    it("glides from the starting chat's composer height to its own, then lets go", () => {
      const { heights, promptBox } = renderArrival(126);

      expect(heights.some((style) => style.includes("height: 126px"))).toBe(
        true,
      );
      expect(promptBox.style.height).toBe("149px");
      expect(promptBox.style.transition).toContain(
        `height ${MOTION_DURATION_MS.base}ms ${MOTION_EASE.smooth}`,
      );

      endHeightTransition(promptBox);

      expect(promptBox.style.height).toBe("");
      expect(promptBox.style.transition).toBe("");
      expect(promptBox.style.overflow).toBe("");
    });

    it("stays still under reduced motion", () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );

      expect(renderArrival(126).heights.join("")).not.toContain("height");
    });

    it("stays still for an ordinary open", () => {
      expect(renderArrival(null).heights.join("")).not.toContain("height");
    });
  });

  it("toggles composer focus without collapsing the desktop layout", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <AppCommandProvider>
        <FollowUpPromptBox {...props} />
      </AppCommandProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });

    act(() => input.focus());
    fireEvent.keyDown(input, { key: "c", metaKey: true, shiftKey: true });

    expect(document.activeElement).not.toBe(input);
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      null,
    );
    expect(
      screen.getByRole("button", { name: "Permission mode" }),
    ).toBeTruthy();

    fireEvent.keyDown(window, { key: "c", metaKey: true, shiftKey: true });

    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      null,
    );
    expect(
      screen.getByRole("button", { name: "Permission mode" }),
    ).toBeTruthy();
  });

  it("keeps the composer mounted across compact breakpoint changes", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    const { rerender } = render(<FollowUpPromptBox {...props} />);
    const initialPromptBox = screen.getByTestId("prompt-box");

    mocks.isCompactViewport = true;
    rerender(<FollowUpPromptBox {...props} focusEndKey="mobile" />);

    expect(screen.getByTestId("prompt-box")).toBe(initialPromptBox);
  });

  it("uses the caller-specific compact placeholder", () => {
    const props = createFollowUpPromptBoxProps({
      kind: "queue-while-stopping",
    });

    if (props.composer === null) throw new Error("Missing composer");
    props.composer.message = "";
    props.composer.compactPromptPlaceholder = "Stopping side chat...";
    props.composer.promptPlaceholder = "Stopping side chat...";
    mocks.isCompactViewport = true;
    render(<FollowUpPromptBox {...props} />);

    expect(screen.getByText("Stopping side chat...")).toBeTruthy();
  });
  describe("shell commands", () => {
    const session = {
      id: "term_composer",
      threadId: "thr_test",
      environmentId: null,
      hostId: "host_test",
      title: "Chat terminal",
      initialCwd: "/work",
      cols: 100,
      rows: 30,
      status: "running" as const,
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    };

    const promptOutput = {
      chunks: [{ seq: 0, dataBase64: btoa("% ") }],
      nextSeq: 1,
      truncated: false,
      status: "running" as const,
      exitCode: null,
      closeReason: null,
    };

    function renderShellComposer(message: string) {
      const props = createFollowUpPromptBoxProps({ kind: "ready" });

      if (props.composer === null) throw new Error("Missing composer");
      props.composer.message = message;

      props.composer.queuedSendForecast = {
        waitingOn: { kind: "host-offline", hostName: "Mac Pro" },
        sendAt: null,
      };

      const create = vi
        .spyOn(sdk.terminals, "create")
        .mockResolvedValue(session);

      const output = vi
        .spyOn(sdk.terminals, "output")
        .mockResolvedValue(promptOutput);

      const input = vi.spyOn(sdk.terminals, "input").mockResolvedValue(session);
      vi.spyOn(sdk.terminals, "list").mockResolvedValue({
        sessions: [session],
      });
      render(
        <AppCommandProvider>
          <FollowUpPromptBox
            {...props}
            pluginComposerScope={{ kind: "thread", threadId: "thr_test" }}
          />
        </AppCommandProvider>,
      );

      return { composer: props.composer, create, input, output };
    }

    afterEach(() => {
      localStorage.clear();
      vi.restoreAllMocks();
    });

    it("runs a ! message in the chat terminal instead of sending it", async () => {
      const { composer, create, input } = renderShellComposer(
        "! python3 fix.py ~/a.ts",
      );

      expect(screen.getByText("Runs in terminal")).toBeTruthy();
      expect(screen.queryByRole("status", { name: /Mac Pro/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));

      expect(await screen.findByTestId("composer-terminal-view")).toBeTruthy();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { kind: "thread", threadId: "thr_test" },
          start: { mode: "shell" },
        }),
      );
      expect(input).toHaveBeenCalledWith({
        terminalId: "term_composer",
        dataBase64: btoa("python3 fix.py ~/a.ts\r"),
      });
      expect(composer.onSubmit).not.toHaveBeenCalled();
      expect(composer.onChangeMessage).toHaveBeenCalledWith("", []);
      expect(screen.getByTestId("prompt-box").parentElement?.className).toBe(
        "hidden",
      );
    });

    it("types the first command only after a new shell shows its prompt", async () => {
      const { input, output } = renderShellComposer("! ls");

      output.mockResolvedValueOnce({ ...promptOutput, chunks: [] });
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));

      await waitFor(() => expect(output).toHaveBeenCalledTimes(1));
      expect(input).not.toHaveBeenCalled();

      await waitFor(() =>
        expect(input).toHaveBeenCalledWith({
          terminalId: "term_composer",
          dataBase64: btoa("ls\r"),
        }),
      );
      expect(output).toHaveBeenCalledTimes(2);
    });

    it("sends the ! text to the chat unchanged with the modifier action", () => {
      const { composer, create } = renderShellComposer("! not a command");

      fireEvent.click(screen.getByRole("button", { name: "Modifier submit" }));

      expect(composer.onSubmit).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
    });

    it("switches between chat and terminal with the toggle shortcut", async () => {
      renderShellComposer("");

      fireEvent.keyDown(window, { key: "j", metaKey: true });
      expect(await screen.findByTestId("composer-terminal-view")).toBeTruthy();

      fireEvent.keyDown(window, { key: "j", metaKey: true });
      expect(screen.queryByTestId("composer-terminal-view")).toBeNull();
      expect(screen.getByTestId("prompt-box").parentElement?.className).toBe(
        "contents *:animate-in *:fade-in-0",
      );

      fireEvent.keyDown(window, { key: "j", metaKey: true });
      expect(await screen.findByTestId("composer-terminal-view")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
      expect(screen.queryByTestId("composer-terminal-view")).toBeNull();
    });
  });
});
