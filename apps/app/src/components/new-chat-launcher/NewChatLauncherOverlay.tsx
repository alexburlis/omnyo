import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom, useStore } from "jotai";
import { useLocation, type Location } from "react-router-dom";
import type { KeyboardCommandId } from "@omnyo/domain";
import { Dialog, DialogContent, DialogTitle } from "@omnyo/shared-ui/dialog";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  COMPOSER_SHORTCUT_COMMANDS,
  useComposerShortcutCapture,
} from "@/components/commands/composer-shortcut-capture";
import type { PromptBoxHandle } from "@/components/promptbox/PromptBoxInternal";
import { appToast } from "@/components/ui/app-toast";
import { nextTypedAhead } from "@/lib/typed-ahead";
import type { LauncherCloseReason } from "./LauncherComposer";
import { LazyLauncherComposer } from "./LazyLauncherComposer";
import {
  closeNewChatLauncher,
  isPendingChatResolution,
  NEW_CHAT_LAUNCHER_PANEL_CLASS,
  NEW_CHAT_LAUNCHER_WIDTH_CLASS,
  newChatLauncherAtom,
  openNewChatLauncher,
} from "./new-chat-launcher";

const UNOPENED_FAILURE_TITLE = "Couldn't start the chat.";

type LauncherExit = "send" | "dismiss";

const LAUNCHER_SHORTCUT_COMMANDS: readonly KeyboardCommandId[] = [
  "thread.new",
  ...COMPOSER_SHORTCUT_COMMANDS,
];

function useCloseOnLocationChange(
  active: boolean,
  location: Location,
  onChange: () => void,
) {
  const lastLocation = useRef<Location | null>(null);

  useEffect(() => {
    if (!active) {
      lastLocation.current = null;

      return;
    }

    const previous = lastLocation.current;
    lastLocation.current = location;

    if (
      previous !== null &&
      previous.key !== location.key &&
      !isPendingChatResolution(previous.pathname, location.pathname)
    ) {
      onChange();
    }
  }, [active, location, onChange]);
}

export function NewChatLauncherOverlay() {
  const store = useStore();
  const [launcher, setLauncher] = useAtom(newChatLauncherAtom);
  const isCompact = useIsCompactViewport();
  const location = useLocation();
  const promptBoxRef = useRef<PromptBoxHandle | null>(null);
  const closeReason = useRef<LauncherCloseReason>("dismissed");
  const typedAhead = useRef("");
  const [exit, setExit] = useState<LauncherExit>("dismiss");
  const open = launcher.open && !isCompact;

  const reopenOnNewThread = useCallback(
    (command: KeyboardCommandId) => {
      if (command !== "thread.new") return false;
      setLauncher(openNewChatLauncher);

      return true;
    },
    [setLauncher],
  );

  const captureShortcut = useComposerShortcutCapture(
    LAUNCHER_SHORTCUT_COMMANDS,
    reopenOnNewThread,
  );

  const close = useCallback(
    (reason: LauncherCloseReason) => {
      if (!store.get(newChatLauncherAtom).open) return;
      closeReason.current = reason;
      typedAhead.current = "";
      setExit(reason === "dismissed" ? "dismiss" : "send");

      const focused = document.activeElement;

      if (
        reason === "opened" &&
        focused instanceof HTMLElement &&
        focused.closest(".omnyo-new-chat-launcher") !== null
      ) {
        focused.blur();
      }

      setLauncher(closeNewChatLauncher);
    },
    [setLauncher, store],
  );

  const dismiss = useCallback(() => close("dismissed"), [close]);

  const reportUnopenedFailure = useCallback(() => {
    appToast.error(UNOPENED_FAILURE_TITLE, {
      action: {
        label: "Reopen",
        onClick: () => setLauncher(openNewChatLauncher),
      },
    });
  }, [setLauncher]);

  useCloseOnLocationChange(open, location, dismiss);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        data-launcher-exit={exit}
        overlayClassName="omnyo-spotlight-backdrop"
        className={`omnyo-spotlight omnyo-new-chat-launcher top-[16%] translate-y-0 gap-0 p-0 ${NEW_CHAT_LAUNCHER_WIDTH_CLASS} ${NEW_CHAT_LAUNCHER_PANEL_CLASS}`}
        onKeyDownCapture={captureShortcut}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;

          const next = nextTypedAhead(typedAhead.current, event);

          if (next === null) return;
          typedAhead.current = next;

          if (event.key !== "Backspace") event.preventDefault();
        }}
        onFocus={(event) => {
          if (
            typedAhead.current === "" ||
            !(event.target instanceof HTMLElement) ||
            event.target.getAttribute("contenteditable") !== "true"
          ) {
            return;
          }

          promptBoxRef.current?.insertTypedText(typedAhead.current);
          typedAhead.current = "";
        }}
        onEscapeKeyDown={(event) => {
          if (promptBoxRef.current?.dismissMenu()) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (closeReason.current === "opened") event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">New chat</DialogTitle>
        {open ? (
          <LazyLauncherComposer
            focusRequest={launcher.focusRequest}
            promptBoxRef={promptBoxRef}
            onClose={close}
            onUnopenedFailure={reportUnopenedFailure}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
