// @vitest-environment jsdom
import { Profiler, useMemo, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ExperimentalComposerSuggestion } from "@omnyo/plugin-sdk";
import type { PromptDraftState } from "@omnyo/client-core";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  PluginComposerHostProvider,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import {
  getComposerSuggestion,
  parseComposerSuggestion,
  setComposerSuggestion,
} from "@/lib/composer-suggestions";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@omnyo/client-core";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  PromptBoxInternal,
  type PromptBoxHandle,
  type PromptBoxSubmissionConfig,
  type PromptVoiceConfig,
} from "./PromptBoxInternal";

const KEY = "suggestion-test-composer";

const OWNER = Symbol("suggestion-test-owner");

function publish(suggestion: ExperimentalComposerSuggestion | null) {
  act(() => {
    setComposerSuggestion(
      KEY,
      "omnyo--composer-predictions",
      suggestion,
      OWNER,
      0,
    );
  });
}

function editorElement(): HTMLElement {
  const element = document.querySelector(".ProseMirror");

  if (!(element instanceof HTMLElement)) throw new Error("No editor");

  return element;
}

const IDLE_VOICE: PromptVoiceConfig = {
  state: "idle",
  microphoneWarning: null,
  isSupported: true,
  stream: null,
  start: () => {},
  stop: () => {},
  send: () => {},
  cancel: () => {},
};

function renderComposer(
  initialText = "",
  {
    compactViewport = false,
    submission,
    send = async () => {},
  }: {
    compactViewport?: boolean;
    submission?: PromptBoxSubmissionConfig;
    send?: () => Promise<void>;
  } = {},
) {
  const submitDraft = vi.fn((_draft: PromptDraftState) => send());
  const onSubmit = vi.fn();
  const controls = { setText: (_text: string) => {} };
  const box: { current: PromptBoxHandle | null } = { current: null };
  let commits = 0;

  function Harness() {
    const [value, setValue] = useState(initialText);
    controls.setText = setValue;

    const host = useMemo<PluginComposerHost>(
      () => ({
        scope: { kind: "thread", threadId: "thr_one" },
        textEffectKey: KEY,
        getCurrent: () => ({ text: value, mentions: [], attachments: [] }),
        subscribeDraft: () => () => {},
        setDraft: (next) => setValue(next.text),
        focus: () => editorElement().focus(),
        submitDraft,
      }),
      [value],
    );

    return (
      <PluginComposerHostProvider value={host}>
        <Profiler
          id="composer"
          onRender={() => {
            commits += 1;
          }}
        >
          <PromptBoxInternal
            promptBoxRef={box}
            value={value}
            mentionRanges={[]}
            onChange={(next) => setValue(next)}
            onSubmit={onSubmit}
            mentionMenuPlacement="bottom"
            autoFocus={false}
            placeholder="Ask for a follow-up"
            submission={submission}
            compact={
              compactViewport
                ? { isCompact: value === "", placeholder: "Reply" }
                : undefined
            }
            voice={compactViewport ? IDLE_VOICE : undefined}
            typeahead={{
              mention: {
                results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
                isLoading: false,
                isRefreshing: false,
                isError: false,
                onQueryChange: () => {},
              },
              command: INERT_TYPEAHEAD_COMMAND_CONFIG,
            }}
          />
        </Profiler>
      </PluginComposerHostProvider>
    );
  }

  render(
    <CompactViewportOverrideProvider isCompactViewport={compactViewport}>
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    </CompactViewportOverrideProvider>,
    { wrapper: TooltipProvider },
  );

  return {
    submitDraft,
    onSubmit,
    setText: (text: string) => act(() => controls.setText(text)),
    typeText: (text: string) =>
      act(() => box.current?.insertTextAtCursor(text)),
    commitCount: () => commits,
  };
}

function ready(text = "Update the README, then push.") {
  return {
    status: "ready" as const,
    text,
    onDismiss: vi.fn(),
  };
}

function insertButton(): HTMLElement {
  return screen.getByRole("button", { name: "Insert suggestion" });
}

afterEach(() => {
  publish(null);
  cleanup();
});

describe("composer suggestion", () => {
  it("shows a ready suggestion inside the empty composer and sends it with one click", async () => {
    const { submitDraft, onSubmit } = renderComposer();
    publish(ready());

    expect(
      await screen.findByText("Update the README, then push."),
    ).toBeTruthy();
    expect(screen.queryByText("Suggested reply")).toBeNull();
    expect(editorElement().getAttribute("data-placeholder")).toBe("");

    const send = screen.getByRole("button", { name: "Send suggestion" });
    expect(send.hasAttribute("disabled")).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(submitDraft).toHaveBeenCalledTimes(1));
    expect(submitDraft.mock.calls[0]?.[0]).toMatchObject({
      text: "Update the README, then push.",
      mentions: [],
      attachments: [],
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(editorElement());
  });

  it.each([false, true])(
    "removes a sent suggestion at once while the send is in flight, and restores it if the send fails (compact %s)",
    async (compactViewport) => {
      let fail: (error: Error) => void = () => {};

      const { submitDraft } = renderComposer("", {
        compactViewport,
        send: () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      });

      publish(ready());
      await screen.findByText("Update the README, then push.");

      fireEvent.click(screen.getByRole("button", { name: "Send suggestion" }));

      expect(submitDraft).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Update the README, then push.")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Send suggestion" }),
      ).toBeNull();

      publish(ready());
      expect(screen.queryByText("Update the README, then push.")).toBeNull();

      await act(async () => fail(new Error("offline")));

      expect(
        await screen.findByText("Update the README, then push."),
      ).toBeTruthy();
    },
  );

  it("keeps the text and its controls as a shadow after the user clicks in, and Tab inserts it", async () => {
    const { submitDraft } = renderComposer();
    publish(ready());
    await screen.findByText("Update the README, then push.");

    fireEvent.pointerDown(editorElement());

    expect(screen.getByText("Update the README, then push.")).toBeTruthy();
    expect(
      document.querySelector('[data-composer-suggestion="shadow"]'),
    ).not.toBeNull();
    expect(screen.queryByText("Suggested reply")).toBeNull();
    expect(insertButton()).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Dismiss suggestion" }),
    ).toBeTruthy();
    expect(editorElement().getAttribute("data-placeholder")).toBe("");
    expect(
      screen
        .getByRole("button", { name: "Submit (Enter)" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.keyDown(editorElement(), { key: "Tab" });

    await waitFor(() =>
      expect(editorElement().textContent).toBe("Update the README, then push."),
    );
    expect(document.querySelector("[data-composer-suggestion]")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Insert suggestion" }),
    ).toBeNull();
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it("undoes the Tab insertion with Mod+Z and shows the shadow again", async () => {
    renderComposer();
    publish(ready());
    await screen.findByText("Update the README, then push.");

    fireEvent.pointerDown(editorElement());
    fireEvent.keyDown(editorElement(), { key: "Tab" });
    await waitFor(() =>
      expect(editorElement().textContent).toBe("Update the README, then push."),
    );

    fireEvent.keyDown(editorElement(), { key: "z", ctrlKey: true });

    await waitFor(() => expect(editorElement().textContent).toBe(""));
    expect(
      document.querySelector('[data-composer-suggestion="shadow"]'),
    ).not.toBeNull();
    expect(insertButton()).toBeTruthy();

    fireEvent.keyDown(editorElement(), { key: "Tab" });
    await waitFor(() =>
      expect(editorElement().textContent).toBe("Update the README, then push."),
    );
  });

  it("keeps the suggestion while the editor is only focused and inserts it on Tab", async () => {
    renderComposer();
    publish(ready());
    await screen.findByText("Update the README, then push.");

    act(() => editorElement().focus());

    expect(screen.getByText("Update the README, then push.")).toBeTruthy();
    fireEvent.keyDown(editorElement(), { key: "Tab" });
    await waitFor(() =>
      expect(editorElement().textContent).toBe("Update the README, then push."),
    );
  });

  it("does not send the suggestion with Enter in an empty editor", async () => {
    const { submitDraft, onSubmit } = renderComposer();
    publish(ready());
    await screen.findByText("Update the README, then push.");

    fireEvent.keyDown(editorElement(), { key: "Enter" });

    expect(submitDraft).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { engagedFirst: false, touch: false },
    { engagedFirst: true, touch: false },
    { engagedFirst: false, touch: true },
    { engagedFirst: true, touch: true },
  ])(
    "inserts the suggestion as an editable draft with one click on Insert (clicked in first: $engagedFirst, touch: $touch)",
    async ({ engagedFirst, touch }) => {
      const originalMatchMedia = window.matchMedia;

      if (touch)
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
          matches: query.includes("pointer: coarse"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }));

      try {
        const { submitDraft } = renderComposer();
        const suggestion = ready();
        publish(suggestion);
        await screen.findByText("Update the README, then push.");

        expect(screen.queryByText("Tab") === null).toBe(touch);

        if (engagedFirst) fireEvent.pointerDown(editorElement());
        fireEvent.click(insertButton());

        await waitFor(() =>
          expect(editorElement().textContent).toBe(
            "Update the README, then push.",
          ),
        );
        expect(document.querySelector("[data-composer-suggestion]")).toBeNull();
        expect(submitDraft).not.toHaveBeenCalled();
        expect(suggestion.onDismiss).not.toHaveBeenCalled();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    },
  );

  it("asks for another suggestion only when the plugin can make one", async () => {
    renderComposer();
    const onRegenerate = vi.fn();
    publish(ready());
    await screen.findByText("Update the README, then push.");

    expect(
      screen.queryByRole("button", { name: "Suggest another reply" }),
    ).toBeNull();

    publish({ ...ready("Ship the fix."), onRegenerate });
    fireEvent.click(
      await screen.findByRole("button", { name: "Suggest another reply" }),
    );

    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("explains a missing suggestion and requests one anyway", async () => {
    renderComposer();
    const onRequest = vi.fn();
    const onDismiss = vi.fn();
    publish({
      status: "none",
      reason: "A pursue loop already owns the next step.",
      onRequest,
      onDismiss,
    });

    expect(await screen.findByText("No suggested reply")).toBeTruthy();
    expect(
      screen.getByText("A pursue loop already owns the next step."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Submit (Enter)" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Suggest a reply anyway" }),
    );
    expect(onRequest).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the suggestion's Send button at full strength beside send-menu plugins", async () => {
    setPluginSlotRegistrations(
      "drafts",
      makePluginRegistrationSet({
        composerCustomizations: [
          {
            id: "drafts",
            sendMenu: [{ id: "drafts", label: "Save draft", run: vi.fn() }],
          },
        ],
      }),
    );

    try {
      renderComposer();
      publish(ready());
      await screen.findByText("Update the README, then push.");

      const send = screen.getByRole("button", { name: "Send suggestion" });
      expect(send.hasAttribute("disabled")).toBe(false);
      expect(
        send
          .closest("[data-promptbox-send-menu]")
          ?.classList.contains("opacity-50"),
      ).toBe(false);
    } finally {
      resetPluginSlotStoreForTest();
    }
  });

  it("dismisses with Escape or the tag's dismiss button", async () => {
    renderComposer();
    const first = ready();
    publish(first);
    await screen.findByText("Update the README, then push.");

    fireEvent.keyDown(editorElement(), { key: "Escape" });
    expect(first.onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(first.onDismiss).toHaveBeenCalledTimes(2);
  });

  it("hides behind a typed draft, shows a shadow once cleared, and the tagged suggestion after blur", async () => {
    const { setText } = renderComposer("My own reply");
    publish(ready());

    expect(screen.queryByText("Update the README, then push.")).toBeNull();
    expect(screen.getByRole("button", { name: "Submit (Enter)" })).toBeTruthy();

    setText("");
    await waitFor(() => expect(editorElement().textContent).toBe(""));
    expect(
      document.querySelector('[data-composer-suggestion="shadow"]'),
    ).not.toBeNull();
    expect(insertButton()).toBeTruthy();

    fireEvent.blur(editorElement());
    await waitFor(() =>
      expect(
        document.querySelector('[data-composer-suggestion="ready"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByText("Suggested reply")).toBeNull();
  });

  it("commits the composer once per insertion while a suggestion is hidden behind the draft", async () => {
    const { typeText, commitCount } = renderComposer();
    publish(ready());
    await screen.findByText("Update the README, then push.");
    typeText("a");
    const engaged = commitCount();

    for (const word of ["b", "c", "d", "e", "f"]) typeText(word);

    expect(editorElement().textContent).toBe("a b c d e f");
    expect(commitCount() - engaged).toBe(5);
  });

  it("shows loading and failure lines with their actions", async () => {
    renderComposer();
    const onDismiss = vi.fn();
    publish({ status: "loading", onDismiss });

    expect((await screen.findByRole("status")).textContent).toBe(
      "Suggesting a reply…",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Stop suggesting a reply" }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const onRetry = vi.fn();
    publish({
      status: "failed",
      message: "Predictions need fresh included Codex allowance.",
      onRetry,
      onDismiss,
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Predictions need fresh included Codex allowance.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: "Submit (Enter)" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("composer suggestion card on compact viewports", () => {
  function card(): HTMLElement {
    const element = document.querySelector("[data-composer-suggestion-card]");

    if (!(element instanceof HTMLElement)) throw new Error("No card");

    return element;
  }

  const LONG =
    "Looks good.\n\nBefore pushing:\n- check the iPad layout\n- run the composer tests again";

  it("shows the full suggestion in a card above the editor and leaves the editor placeholder alone", async () => {
    renderComposer("", { compactViewport: true });
    publish(ready(LONG));

    await waitFor(() =>
      expect(card().textContent).toContain("Suggested reply"),
    );
    expect(
      card().querySelector("[data-composer-suggestion-text]")?.textContent,
    ).toBe(LONG);
    expect(document.querySelector("[data-promptbox-suggestion]")).toBeNull();
    expect(editorElement().getAttribute("data-placeholder")).toBe("Reply");
    expect(
      card().compareDocumentPosition(editorElement()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("sends the suggestion with one tap on Send, even after the editor was pressed", async () => {
    const { submitDraft, onSubmit } = renderComposer("", {
      compactViewport: true,
    });

    publish(ready());
    await waitFor(() => card());

    fireEvent.pointerDown(editorElement());
    act(() => editorElement().focus());

    const send = screen.getByRole("button", { name: "Send suggestion" });
    expect(card().contains(send)).toBe(true);
    expect(send.hasAttribute("disabled")).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(submitDraft).toHaveBeenCalledTimes(1));
    expect(submitDraft.mock.calls[0]?.[0]).toMatchObject({
      text: "Update the README, then push.",
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("inserts the suggestion with Edit and focuses the editor", async () => {
    const { submitDraft } = renderComposer("", { compactViewport: true });
    const suggestion = ready();
    publish(suggestion);
    await waitFor(() => card());

    fireEvent.click(screen.getByRole("button", { name: "Edit suggestion" }));

    await waitFor(() =>
      expect(editorElement().textContent).toBe("Update the README, then push."),
    );
    expect(document.activeElement).toBe(editorElement());
    expect(
      document.querySelector("[data-composer-suggestion-card]"),
    ).toBeNull();
    expect(submitDraft).not.toHaveBeenCalled();
    expect(suggestion.onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses and regenerates from the card header", async () => {
    renderComposer("", { compactViewport: true });
    const onRegenerate = vi.fn();
    const suggestion = { ...ready(), onRegenerate };
    publish(suggestion);
    await waitFor(() => card());

    fireEvent.click(
      screen.getByRole("button", { name: "Suggest another reply" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));

    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(suggestion.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps Send visible but disabled with the reason while submitting is blocked", async () => {
    const { submitDraft } = renderComposer("", {
      compactViewport: true,
      submission: { disabled: true, disabledReason: "The host is offline." },
    });

    publish(ready());
    await waitFor(() => card());

    const send = screen.getByRole("button", { name: "Send suggestion" });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(send.getAttribute("aria-describedby")).not.toBeNull();
    expect(
      document.getElementById(send.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("The host is offline.");

    fireEvent.click(send);
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it("leaves the composer row to voice: one mic as the primary action and no suggestion send", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

    try {
      renderComposer("", { compactViewport: true });
      publish(ready());
      await waitFor(() => card());

      const row = document.querySelector("[data-promptbox-action-row]");
      expect(row).not.toBeNull();

      const mics = Array.from(
        row?.querySelectorAll('button[aria-label="Start voice input"]') ?? [],
      );

      expect(mics).toHaveLength(1);
      expect(mics[0]?.hasAttribute("data-promptbox-submit-action")).toBe(true);
      expect(
        screen.getAllByRole("button", { name: "Send suggestion" }),
      ).toHaveLength(1);
      expect(
        card().contains(
          screen.getByRole("button", { name: "Send suggestion" }),
        ),
      ).toBe(true);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("shows loading, failed and none states in the card with their actions", async () => {
    renderComposer("", { compactViewport: true });
    const onDismiss = vi.fn();
    publish({ status: "loading", onDismiss });

    expect((await screen.findByRole("status")).textContent).toBe(
      "Suggesting a reply…",
    );
    expect(card().getAttribute("data-composer-suggestion-card")).toBe(
      "loading",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Stop suggesting a reply" }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const onRetry = vi.fn();
    publish({
      status: "failed",
      message: "Predictions need fresh included Codex allowance.",
      onRetry,
      onDismiss,
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Predictions need fresh included Codex allowance.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    const onRequest = vi.fn();
    publish({
      status: "none",
      reason: "A pursue loop already owns the next step.",
      onRequest,
      onDismiss,
    });
    expect(await screen.findByText("No suggested reply")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Suggest a reply anyway" }),
    );
    expect(onRequest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});

describe("composer suggestion store", () => {
  it("rejects malformed plugin suggestions at the boundary", () => {
    expect(() =>
      parseComposerSuggestion({ status: "ready", text: " " }),
    ).toThrow(TypeError);
    expect(() =>
      parseComposerSuggestion({ status: "failed", onDismiss: () => {} }),
    ).toThrow(TypeError);
    expect(() =>
      parseComposerSuggestion({ status: "unknown", onDismiss: () => {} }),
    ).toThrow(TypeError);
    expect(
      parseComposerSuggestion({ status: "loading", onDismiss: () => {} }),
    ).toMatchObject({ status: "loading" });
    expect(() =>
      parseComposerSuggestion({
        status: "none",
        reason: " ",
        onRequest: () => {},
        onDismiss: () => {},
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseComposerSuggestion({
        status: "ready",
        text: "Ship it.",
        onDismiss: () => {},
        onRegenerate: "again",
      }),
    ).toThrow(TypeError);

    const onRegenerate = () => {};

    expect(
      parseComposerSuggestion({
        status: "ready",
        text: "Ship it.",
        onDismiss: () => {},
        onRegenerate,
      }),
    ).toMatchObject({ status: "ready", onRegenerate });
  });

  it("shows one owner's suggestion at a time and falls back when it clears", () => {
    const first = Symbol("first");
    const second = Symbol("second");
    const alpha = ready("From alpha");
    const beta = ready("From beta");

    setComposerSuggestion(KEY, "beta", beta, second, 1);
    setComposerSuggestion(KEY, "alpha", alpha, first, 2);
    expect(getComposerSuggestion(KEY)).toBe(alpha);

    setComposerSuggestion(KEY, "alpha", null, first, 2);
    expect(getComposerSuggestion(KEY)).toBe(beta);

    setComposerSuggestion(KEY, "beta", null, second, 1);
    expect(getComposerSuggestion(KEY)).toBeNull();
  });
});
