import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import { ArchiveApprovalForm, ArchiveProposalReceipt } from "./ArchiveApproval";
import { ARCHIVE_APPROVAL_RENDERER_ID } from "./archive-approval";
import { archiveFailureText, createArchiveStore } from "./archive-store";
import { broadcastReadiness, canShowReadiness, createReadinessStore } from "./readiness-store";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_useAppNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginComposerThreadRowStatus,
} from "@omnyo/plugin-sdk/app";
import type { Caveat, Entry, Queue, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const CHANGED = "tidy-changed";

/* ------------------------------------------------------------ data -- */

const readiness = createReadinessStore();

const archiving = createArchiveStore();

const changedSchema = z.object({
  revision: z.number().int(),
  threadIds: z.array(z.string()),
  waiting: z.array(z.object({ threadId: z.string(), on: z.string() })),
  stale: z.boolean().default(false),
});

function useReadyIds() {
  const rpc = useRpc<typeof rpcContract>();
  const snapshot = useSyncExternalStore(readiness.subscribe, readiness.getSnapshot);
  const { hidden } = useSyncExternalStore(archiving.subscribe, archiving.getSnapshot);
  const { threads } = experimental_useSidebarThreads();
  const readyIds = snapshot.threadIds;

  useEffect(() => archiving.release(readyIds), [readyIds]);

  const refetch = useCallback(() => {
    void readiness.refresh(() => rpc.call("ready_ids"));
  }, [rpc]);

  const byId = new Map(threads.map((thread) => [thread.id, thread]));

  return {
    ids: readyIds.filter((id) => !hidden.has(id) && canShowReadiness(byId.get(id))),
    refetch,
    refreshFailed: snapshot.refreshFailed,
  };
}

/** The full queue with live facts. The expensive read — page surfaces only. */
function useQueue() {
  const rpc = useRpc<typeof rpcContract>();
  const [queue, setQueue] = useState<Queue | null>(null);
  const { ids } = useReadyIds();
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error` on purpose: a failed Archive must survive the
  // refetch that follows it, or the user is shown a successful-looking list
  // with the chat still in it and no idea why.
  const [actionError, setActionError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("queue_get").then((result) => {
      setQueue(result);
      setError(null);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(CHANGED, refetch);

  const visibleQueue =
    queue === null
      ? null
      : { ...queue, entries: queue.entries.filter((entry) => ids.includes(entry.threadId)) };

  return { rpc, queue: visibleQueue, error, actionError, setActionError, report, refetch };
}

/**
 * The archive RPC RESOLVES with per-thread failures rather than rejecting, so
 * "the call came back" is not "the chats were archived".
 */
type ActionResult =
  | import("zod").infer<(typeof rpcContract)["archive"]["output"]>
  | import("zod").infer<(typeof rpcContract)["dismiss"]["output"]>;

function failureText(result: ActionResult): string | null {
  return "failures" in result ? archiveFailureText(result.failures) : null;
}

function archiveNow(
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>,
  threadIds: string[],
  refetch: () => void,
): void {
  void archiving.archive(threadIds, () => rpc.call("archive", { threadIds })).then(refetch);
}

function formatAge(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));

  if (minutes < 1) return "just now";

  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);

  if (hours < 48) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

/* -------------------------------------------------- row decoration -- */

const ROW_STATUS: PluginComposerThreadRowStatus = {
  icon: "CircleCheckSolid",
  label: "Ready to archive",
  tone: "success",
};

type RowSetter = (threadId: string, status: PluginComposerThreadRowStatus | null) => void;

let rowSetter: RowSetter | null = null;

let desiredRows: readonly string[] = [];

let appliedRows: readonly string[] = [];

function syncRows(): void {
  if (rowSetter === null) return;

  for (const threadId of appliedRows) {
    if (!desiredRows.includes(threadId)) rowSetter(threadId, null);
  }

  for (const threadId of desiredRows) {
    if (!appliedRows.includes(threadId)) rowSetter(threadId, ROW_STATUS);
  }

  appliedRows = [...desiredRows];
}

function setDesiredRows(threadIds: readonly string[]): void {
  desiredRows = threadIds;
  syncRows();
}

/**
 * Invisible: it owns no UI, only the RPC subscription that feeds `syncRows`.
 * An overlay rather than a page component because the sidebar is visible from
 * every route, so this has to outlive any one of them.
 */
function RowStatusSync() {
  const connectionState = useRealtimeConnectionState();
  const { ids, refetch } = useReadyIds();
  useEffect(() => {
    if (connectionState === "connected") refetch();
  }, [connectionState, refetch]);
  useEffect(() => broadcastReadiness(readiness, window), []);
  useRealtime(CHANGED, (payload) => {
    const changed = changedSchema.safeParse(payload);

    if (changed.success) readiness.accept(changed.data);
    else refetch();
  });
  const { values } = useSettings();
  const enabled = values?.rowStatus !== false;
  useEffect(() => {
    setDesiredRows(enabled ? ids : []);
  }, [ids, enabled]);
  useEffect(() => () => setDesiredRows([]), []);

  return null;
}

/* ----------------------------------------------------------- parts -- */

function CaveatList({ caveats }: { caveats: Caveat[] }) {
  if (caveats.length === 0) return null;

  return (
    <div className="mt-3 flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
      <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-foreground">Still open in this chat</p>
        <ul className="mt-0.5 space-y-0.5 text-xs leading-5 text-muted-foreground">
          {caveats.map((caveat) => (
            <li key={caveat.code + caveat.text}>{caveat.text}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Notice({
  children,
  title,
  icon,
  tone = "default",
}: {
  children?: ReactNode;
  title: string;
  icon: "CircleCheck" | "Spinner";
  tone?: "default" | "error";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center"
    >
      <span className="grid size-11 place-items-center rounded-full bg-state-hover text-muted-foreground ring-1 ring-border">
        <Icon
          name={icon}
          className={cn("size-5", icon === "Spinner" && "motion-safe:animate-spin")}
          aria-hidden
        />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-base font-semibold text-foreground">{title}</p>
        {children === undefined ? null : (
          <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
        )}
      </div>
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"
    >
      <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function EntryCard({
  entry,
  onOpen,
  onArchive,
  onDismiss,
  busy,
}: {
  entry: Entry;
  onOpen: () => void;
  onArchive: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  return (
    <li className="rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onOpen}
            title="Open this chat"
            className="block max-w-full cursor-pointer truncate rounded-sm text-left text-sm font-semibold text-foreground decoration-border underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60"
          >
            {entry.title}
          </button>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {entry.projectName === "" ? null : <>{entry.projectName} · </>}
            Updated {formatAge(entry.updatedAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            title="Remove this chat from the list and leave it as it is"
            className="inline-flex"
          >
            <Button size="xs" variant="soft" onClick={onDismiss} disabled={busy}>
              Not done
            </Button>
          </span>
          <span title="Archive this chat. You can unarchive it later" className="inline-flex">
            <Button size="xs" variant="outline" onClick={onArchive} disabled={busy}>
              <Icon name="Archive" className="size-3.5" aria-hidden />
              Archive
            </Button>
          </span>
        </div>
      </div>
      <p className="mt-2.5 flex gap-2 text-sm leading-relaxed text-foreground">
        <Icon name="CircleCheck" className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        <span className="min-w-0">{entry.reason}</span>
      </p>
      <CaveatList caveats={entry.caveats} />
    </li>
  );
}

/* ------------------------------------------------------------ page -- */

function TidyPage() {
  const { rpc, queue, error, actionError, setActionError, refetch } = useQueue();
  const navigate = experimental_useAppNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => () => archiving.dismissFailure(), []);

  const { failure: archiveFailure } = useSyncExternalStore(
    archiving.subscribe,
    archiving.getSnapshot,
  );

  const act = (threadId: string, run: () => Promise<ActionResult>) => {
    setBusy(threadId);
    setActionError(null);
    run().then(
      (result) => {
        setBusy(null);
        setActionError(failureText(result));
        refetch();
      },
      (cause: unknown) => {
        setBusy(null);
        setActionError(cause instanceof Error ? cause.message : String(cause));
        refetch();
      },
    );
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Chats Omnyo judges finished, with the reason it gives. Nothing here is archived until you
          archive it, and archived chats can be unarchived.
        </p>
        {error === null ? null : <ErrorLine>{error}</ErrorLine>}
        {actionError === null ? null : <ErrorLine>{actionError}</ErrorLine>}
        {archiveFailure === null ? null : <ErrorLine>{archiveFailure}</ErrorLine>}
        {queue !== null && queue.error !== null ? (
          <p className="mt-3 text-xs text-muted-foreground">{queue.error}</p>
        ) : null}
        <div className="mt-4">
          {queue === null ? (
            <Notice icon="Spinner" title="Checking your chats…" />
          ) : queue.entries.length === 0 ? (
            <Notice icon="CircleCheck" title="Nothing to tidy">
              A chat appears here once Omnyo judges the work in it finished.
            </Notice>
          ) : (
            <ul className="space-y-3">
              {queue.entries.map((entry) => (
                <EntryCard
                  key={entry.threadId}
                  entry={entry}
                  busy={busy === entry.threadId}
                  onOpen={() => navigate.toThread(entry.threadId)}
                  onArchive={() => {
                    setActionError(null);
                    archiveNow(rpc, [entry.threadId], refetch);
                  }}
                  onDismiss={() =>
                    act(entry.threadId, () => rpc.call("dismiss", { threadId: entry.threadId }))
                  }
                />
              ))}
            </ul>
          )}
        </div>
        {queue !== null && queue.omitted > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {queue.omitted} more ready {queue.omitted === 1 ? "chat is" : "chats are"} not shown —
            the page reads at most 100 at a time.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** "Archive all", in the host title bar beside the page title. */
function TidyPageHeader() {
  const { rpc, queue, refetch } = useQueue();
  const [open, setOpen] = useState(false);
  const entries = queue?.entries ?? [];
  const withCaveats = entries.filter((entry) => entry.caveats.length > 0).length;

  if (entries.length === 0) return null;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Icon name="Archive" className="size-4" aria-hidden />
        Archive all ({entries.length})
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {entries.length} chats?</DialogTitle>
            <DialogDescription>
              They move to your archive and can be unarchived at any time.
              {withCaveats === 0
                ? null
                : ` ${withCaveats} of them still ${withCaveats === 1 ? "has" : "have"} something open.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
                archiveNow(
                  rpc,
                  entries.map((entry) => entry.threadId),
                  refetch,
                );
              }}
            >
              Archive all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** How many chats are waiting to be tidied, on the sidebar row. */
function ReadyCount() {
  const { ids, refreshFailed } = useReadyIds();

  if (ids.length === 0 && !refreshFailed) return null;

  return (
    <span
      className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
      role={refreshFailed ? "status" : undefined}
      aria-label={refreshFailed ? "Could not refresh archive suggestions" : undefined}
      title={
        refreshFailed ? "Could not refresh archive suggestions" : `${ids.length} ready to archive`
      }
    >
      {ids.length > 0 ? ids.length : null}
      {refreshFailed ? <Icon name="AlertCircle" className="size-3.5" aria-hidden /> : null}
    </span>
  );
}

/* ---------------------------------------------------- registration -- */

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: ARCHIVE_APPROVAL_RENDERER_ID,
    component: ArchiveApprovalForm,
  });

  app.slots.messageDirective({ id: "archive-chats", component: ArchiveProposalReceipt });

  app.slots.navPanel({
    id: "tidy",
    title: "Tidy",
    icon: "Archive",
    path: "tidy",
    component: TidyPage,
    headerContent: TidyPageHeader,
    experimental_sidebarAccessory: ReadyCount,
  });

  app.slots.experimental_appOverlay({
    id: "row-status-sync",
    component: RowStatusSync,
  });

  // The other half of the row marker: this is the only context that carries
  // the setter. It holds no state of its own — `RowStatusSync` decides what
  // should be marked, this decides whether anything can be.
  app.contentScripts.register({
    id: "row-status",
    mount({ experimental_setThreadRowStatus }) {
      if (experimental_setThreadRowStatus === undefined) return;
      rowSetter = experimental_setThreadRowStatus;
      appliedRows = [];
      syncRows();

      return () => {
        // The host clears this generation's statuses itself; dropping the
        // reference is all that is left, and calling a torn-down setter is
        // not something to try.
        rowSetter = null;
        appliedRows = [];
      };
    },
  });
});
