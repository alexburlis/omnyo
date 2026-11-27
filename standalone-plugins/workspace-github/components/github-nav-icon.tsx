import { useEffect, useRef, useSyncExternalStore } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginRpcResult,
} from "@omnyo/plugin-sdk/app";
import type { githubRpcContract } from "../server.js";
import { Icon } from "./ui/icon.js";
import { cn } from "../lib/utils.js";
import { usePortalScopeProps } from "../lib/portal-scope.js";

type Counts = PluginRpcResult<(typeof githubRpcContract)["counts"]>;

type Snapshot = { counts: Counts | null; failed: boolean };

let snapshot: Snapshot = { counts: null, failed: false };

const listeners = new Set<() => void>();

const readSnapshot = () => snapshot;

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};

function publish(next: Snapshot): void {
  snapshot = next;

  for (const listener of listeners) listener();
}

function countLabel({ counts, failed }: Snapshot): string {
  if (failed) return "GitHub counts unavailable; open GitHub to check sync status";

  if (counts === null || counts.lastSyncedAt === null)
    return "GitHub counts unavailable until the first sync";

  return `${counts.prs} open pull requests · ${counts.issues} open issues${counts.stale ? " · may be out of date" : ""}`;
}

// Registered icons mount outside the plugin SDK context. The app overlay owns
// the RPC subscription while the icon observes this window's count snapshot.
export function GithubNavCounts() {
  const rpc = useRpc<typeof githubRpcContract>();
  const connection = useRealtimeConnectionState();
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  const previousConnection = useRef(connection);
  const refresh = useRef<(() => void) | null>(null);
  const state = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    refresh.current = () => {
      const request = ++sequence;
      rpc.call("counts", null).then(
        (counts) => {
          if (!disposed && request === sequence)
            publish({
              counts: {
                ...counts,
                stale: counts.stale || currentConnection.current !== "connected",
              },
              failed: false,
            });
        },
        () => {
          if (!disposed && request === sequence) publish({ counts: null, failed: true });
        },
      );
    };

    publish({ counts: null, failed: false });
    refresh.current();

    return () => {
      disposed = true;
      refresh.current = null;
    };
  }, [rpc]);

  useRealtime("data-changed", () => refresh.current?.());
  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected")
      refresh.current?.();
    else if (connection !== "connected" && snapshot.counts !== null)
      publish({ ...snapshot, counts: { ...snapshot.counts, stale: true } });
    previousConnection.current = connection;
  }, [connection]);

  return (
    <span className="sr-only" role="status" aria-live="polite">
      {countLabel(state)}
    </span>
  );
}

export function GithubNavIcon({ className }: { className?: string }) {
  const state = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  const { counts } = state;
  const scopeProps = usePortalScopeProps();
  const known = counts !== null && counts.lastSyncedAt !== null;
  const total = counts === null ? 0 : counts.prs + counts.issues;
  const label = countLabel(state);
  const count = known ? `${total > 99 ? "99+" : total}` : "—";
  const stale = known && counts.stale;

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            data-omnyo-plugin-root=""
            data-omnyo-plugin="workspace-github"
            className={cn("pointer-events-auto relative inline-flex shrink-0", className)}
            title={label}
            aria-label={label}
            onPointerMove={(event) => event.stopPropagation()}
          >
            <Icon name="Github" className="size-full" />
            <span
              data-stale={stale ? "true" : undefined}
              className={cn(
                "absolute -right-1.5 -bottom-1.5 min-w-3 rounded-sm border bg-background px-0.5 text-center text-2xs leading-3 font-medium tabular-nums",
                stale
                  ? "border-dashed border-muted-foreground/60 text-subtle-foreground"
                  : "border-border text-muted-foreground",
              )}
            >
              {count}
            </span>
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            {...scopeProps}
            side="right"
            sideOffset={12}
            className="z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          >
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
