import { useCallback } from "react";
import { atom, useAtom, useSetAtom } from "jotai";
import type { TerminalForegroundResponse } from "@omnyo/server-contract";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@omnyo/shared-ui/confirm-delete-dialog";
import { useCloseTerminal } from "@/hooks/queries/thread-terminal-queries";
import { OmnyoHttpError, sdk } from "@/lib/sdk";

const FOREGROUND_TIMEOUT_MS = 1_500;

export async function readTerminalForeground(
  terminalId: string,
): Promise<TerminalForegroundResponse> {
  try {
    return await sdk.terminals.foreground({
      signal: AbortSignal.timeout(FOREGROUND_TIMEOUT_MS),
      terminalId,
    });
  } catch (error) {
    if (
      error instanceof OmnyoHttpError &&
      error.code === "terminal_not_found"
    ) {
      return { state: "idle" };
    }

    return { state: "unknown" };
  }
}

interface PendingTerminalCloseConfirm {
  foreground: Exclude<TerminalForegroundResponse, { state: "idle" }>;
  resolve: (confirmed: boolean) => void;
}

const pendingTerminalCloseConfirmAtom =
  atom<PendingTerminalCloseConfirm | null>(null);

export function useGuardedTerminalClose(): (
  terminalId: string,
) => Promise<boolean> {
  const setPending = useSetAtom(pendingTerminalCloseConfirmAtom);
  const { mutateAsync: closeTerminal } = useCloseTerminal();

  return useCallback(
    async (terminalId: string) => {
      const foreground = await readTerminalForeground(terminalId);

      if (foreground.state !== "idle") {
        const confirmed = await new Promise<boolean>((resolve) =>
          setPending({ foreground, resolve }),
        );

        if (!confirmed) return false;
      }

      await closeTerminal({ mode: "force", terminalId });

      return true;
    },
    [closeTerminal, setPending],
  );
}

export function terminalCloseConfirmDescription(
  foreground: PendingTerminalCloseConfirm["foreground"],
): string {
  if (foreground.state === "unknown") {
    return "Anything still running in it will stop.";
  }

  return foreground.command === null
    ? "A command is still running. Closing the terminal stops it."
    : `${foreground.command} is still running. Closing the terminal stops it.`;
}

export function TerminalCloseConfirmHost() {
  const [pending, setPending] = useAtom(pendingTerminalCloseConfirmAtom);

  const settle = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
  };

  return (
    <ConfirmDeleteDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      {pending ? (
        <ConfirmDeleteDialogContent
          title="Close terminal?"
          description={terminalCloseConfirmDescription(pending.foreground)}
          confirmLabel="Close terminal"
          pending={false}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );
}
