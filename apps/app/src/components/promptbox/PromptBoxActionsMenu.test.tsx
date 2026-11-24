// @vitest-environment jsdom

import type {
  ComposerSelection,
  ComposerView,
  PluginComposerApi,
  PluginComposerScope,
} from "@omnyo/plugin-sdk";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { registerComposerMenuPlugins } from "@/test/fixtures/composer-menu";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { ComposerSendMenu } from "./ComposerSendMenu";
import { MemoryRouter } from "react-router-dom";
import {
  PluginComposerHostProvider,
  PluginComposerViewProvider,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import type { PluginComposerPlusMenuContribution } from "@/components/plugin/PluginComposerActions";
import { emptyPromptDraftState } from "@omnyo/client-core";
import { OFF_SCREEN_EDITOR_STATE } from "@omnyo/plugin-sdk/internal/composer-handle";
import {
  clearComposerEditorBridge,
  publishComposerEditorBridge,
  type ComposerEditorBridge,
} from "@/lib/composer-editor-registry";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  ComposerPlusMenuSlot,
  PromptBoxActionsMenu,
  type PromptBoxChatMenu,
} from "./PromptBoxActionsMenu";

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetPluginLogoStoreForTest();
});

function composerHost(
  scope: PluginComposerScope,
  selection: () => ComposerSelection,
  subscribeSelection: PluginComposerHost["subscribeSelection"] = () => () => {},
): { host: PluginComposerHost; view: ComposerView } {
  const draft = { ...emptyPromptDraftState(), text: "Draft" };

  return {
    view: {
      scope,
      layout: "expanded",
      draft: { text: "Draft", isEmpty: false, attachmentCount: 0 },
      run: { isRunning: false, isSubmitting: false },
    },
    host: {
      scope,
      textEffectKey: `test-${scope.kind}`,
      getCurrent: () => draft,
      subscribeDraft: () => () => {},
      setDraft: () => {},
      focus: () => {},
      getSelection: selection,
      subscribeSelection,
    },
  };
}

describe("PromptBoxActionsMenu", () => {
  it("does not render when no prompt actions are provided", () => {
    render(<PromptBoxActionsMenu onAction={() => {}} />);

    expect(screen.queryByRole("button", { name: "Prompt actions" })).toBeNull();
  });

  it("offers file attachments even when no provider actions are available", async () => {
    const onAttach = vi.fn();
    render(<PromptBoxActionsMenu onAction={() => {}} onAttach={onAttach} />);

    const trigger = screen.getByRole("button", { name: "Prompt actions" });
    expect(trigger.classList).toContain("text-muted-foreground");
    expect(trigger.classList).toContain("size-7");
    expect(trigger.querySelector('[data-icon="Plus"]')).not.toBeNull();
    expect(trigger.querySelector('[data-icon="Spinner"]')).toBeNull();
    fireEvent.pointerDown(trigger, { button: 0 });

    const attach = await screen.findByRole("menuitem", {
      name: "Attach files",
    });

    expect(attach.getAttribute("aria-disabled")).not.toBe("true");
    expect(attach.querySelector('[data-icon="Paperclip"]')).not.toBeNull();
    expect(attach.querySelector('[data-icon="Loading"]')).toBeNull();
    fireEvent.click(attach);
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it.each<PluginComposerScope>([
    { kind: "new-thread", projectId: null },
    { kind: "thread", threadId: "thread-1" },
    { kind: "queued-message", threadId: "thread-1", queuedMessageId: "q-1" },
  ])(
    "lists provider actions before the Automation and Plugin rows in a $kind composer",
    async (scope) => {
      registerComposerMenuPlugins();
      const selection: ComposerSelection = {};
      const { host, view } = composerHost(scope, () => selection);
      render(
        <MemoryRouter>
          <PluginComposerHostProvider value={host}>
            <PluginComposerViewProvider value={view}>
              <ComposerPlusMenuSlot
                actions={[
                  { kind: "skills", text: "/skills " },
                  { kind: "plan", text: "/plan " },
                ]}
                onAction={() => {}}
              />
            </PluginComposerViewProvider>
          </PluginComposerHostProvider>
        </MemoryRouter>,
      );

      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Prompt actions" }),
        { button: 0 },
      );
      const menuItems = await screen.findAllByRole("menuitem");
      expect(menuItems.map((item) => item.textContent)).toEqual([
        "Skills",
        "Plan",
        "Automation",
        "Plugin",
      ]);
      expect(
        menuItems.map((item) =>
          item.querySelector("[data-icon]")?.getAttribute("data-icon"),
        ),
      ).toEqual(["Zap", "ListTodo", "Repeat", "Plug02"]);
    },
  );

  it.each(["plus", "send"] as const)(
    "re-renders %s-menu rows when the composer selection changes",
    async (menu) => {
      const definition = definePluginApp((app) =>
        app.composer.customize({
          id: "conditional",
          [menu === "plus" ? "plusMenu" : "sendMenu"]: [
            {
              id: "codex-only",
              label: "Codex only",
              disabled: (composer: PluginComposerApi) =>
                composer.selection?.providerId !== "codex",
              run: () => {},
            },
          ],
        }),
      );

      setPluginSlotRegistrations(
        "conditional",
        makePluginRegistrationSet(collectPluginAppRegistrations(definition)),
      );
      let selection: ComposerSelection = { providerId: "codex" };
      const listeners = new Set<() => void>();

      const { host, view } = composerHost(
        { kind: "new-thread", projectId: null },
        () => selection,
        (listener) => {
          listeners.add(listener);

          return () => listeners.delete(listener);
        },
      );

      render(
        <MemoryRouter>
          <PluginComposerHostProvider value={host}>
            <PluginComposerViewProvider value={view}>
              {menu === "plus" ? (
                <ComposerPlusMenuSlot onAction={() => {}} />
              ) : (
                <ComposerSendMenu
                  isPointerCoarse={false}
                  includePluginContributions
                  queue={false}
                  hasInput
                  canSubmit
                  canSend
                  onSubmit={undefined}
                >
                  <button>Send</button>
                </ComposerSendMenu>
              )}
            </PluginComposerViewProvider>
          </PluginComposerHostProvider>
        </MemoryRouter>,
      );
      fireEvent.pointerDown(
        screen.getByRole("button", {
          name: menu === "plus" ? "Prompt actions" : "Send options",
        }),
        { button: 0 },
      );
      const row = await screen.findByRole("menuitem", { name: "Codex only" });
      expect(row.getAttribute("aria-disabled")).not.toBe("true");

      act(() => {
        selection = { providerId: "claude-code" };

        for (const listener of listeners) listener();
      });

      await waitFor(() =>
        expect(
          screen
            .getByRole("menuitem", { name: "Codex only" })
            .getAttribute("aria-disabled"),
        ).toBe("true"),
      );
    },
  );

  async function openConditionalPlusRow(
    disabled: (composer: PluginComposerApi) => boolean,
    { host, view }: { host: PluginComposerHost; view: ComposerView },
  ) {
    const definition = definePluginApp((app) =>
      app.composer.customize({
        id: "conditional",
        plusMenu: [
          {
            id: "conditional-row",
            label: "Conditional",
            disabled,
            run: () => {},
          },
        ],
      }),
    );

    setPluginSlotRegistrations(
      "conditional",
      makePluginRegistrationSet(collectPluginAppRegistrations(definition)),
    );
    render(
      <MemoryRouter>
        <PluginComposerHostProvider value={host}>
          <PluginComposerViewProvider value={view}>
            <ComposerPlusMenuSlot onAction={() => {}} />
          </PluginComposerViewProvider>
        </PluginComposerHostProvider>
      </MemoryRouter>,
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Prompt actions" }),
      { button: 0 },
    );
    await screen.findByRole("menuitem", { name: "Conditional" });
  }

  function conditionalRowDisabled() {
    return screen
      .getByRole("menuitem", { name: "Conditional" })
      .getAttribute("aria-disabled");
  }

  it("re-renders plus-menu rows when the composer draft changes", async () => {
    let draft = { ...emptyPromptDraftState(), text: "Draft" };
    const listeners = new Set<() => void>();

    const composer = composerHost(
      { kind: "new-thread", projectId: null },
      () => ({}),
    );

    await openConditionalPlusRow((current) => current.isEmpty, {
      view: composer.view,
      host: {
        ...composer.host,
        getCurrent: () => draft,
        subscribeDraft: (listener) => {
          listeners.add(listener);

          return () => listeners.delete(listener);
        },
      },
    });
    expect(conditionalRowDisabled()).not.toBe("true");

    act(() => {
      draft = emptyPromptDraftState();

      for (const listener of listeners) listener();
    });

    await waitFor(() => expect(conditionalRowDisabled()).toBe("true"));
  });

  it("re-renders plus-menu rows when the composer editor state changes", async () => {
    const { host, view } = composerHost(
      { kind: "new-thread", projectId: null },
      () => ({}),
    );

    const bridge = (isSubmittingBlocked: boolean): ComposerEditorBridge => ({
      host,
      pluginCustomizable: true,
      state: { ...OFF_SCREEN_EDITOR_STATE, isSubmittingBlocked },
      insertAtCursor: () => false,
      openPopup: () => false,
      closePopup: () => false,
      isPopupOpen: () => false,
    });

    const available = bridge(false);
    const blocked = bridge(true);
    publishComposerEditorBridge(host.textEffectKey, available);

    try {
      await openConditionalPlusRow((current) => current.isSubmittingBlocked, {
        host,
        view,
      });
      expect(conditionalRowDisabled()).not.toBe("true");

      act(() => publishComposerEditorBridge(host.textEffectKey, blocked));

      await waitFor(() => expect(conditionalRowDisabled()).toBe("true"));
    } finally {
      clearComposerEditorBridge(host.textEffectKey, available);
      clearComposerEditorBridge(host.textEffectKey, blocked);
    }
  });

  it("restores composer focus after an update-only plugin item", async () => {
    const view: ComposerView = {
      scope: { kind: "new-thread", projectId: null },
      layout: "expanded",
      draft: { text: "draft", isEmpty: false, attachmentCount: 0 },
      run: { isRunning: false, isSubmitting: false },
    };

    const draft = { ...emptyPromptDraftState(), text: "draft" };
    const setDraft = vi.fn();

    const host: PluginComposerHost = {
      scope: view.scope,
      textEffectKey: "plus-menu-update-test",
      getCurrent: () => draft,
      subscribeDraft: () => () => {},
      setDraft,
      focus: () => document.getElementById("composer-focus-target")?.focus(),
    };

    const pluginItems: readonly PluginComposerPlusMenuContribution[] = [
      {
        key: "update-plugin/1/tools/update",
        pluginId: "update-plugin",
        customizationId: "tools",
        generation: 1,
        item: {
          id: "update",
          label: "Update prompt",
          run: ({ composer }) =>
            composer.updateText((current) => `${current}!`),
        },
      },
    ];

    render(
      <MemoryRouter>
        <PluginComposerHostProvider value={host}>
          <PluginComposerViewProvider value={view}>
            <input id="composer-focus-target" aria-label="Composer" />
            <PromptBoxActionsMenu
              onAction={() => {}}
              pluginItems={pluginItems}
            />
          </PluginComposerViewProvider>
        </PluginComposerHostProvider>
      </MemoryRouter>,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Prompt actions" }),
      { button: 0 },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Update prompt" }),
    );

    await waitFor(() => {
      expect(setDraft).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Composer" }),
      );
    });
  });

  it("renders plugin rows without a header and preserves focus deliberately moved by a plugin", async () => {
    const focusedByPlugin = vi.fn();

    const view: ComposerView = {
      scope: { kind: "new-thread", projectId: null },
      layout: "expanded",
      draft: { text: "draft", isEmpty: false, attachmentCount: 0 },
      run: { isRunning: false, isSubmitting: false },
    };

    const draft = emptyPromptDraftState();

    const host: PluginComposerHost = {
      scope: view.scope,
      textEffectKey: "plus-menu-test",
      getCurrent: () => draft,
      subscribeDraft: () => () => {},
      setDraft: vi.fn(),
      focus: vi.fn(),
    };

    const pluginItems: readonly PluginComposerPlusMenuContribution[] = [
      {
        key: "alpha/1/tools/improve",
        pluginId: "alpha",
        customizationId: "tools",
        generation: 1,
        item: {
          id: "improve",
          label: "Improve prompt",
          run: ({ composer }) => {
            focusedByPlugin(composer.key);
            document.getElementById("plugin-focus-target")?.focus();
          },
        },
      },
      {
        key: "zeta/1/tools/rewrite",
        pluginId: "zeta",
        customizationId: "tools",
        generation: 1,
        item: {
          id: "rewrite",
          label: "Rewrite prompt",
          disabled: (composer) => composer.isEmpty,
          run: vi.fn(),
        },
      },
    ];

    setPluginLogoUrls(
      new Map([
        [
          "alpha",
          {
            displayName: "Alpha Assistant",
            icon: null,
            compactIconUrl: null,
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
        [
          "zeta",
          {
            displayName: "Zeta Writer",
            icon: null,
            compactIconUrl: null,
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    render(
      <MemoryRouter>
        <PluginComposerHostProvider value={host}>
          <PluginComposerViewProvider value={view}>
            <button id="plugin-focus-target">Plugin focus target</button>
            <PromptBoxActionsMenu
              actions={[{ kind: "plan", text: "/plan " }]}
              onAction={() => {}}
              pluginItems={pluginItems}
            />
          </PluginComposerViewProvider>
        </PluginComposerHostProvider>
      </MemoryRouter>,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Prompt actions" }),
      { button: 0 },
    );
    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Plan",
      "Improve prompt",
      "Rewrite prompt",
    ]);
    expect(screen.queryByText("Plugin")).toBeNull();
    expect(screen.queryByText("Alpha Assistant")).toBeNull();
    expect(screen.queryByText("Zeta Writer")).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "Improve prompt" }));
    await waitFor(() => {
      expect(focusedByPlugin).toHaveBeenCalledWith("plus-menu-test");
      expect(document.activeElement?.id).toBe("plugin-focus-target");
    });
  });
});

describe("PromptBoxActionsMenu approvals", () => {
  it("lists approvals with the current mode checked and changes it in one pick", async () => {
    const onChange = vi.fn();

    render(
      <PromptBoxActionsMenu
        onAction={() => {}}
        approvals={{
          value: "accept-edits",
          options: [
            { value: "accept-edits", label: "Accept Edits" },
            { value: "auto", label: "Approve for me" },
            { value: "full", label: "Full Access" },
          ],
          onChange,
        }}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Prompt actions" }),
      { button: 0 },
    );

    const current = await screen.findByRole("menuitemradio", {
      name: "Accept Edits",
    });

    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Approvals")).not.toBeNull();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Full Access" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith("full");
  });
});

describe("PromptBoxActionsMenu on a phone", () => {
  function renderPhoneMenu(chat: PromptBoxChatMenu) {
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <PromptBoxActionsMenu onAction={() => {}} chat={chat} />
      </CompactViewportOverrideProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Prompt actions" }));
  }

  it("lists approvals as labelled choices and changes them in one tap", async () => {
    const onChange = vi.fn();
    renderPhoneMenu({
      approvals: {
        value: "auto",
        options: [
          { value: "accept-edits", label: "Accept Edits" },
          { value: "auto", label: "Approve for me" },
        ],
        onChange,
      },
      compactBeforeSend: null,
      autoCompaction: null,
      onShowTerminal: null,
    });

    const current = await screen.findByRole("menuitemradio", {
      name: "Approve for me",
    });

    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Approvals")).not.toBeNull();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Accept Edits" }),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith("accept-edits");
  });

  it("gives this chat's compaction and terminal labelled rows", async () => {
    const onCompactFirstChange = vi.fn();
    const onShowTerminal = vi.fn();
    renderPhoneMenu({
      approvals: null,
      compactBeforeSend: {
        compactFirst: true,
        tokens: 182_000,
        onCompactFirstChange,
      },
      autoCompaction: {
        at: 0,
        keepFullHistory: false,
        pending: false,
        onKeepFullHistoryChange: vi.fn(),
      },
      onShowTerminal,
    });

    const compact = await screen.findByRole("switch", {
      name: /Compact before sending/,
    });

    expect(compact.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("This chat")).not.toBeNull();
    expect(
      screen.getByText("Prompt cache expired · 182k tokens"),
    ).not.toBeNull();
    expect(
      screen.queryByRole("switch", { name: /Keep full history/ }),
    ).toBeNull();
    fireEvent.click(compact);
    expect(onCompactFirstChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      screen.getByRole("switch", { name: /Compact before sending/ }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Show terminal" }));
    expect(onShowTerminal).toHaveBeenCalledOnce();
  });

  it("offers the automatic compaction opt-out when no send would compact", async () => {
    const onKeepFullHistoryChange = vi.fn();
    renderPhoneMenu({
      approvals: null,
      compactBeforeSend: null,
      autoCompaction: {
        at: 0,
        keepFullHistory: false,
        pending: false,
        onKeepFullHistoryChange,
      },
      onShowTerminal: null,
    });

    fireEvent.click(
      await screen.findByRole("switch", { name: /Keep full history/ }),
    );
    expect(onKeepFullHistoryChange).toHaveBeenCalledExactlyOnceWith(true);
  });
});
