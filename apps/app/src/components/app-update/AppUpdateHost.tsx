import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SystemAppUpdateResult } from "@omnyo/server-contract";
import { Button } from "@omnyo/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@omnyo/shared-ui/dialog";
import { Icon } from "@omnyo/shared-ui/icon";
import { BlockingOverlay } from "@/components/layout/BlockingOverlay";
import { appToast } from "@/components/ui/app-toast";
import { CopyButton } from "@/components/ui/copy-button";
import { useAcknowledgeAppUpdate } from "@/hooks/mutations/app-update-mutations";
import { useAppUpdateStatus } from "@/hooks/queries/app-update-queries";
import {
  closeAppUpdateResultDetails,
  getAppUpdateResultDetailsSnapshot,
  openAppUpdateResultDetails,
  subscribeAppUpdateResultDetails,
} from "./app-update-details-store";
import {
  appUpdateRevisionKey,
  describeAppUpdateResult,
  pendingAppUpdateResult,
  restartingActivity,
} from "./app-update-presentation";

const FAILURE_TOAST_DURATION_MS = 60_000;

const RESTART_PATIENCE_MS = 3 * 60 * 1000;

function reloadPage(): void {
  window.location.reload();
}

export function AppUpdateHost({
  onRevisionChanged = reloadPage,
  restartPatienceMs = RESTART_PATIENCE_MS,
}: {
  onRevisionChanged?: () => void;
  restartPatienceMs?: number;
} = {}) {
  const status = useAppUpdateStatus();
  const acknowledge = useAcknowledgeAppUpdate();
  const announcedResultIds = useRef(new Set<string>());
  const loadedRevision = useRef<string | null>(null);
  const reloading = useRef(false);
  const [dismissedRestart, setDismissedRestart] = useState<string | null>(null);

  const detailsResult = useSyncExternalStore(
    subscribeAppUpdateResultDetails,
    getAppUpdateResultDetailsSnapshot,
  );

  const pendingResult = pendingAppUpdateResult(status.data);
  const restart = restartingActivity(status.data);

  const revision =
    status.data === undefined ? null : appUpdateRevisionKey(status.data);

  const acknowledgeResult = acknowledge.mutate;

  useEffect(() => {
    if (revision === null) return;

    if (loadedRevision.current === null) {
      loadedRevision.current = revision;

      return;
    }

    if (loadedRevision.current !== revision && !reloading.current) {
      reloading.current = true;
      onRevisionChanged();
    }
  }, [onRevisionChanged, revision]);

  useEffect(() => {
    if (pendingResult === null || reloading.current) return;

    if (announcedResultIds.current.has(pendingResult.id)) return;
    announcedResultIds.current.add(pendingResult.id);
    const presentation = describeAppUpdateResult(pendingResult);

    if (presentation.tone !== "error") {
      appToast[presentation.tone](presentation.title, { badge: true });
      acknowledgeResult({ id: pendingResult.id });

      return;
    }

    appToast.error(presentation.title, {
      ...(presentation.description === null
        ? {}
        : { description: presentation.description }),
      action: {
        label: "Details",
        onClick: () => openAppUpdateResultDetails(pendingResult),
      },
      duration: FAILURE_TOAST_DURATION_MS,
    });
  }, [acknowledgeResult, pendingResult]);

  return (
    <>
      <AppUpdateRestartingOverlay
        restart={
          restart === null || dismissedRestart === restart.startedAt
            ? null
            : restart
        }
        patienceMs={restartPatienceMs}
        onDismiss={setDismissedRestart}
      />
      <AppUpdateResultDialog
        result={detailsResult}
        dismissPending={acknowledge.isPending}
        onClose={closeAppUpdateResultDetails}
        onDismiss={(result) => {
          acknowledgeResult(
            { id: result.id },
            {
              onError: (error) => {
                appToast.error("Couldn't dismiss the update result", {
                  description:
                    error instanceof Error ? error.message : String(error),
                });
              },
              onSuccess: closeAppUpdateResultDetails,
            },
          );
        }}
      />
    </>
  );
}

export function AppUpdateRestartingOverlay({
  onDismiss,
  patienceMs,
  restart,
}: {
  onDismiss: (startedAt: string) => void;
  patienceMs: number;
  restart: { startedAt: string; targetRevision: string } | null;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <BlockingOverlay
      open={restart !== null}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-app-update-overlay=""
    >
      {restart === null ? null : (
        <AppUpdateRestartingCard
          key={restart.startedAt}
          titleId={titleId}
          descriptionId={descriptionId}
          patienceMs={patienceMs}
          targetRevision={restart.targetRevision}
          onDismiss={() => onDismiss(restart.startedAt)}
        />
      )}
    </BlockingOverlay>
  );
}

function AppUpdateRestartingCard({
  descriptionId,
  onDismiss,
  patienceMs,
  targetRevision,
  titleId,
}: {
  descriptionId: string;
  onDismiss: () => void;
  patienceMs: number;
  targetRevision: string;
  titleId: string;
}) {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setOverdue(true), patienceMs);

    return () => clearTimeout(timer);
  }, [patienceMs]);

  return (
    <div className="grid w-full max-w-md grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-lg border border-border bg-background p-6 shadow-lg">
      <Icon
        aria-hidden
        name="Loading"
        className="mt-0.5 size-4 animate-spin text-muted-foreground"
      />
      <div className="space-y-3">
        <div className="space-y-1.5">
          <h2
            id={titleId}
            className="text-base leading-tight font-semibold tracking-tight text-foreground"
          >
            Updating Omnyo to {targetRevision}
          </h2>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {overdue
              ? "Omnyo hasn't come back yet. A source rebuild can take a few minutes; if it doesn't return, check the terminal running Omnyo."
              : "Omnyo is restarting into the new version. This page reconnects on its own when it is back."}
          </p>
        </div>
        {overdue ? (
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AppUpdateResultDialog({
  result,
  dismissPending,
  onClose,
  onDismiss,
}: {
  result: SystemAppUpdateResult | null;
  dismissPending: boolean;
  onClose: () => void;
  onDismiss: (result: SystemAppUpdateResult) => void;
}) {
  const [lastShownResult, setLastShownResult] =
    useState<SystemAppUpdateResult | null>(result);

  if (result !== null && result !== lastShownResult) {
    setLastShownResult(result);
  }

  const current = result ?? lastShownResult;

  const presentation =
    current === null ? null : describeAppUpdateResult(current);

  const log = current?.logTail.join("\n") ?? "";
  const logRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const element = logRef.current;

    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [log, result]);

  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {current === null || presentation === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>{presentation.title}</DialogTitle>
              <DialogDescription>
                {presentation.description ??
                  "Omnyo kept running the version it had before."}
              </DialogDescription>
            </DialogHeader>
            {current.errorCode ? (
              <p className="text-sm text-muted-foreground">
                Error code:{" "}
                <code className="font-mono">{current.errorCode}</code>
              </p>
            ) : null}
            {log === "" ? null : (
              <div className="relative overflow-hidden rounded-md border bg-background">
                <CopyButton
                  text={log}
                  label="Copy update log"
                  successMessage="Update log copied"
                  className="absolute right-2 top-2 z-10 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                  iconClassName="size-3"
                />
                <pre
                  ref={logRef}
                  className="max-h-80 min-h-32 overflow-auto p-3 pr-12 text-xs whitespace-pre-wrap break-words text-foreground"
                >
                  {log}
                </pre>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
              {current.acknowledged ? null : (
                <Button
                  type="button"
                  disabled={dismissPending}
                  onClick={() => onDismiss(current)}
                >
                  Dismiss
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
