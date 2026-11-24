import { useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@omnyo/shared-ui/dialog";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { useClipboardCopy } from "@/lib/clipboard";

export interface ProviderCliInstallLogDialogState {
  displayName: string;
  log: string;
  message: string;
  title: string;
  code?: string | null;
}

export interface ProviderCliInstallLogDialogProps {
  state: ProviderCliInstallLogDialogState | null;
  onClose: () => void;
}

interface ProviderCliInstallLogDialogContentProps {
  state: ProviderCliInstallLogDialogState;
}

export function ProviderCliInstallLogDialog({
  state,
  onClose,
}: ProviderCliInstallLogDialogProps) {
  const renderedStateRef = useRef<ProviderCliInstallLogDialogState | null>(
    state,
  );

  const isOpen = state !== null;

  if (state !== null) {
    renderedStateRef.current = state;
  }

  const currentState = state ?? renderedStateRef.current;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent>
        {currentState ? (
          <ProviderCliInstallLogDialogContent state={currentState} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ProviderCliInstallLogDialogContent({
  state,
}: ProviderCliInstallLogDialogContentProps) {
  const { copied, copy } = useClipboardCopy({
    text: state.log,
    successMessage: `${state.displayName} setup log copied`,
  });

  return (
    <>
      <DialogHeader>
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-surface-destructive text-destructive-text ring-1 ring-surface-destructive-border"
          >
            <Icon name="AlertCircle" className="size-4" />
          </span>
          <div className="min-w-0 space-y-1">
            <DialogTitle>{state.title}</DialogTitle>
            <DialogDescription>
              {state.message}
              {state.code ? (
                <span className="mt-1.5 block w-fit rounded-sm bg-state-hover px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {state.code}
                </span>
              ) : null}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="overflow-hidden rounded-lg border border-border bg-surface-recessed">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Icon name="Terminal" aria-hidden className="size-3.5" />
            Command output
          </span>
          <Button
            type="button"
            size="xs"
            variant="soft"
            onClick={() => void copy()}
          >
            <Icon name={copied ? "Check" : "Copy"} aria-hidden />
            {copied ? "Copied" : "Copy log"}
          </Button>
        </div>
        <pre className="max-h-80 min-h-32 overflow-auto p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-foreground">
          {state.log}
        </pre>
      </div>
    </>
  );
}
