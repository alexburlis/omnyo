import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { atom, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type {
  TerminalCreateTarget,
  TerminalSession,
} from "@omnyo/server-contract";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { AppCommandShortcutPill } from "@/components/commands/AppCommandShortcutHint";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { appCommandTarget } from "@/lib/app-command-targets";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import {
  readTerminalForeground,
  useGuardedTerminalClose,
} from "@/components/thread/terminal/terminal-close-guard";
import type { TerminalInputInterceptor } from "@/components/thread/terminal/ThreadTerminalView";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";
import {
  useCloseTerminal,
  useCreateTerminal,
  useSendTerminalInput,
  useThreadTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import { browserPlatform, formatAppShortcut } from "@/lib/app-keybindings";
import { sdk } from "@/lib/sdk";
import { isVisibleTerminalSession } from "@/lib/terminal-session-visibility";
import { COMPOSER_TOOL_BUTTON_CLASS } from "./composer-tool-button";
import { modifierSubmitShortcutLabel } from "./modifier-submit-shortcut";

const SHELL_COMMAND_PATTERN = /^\s*!([\s\S]*)$/u;

export function parseComposerShellCommand(text: string): string | null {
  const match = SHELL_COMMAND_PATTERN.exec(text);

  return match === null ? null : (match[1] ?? "").trim();
}

export function shellCommandInput(command: string): string {
  return `${command.replace(/\r?\n/gu, "\r")}\r`;
}

const CTRL_C = "\u0003";

export const CTRL_C_CLOSE_WINDOW_MS = 2_000;

export function lineIsDirtyAfter(data: string): boolean {
  return data !== CTRL_C && !data.endsWith("\r");
}

export function ctrlCCloseHintLabel(): string {
  return formatAppShortcut(
    {
      alt: false,
      control: true,
      key: "c",
      meta: false,
      mod: false,
      shift: false,
    },
    browserPlatform(),
  );
}

const SHELL_READY_POLL_MS = 100;

const SHELL_READY_TIMEOUT_MS = 3_000;

async function waitForShellPrompt(terminalId: string): Promise<void> {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const output = await sdk.terminals.output({ limitChunks: 1, terminalId });

    if (output.chunks.length > 0 || output.status !== "running") return;

    await new Promise((resolve) => setTimeout(resolve, SHELL_READY_POLL_MS));
  }
}

const composerTerminalIdsAtom = atomWithStorage<Record<string, string>>(
  "omnyo.composerTerminals",
  {},
);

const composerTerminalShownAtom = atom<Record<string, boolean>>({});

export interface ComposerTerminal {
  closeHintShown: boolean;
  interceptInput: TerminalInputInterceptor;
  isShown: boolean;
  isStarting: boolean;
  session: TerminalSession | null;
  target: TerminalCreateTarget;
  close: () => void;
  hide: () => void;
  run: (command: string) => Promise<void>;
  toggle: () => void;
}

export function useComposerTerminal(
  threadId: string | null,
): ComposerTerminal | null {
  const [terminalIds, setTerminalIds] = useAtom(composerTerminalIdsAtom);
  const [shown, setShown] = useAtom(composerTerminalShownAtom);
  const terminalId = threadId === null ? null : (terminalIds[threadId] ?? null);

  const wantsShown = threadId !== null && shown[threadId] === true;

  const target = useMemo<TerminalCreateTarget | null>(
    () => (threadId === null ? null : { kind: "thread", threadId }),
    [threadId],
  );

  const terminals = useThreadTerminals(threadId ?? "", {
    enabled: terminalId !== null || wantsShown,
  });

  const createTerminal = useCreateTerminal();
  const sendInput = useSendTerminalInput();
  const { mutateAsync: closeTerminal } = useCloseTerminal();
  const guardedClose = useGuardedTerminalClose();
  const startingRef = useRef<Promise<string> | null>(null);
  const lineDirtyRef = useRef(false);
  const closeArmedAtRef = useRef<number | null>(null);
  const [closeHintShown, setCloseHintShown] = useState(false);

  const session =
    terminalId === null
      ? null
      : (terminals.data?.sessions.find(
          (candidate) =>
            candidate.id === terminalId && isVisibleTerminalSession(candidate),
        ) ?? null);

  const isStarting = createTerminal.isPending;
  const isShown = wantsShown && (session !== null || isStarting);

  const setThreadShown = useCallback(
    (value: boolean) =>
      setShown((current) =>
        threadId === null || current[threadId] === value
          ? current
          : { ...current, [threadId]: value },
      ),
    [setShown, threadId],
  );

  const setThreadTerminalId = useCallback(
    (id: string | null) =>
      setTerminalIds((current) => {
        if (threadId === null) return current;

        if (id === null) {
          if (!(threadId in current)) return current;
          const { [threadId]: _removed, ...rest } = current;

          return rest;
        }

        return { ...current, [threadId]: id };
      }),
    [setTerminalIds, threadId],
  );

  const ensureSession = useCallback((): Promise<string> => {
    if (session !== null && session.status === "running") {
      return Promise.resolve(session.id);
    }

    if (startingRef.current !== null) return startingRef.current;

    if (target === null) {
      return Promise.reject(new Error("Composer terminal needs a chat"));
    }

    const starting = createTerminal
      .mutateAsync({
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
        start: { mode: "shell" },
        target,
        title: "Chat terminal",
      })
      .then(async (created) => {
        setThreadTerminalId(created.id);
        await waitForShellPrompt(created.id);

        return created.id;
      })
      .finally(() => {
        startingRef.current = null;
      });

    startingRef.current = starting;

    return starting;
  }, [createTerminal, session, setThreadTerminalId, target]);

  const run = useCallback(
    async (command: string) => {
      setThreadShown(true);
      const id = await ensureSession();
      await sendInput.mutateAsync({
        terminalId: id,
        text: shellCommandInput(command),
      });
    },
    [ensureSession, sendInput, setThreadShown],
  );

  const hide = useCallback(() => setThreadShown(false), [setThreadShown]);

  const toggle = useCallback(() => {
    if (isShown) {
      setThreadShown(false);

      return;
    }

    setThreadShown(true);
    void ensureSession().catch(() => setThreadShown(false));
  }, [ensureSession, isShown, setThreadShown]);

  const close = useCallback(() => {
    if (session === null) {
      setThreadShown(false);
      setThreadTerminalId(null);

      return;
    }

    void guardedClose(session.id)
      .then((closed) => {
        if (!closed) return;
        setThreadShown(false);
        setThreadTerminalId(null);
      })
      .catch(() => undefined);
  }, [guardedClose, session, setThreadShown, setThreadTerminalId]);

  const disarmClose = useCallback(() => {
    closeArmedAtRef.current = null;
    setCloseHintShown(false);
  }, []);

  useEffect(() => {
    if (!closeHintShown) return;
    const timeout = setTimeout(disarmClose, CTRL_C_CLOSE_WINDOW_MS);

    return () => clearTimeout(timeout);
  }, [closeHintShown, disarmClose]);

  const sessionId = session?.id ?? null;

  const interceptInput = useCallback<TerminalInputInterceptor>(
    (data, forward) => {
      if (data !== CTRL_C || lineDirtyRef.current || sessionId === null) {
        lineDirtyRef.current = lineIsDirtyAfter(data);
        disarmClose();

        return false;
      }

      void readTerminalForeground(sessionId).then((foreground) => {
        if (foreground.state !== "idle") {
          disarmClose();
          forward();

          return;
        }

        const armedAt = closeArmedAtRef.current;

        if (
          armedAt !== null &&
          Date.now() - armedAt <= CTRL_C_CLOSE_WINDOW_MS
        ) {
          disarmClose();
          setThreadShown(false);
          void closeTerminal({ mode: "force", terminalId: sessionId })
            .then(() => setThreadTerminalId(null))
            .catch(() => undefined);

          return;
        }

        forward();
        closeArmedAtRef.current = Date.now();
        setCloseHintShown(true);
      });

      return true;
    },
    [
      closeTerminal,
      disarmClose,
      sessionId,
      setThreadShown,
      setThreadTerminalId,
    ],
  );

  if (target === null) return null;

  return {
    close,
    closeHintShown,
    hide,
    interceptInput,
    isShown,
    isStarting,
    run,
    session,
    target,
    toggle,
  };
}

const SHORTCUT_PILL_CLASS = "bg-transparent px-1 py-0.5 opacity-70";

export function ComposerShellModeHeader() {
  return (
    <div
      data-composer-shell-mode=""
      className="flex min-h-7 items-center gap-1.5 text-xs text-subtle-foreground"
    >
      <Icon name="Terminal" className="size-3.5 shrink-0" aria-hidden />
      <span>Runs in terminal</span>
      <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
        <AppCommandShortcutPill
          shortcut={{ label: modifierSubmitShortcutLabel() }}
          className={SHORTCUT_PILL_CLASS}
        />
        sends as message
      </span>
    </div>
  );
}

export function ComposerTerminalToggleButton({
  className,
  onToggle,
}: {
  className?: string;
  onToggle: () => void;
}) {
  const shortcut = useAppCommandShortcut("composer.terminal.toggle");

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Show terminal"
            data-composer-terminal-toggle=""
            {...appCommandTarget("composer.terminal.toggle")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onToggle}
            className={cn(COMPOSER_TOOL_BUTTON_CLASS, "relative", className)}
          >
            <Icon name="Terminal" className="size-4" />
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-success"
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="flex items-center gap-2">
          Show terminal
          {shortcut ? <AppCommandShortcutPill shortcut={shortcut} /> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ComposerTerminalCard({
  terminal,
  onSelectionAddToChat,
  onShowChat,
}: {
  terminal: ComposerTerminal;
  onSelectionAddToChat: (text: string) => void;
  onShowChat: () => void;
}) {
  const shortcut = useAppCommandShortcut("composer.terminal.toggle");
  const session = terminal.session;

  return (
    <div
      data-composer-terminal=""
      className="group/composer-terminal relative w-full overflow-hidden rounded-[20px] bg-(--material-raised) shadow-(--material-shadow-raised) animate-in fade-in-0 duration-(--motion-duration-base)"
    >
      <div className="flex h-9 items-center gap-1.5 pr-1.5 pl-3.5 text-xs text-subtle-foreground">
        <Icon name="Terminal" className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-mono">
          {session?.title ?? "Starting terminal…"}
        </span>
        {session ? (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-success"
            title="Running"
          />
        ) : null}
        {terminal.closeHintShown ? (
          <span
            role="status"
            data-composer-terminal-close-hint=""
            className="ml-2 shrink-0 text-muted-foreground"
          >
            Press {ctrlCCloseHintLabel()} again to close
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onShowChat}
            aria-label="Back to chat"
            {...appCommandTarget("composer.terminal.toggle")}
            className="h-7 gap-1.5 rounded-full px-2.5 text-xs text-subtle-foreground hover:text-foreground"
          >
            <Icon name="MessageSquare" className="size-3.5" aria-hidden />
            Chat
            {shortcut ? (
              <AppCommandShortcutPill
                shortcut={shortcut}
                className={SHORTCUT_PILL_CLASS}
              />
            ) : null}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={terminal.close}
            aria-label="End terminal session"
            className="size-7 rounded-full text-subtle-foreground hover:text-foreground"
          >
            <Icon name="X" className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      <div className="px-1.5 pb-1.5">
        <div className="h-[min(42vh,360px)] overflow-hidden rounded-[14px] bg-sidebar">
          {session ? (
            <LazyThreadTerminalPanel
              autoFocus
              interceptInput={terminal.interceptInput}
              isPanelOpen
              isPanelPersistedOpen
              onSelectionAddToChat={onSelectionAddToChat}
              target={terminal.target}
              terminalId={session.id}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Starting terminal…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
