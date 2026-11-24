// @vitest-environment jsdom

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import {
  MemoryRouter,
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyboardCommandId } from "@omnyo/domain";
import { createPendingChat } from "@/lib/pending-chat-creations";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import type { LauncherComposerProps } from "./LauncherComposer";
import { NewChatLauncherOverlay } from "./NewChatLauncherOverlay";
import { newChatLauncherAtom, openNewChatLauncher } from "./new-chat-launcher";

const mocks = vi.hoisted(() => ({
  dismissMenu: vi.fn(() => false),
  dispatch: vi.fn<
    (command: KeyboardCommandId, target: EventTarget | null) => boolean
  >(() => false),
  getShortcutCommand: vi.fn<
    (
      event: KeyboardEvent,
      commands: readonly KeyboardCommandId[],
    ) => KeyboardCommandId | null
  >(() => null),
  toastError: vi.fn(),
  insertTypedText: vi.fn(),
  editorReady: true,
  portalEditor: false,
  lastProps: null as LauncherComposerProps | null,
}));

vi.mock("./LazyLauncherComposer", () => ({
  LazyLauncherComposer: (props: LauncherComposerProps) => {
    mocks.lastProps = props;
    props.promptBoxRef.current = {
      focusEnd: vi.fn(),
      captureHeightForLayoutChange: vi.fn(),
      insertTextAtCursor: vi.fn(),
      insertTypedText: mocks.insertTypedText,
      sendVoiceTranscript: vi.fn(),
      getTextBeforeCursor: vi.fn(),
      playVoiceCompletionTransition: vi.fn(async () => {}),
      dismissMenu: mocks.dismissMenu,
      openAttachmentPicker: vi.fn(),
      applyPromptAction: vi.fn(),
    };

    return mocks.editorReady ? (
      <>
        <textarea aria-label="Launcher editor" />
        {mocks.portalEditor
          ? createPortal(
              <div role="dialog" aria-label="Other dialog">
                <textarea aria-label="Other dialog editor" />
              </div>,
              document.body,
            )
          : null}
      </>
    ) : (
      <div>Loading the launcher</div>
    );
  },
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandRunner: () => ({
    dispatch: mocks.dispatch,
    getShortcutCommand: mocks.getShortcutCommand,
  }),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: mocks.toastError },
}));

function NavigatorProbe({
  onNavigate,
}: {
  onNavigate: (navigate: NavigateFunction) => void;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    onNavigate(navigate);
  }, [navigate, onNavigate]);

  return null;
}

function renderOverlay(initialPath = "/projects/proj_omnyo/threads/thr_abc") {
  const store = createStore();
  let navigate: NavigateFunction = () => {};

  const wrapper = ({ children }: { children: ReactNode }) => (
    <JotaiProvider store={store}>
      <MemoryRouter initialEntries={[initialPath]}>
        <NavigatorProbe onNavigate={(next) => (navigate = next)} />
        {children}
      </MemoryRouter>
    </JotaiProvider>
  );

  render(<NewChatLauncherOverlay />, { wrapper });

  act(() => store.set(newChatLauncherAtom, openNewChatLauncher));

  return {
    store,
    navigate: (path: string, options?: NavigateOptions) =>
      act(() => void navigate(path, options)),
  };
}

async function startedPendingChat(realThreadId: string): Promise<string> {
  const pending = createPendingChat({
    queueOwner: {},
    request: {
      projectId: "proj_omnyo",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      environment: { type: "reuse", environmentId: "env_omnyo" },
      executionInputSources: { providerId: "explicit", model: "explicit" },
      input: [{ type: "text", text: "first chat", mentions: [] }],
    },
    create: async () =>
      makeThreadResponse({ id: realThreadId, projectId: "proj_omnyo" }),
    send: vi.fn(),
    renderer: () => null,
    prepare: async () => {},
  });

  await pending.completion;

  return pending.id;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.lastProps = null;
  mocks.editorReady = true;
  mocks.portalEditor = false;
});

describe("NewChatLauncherOverlay", () => {
  it("opens as a dialog over the current view", () => {
    renderOverlay();

    expect(screen.getByRole("dialog", { name: "New chat" })).not.toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Launcher editor" }),
    ).not.toBeNull();
  });

  it("closes an open composer menu on Escape before closing itself", () => {
    const { store } = renderOverlay();
    const editor = screen.getByRole("textbox", { name: "Launcher editor" });

    mocks.dismissMenu.mockReturnValueOnce(true);
    fireEvent.keyDown(editor, { key: "Escape" });

    expect(store.get(newChatLauncherAtom).open).toBe(true);

    fireEvent.keyDown(editor, { key: "Escape" });

    expect(mocks.dismissMenu).toHaveBeenCalledTimes(2);
    expect(store.get(newChatLauncherAtom).open).toBe(false);
  });

  it("closes when the route changes", () => {
    const { store, navigate } = renderOverlay();

    navigate("/settings");

    expect(store.get(newChatLauncherAtom).open).toBe(false);
  });

  it("stays open when the chat underneath finishes starting", async () => {
    const pendingId = await startedPendingChat("thr_started");

    const { store, navigate } = renderOverlay(
      `/projects/proj_omnyo/threads/${pendingId}`,
    );

    navigate("/projects/proj_omnyo/threads/thr_started", { replace: true });

    expect(store.get(newChatLauncherAtom).open).toBe(true);

    navigate("/settings");

    expect(store.get(newChatLauncherAtom).open).toBe(false);
  });

  it("still closes when the route leaves a starting chat for another chat", async () => {
    const pendingId = await startedPendingChat("thr_started_elsewhere");

    const { store, navigate } = renderOverlay(
      `/projects/proj_omnyo/threads/${pendingId}`,
    );

    navigate("/projects/proj_omnyo/threads/thr_other");

    expect(store.get(newChatLauncherAtom).open).toBe(false);
  });

  it("refocuses instead of closing when ⌘N is pressed inside it", () => {
    const { store } = renderOverlay();
    const before = store.get(newChatLauncherAtom).focusRequest;

    mocks.getShortcutCommand.mockReturnValueOnce("thread.new");
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Launcher editor" }),
      {
        key: "n",
        metaKey: true,
      },
    );

    expect(store.get(newChatLauncherAtom)).toEqual({
      open: true,
      focusRequest: before + 1,
    });
  });

  it.each([
    "modelPicker.toggle",
    "modelPicker.cycleModel",
    "modelPicker.cycleModelBackward",
    "modelPicker.cycleProvider",
    "modelPicker.cycleProviderBackward",
    "modelPicker.cycleReasoning",
    "modelPicker.cycleReasoningBackward",
  ] satisfies readonly KeyboardCommandId[])(
    "runs a configured %s shortcut once inside the launcher",
    (command) => {
      const { store } = renderOverlay();
      const before = store.get(newChatLauncherAtom);

      const editor = screen.getByRole("textbox", {
        name: "Launcher editor",
      });

      mocks.getShortcutCommand.mockImplementationOnce((event, commands) =>
        event.key === "e" &&
        event.altKey &&
        event.ctrlKey &&
        commands.includes(command)
          ? command
          : null,
      );
      mocks.dispatch.mockReturnValueOnce(true);

      const unhandled = fireEvent.keyDown(editor, {
        key: "e",
        altKey: true,
        ctrlKey: true,
      });

      expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(command, editor);
      expect(unhandled).toBe(false);
      expect(store.get(newChatLauncherAtom)).toBe(before);
    },
  );

  it("leaves an unavailable picker shortcut for the editor to handle", () => {
    const { store } = renderOverlay();
    const before = store.get(newChatLauncherAtom);
    const editor = screen.getByRole("textbox", { name: "Launcher editor" });
    const onKeyDown = vi.fn();

    editor.addEventListener("keydown", onKeyDown);
    mocks.getShortcutCommand.mockImplementationOnce((_event, commands) =>
      commands.includes("modelPicker.cycleReasoning")
        ? "modelPicker.cycleReasoning"
        : null,
    );

    const unhandled = fireEvent.keyDown(editor, { key: "t", altKey: true });

    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      "modelPicker.cycleReasoning",
      editor,
    );
    expect(unhandled).toBe(true);
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(store.get(newChatLauncherAtom)).toBe(before);
  });

  it("leaves shortcuts in another portaled dialog to that dialog", () => {
    mocks.portalEditor = true;

    renderOverlay();

    const unhandled = fireEvent.keyDown(
      screen.getByLabelText("Other dialog editor"),
      { key: "t", altKey: true },
    );

    expect(mocks.getShortcutCommand).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(unhandled).toBe(true);
  });

  it("offers to reopen when a chat it started fails without opening", () => {
    const { store } = renderOverlay();

    act(() => mocks.lastProps?.onClose("submitted"));
    act(() => mocks.lastProps?.onUnopenedFailure(new Error("create failed")));

    expect(store.get(newChatLauncherAtom).open).toBe(false);
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't start the chat.", {
      action: { label: "Reopen", onClick: expect.any(Function) },
    });

    const [, options] = mocks.toastError.mock.calls[0] ?? [];

    act(() => options.action.onClick());

    expect(store.get(newChatLauncherAtom).open).toBe(true);
  });

  it("keeps keys typed before the editor is ready and inserts them once it takes focus", () => {
    mocks.editorReady = false;

    const { store } = renderOverlay();
    const dialog = screen.getByRole("dialog", { name: "New chat" });

    for (const key of ["a", "b", "x", "Backspace", "c"]) {
      fireEvent.keyDown(dialog, { key });
    }

    mocks.editorReady = true;
    act(() => store.set(newChatLauncherAtom, openNewChatLauncher));

    const editor = screen.getByRole("textbox", { name: "Launcher editor" });

    editor.setAttribute("contenteditable", "true");
    fireEvent.focus(editor);

    expect(mocks.insertTypedText).toHaveBeenCalledExactlyOnceWith("abc");
  });
  it("lets go of focus when it closes because the started chat opened", () => {
    renderOverlay();
    const editor = screen.getByRole("textbox", { name: "Launcher editor" });

    editor.focus();
    expect(document.activeElement).toBe(editor);

    act(() => mocks.lastProps?.onClose("opened"));

    expect(document.activeElement).toBe(document.body);
  });
});
