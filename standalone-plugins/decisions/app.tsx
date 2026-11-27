import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_useAppNavigate,
  useRealtime,
  useRpc,
  useSdk,
  experimental_ThreadAttention as ThreadAttention,
} from "@omnyo/plugin-sdk/app";
import type { DecisionGroup, rpcContract } from "./server";
import { Button } from "@/components/ui/button";

const CHANGED = "decisions-changed";

const GLYPH = "decisions/signpost";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/* ------------------------------------------------------------ data -- */

/** Every chat with open decisions and its count. One cheap SELECT. */
function useNativeRefresh(refresh: () => void): void {
  const sdk = useSdk();
  useEffect(() => sdk.subscribe({ event: "thread:changed", callback: refresh }), [sdk, refresh]);
}

function useOpenIndex(): Array<{ threadId: string; count: number }> {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<Array<{ threadId: string; count: number }>>([]);

  const refetch = useCallback(() => {
    rpc.call("open_index").then(
      (result) => setThreads(result.threads),
      () => setThreads([]),
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(CHANGED, refetch);
  useNativeRefresh(refetch);

  return threads;
}

/* ------------------------------------------------------------ page -- */

function DecisionsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = experimental_useAppNavigate();
  const [groups, setGroups] = useState<DecisionGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    rpc.call("overview").then(
      (result) => {
        setGroups(result.groups);
        setError(result.error);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(CHANGED, refetch);
  useNativeRefresh(refetch);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Answer required questions or steer ongoing work.
        </p>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {groups === null ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Loading…
          </p>
        ) : groups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No open decisions.
          </p>
        ) : (
          <ul className="space-y-4">
            {groups.map((group) => (
              <li key={group.threadId} className="rounded-lg border border-border bg-card p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => navigate.toThread(group.threadId)}
                      className="truncate text-left text-sm font-medium text-foreground hover:underline"
                    >
                      {group.title}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      {group.projectName === "" ? null : <>{group.projectName} · </>}
                      {plural(group.decisions.length, "open decision", "open decisions")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate.toThread(group.threadId)}
                  >
                    Open chat
                  </Button>
                </div>
                <ThreadAttention threadId={group.threadId} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Total open decisions, on the page's sidebar row. */
function OpenCount() {
  const threads = useOpenIndex();
  const total = threads.reduce((sum, thread) => sum + thread.count, 0);

  if (total === 0) return null;

  return (
    <span className="text-xs tabular-nums text-muted-foreground" title={`${total} open`}>
      {total}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "decisions",
    title: "Questions",
    icon: GLYPH,
    path: "decisions",
    component: DecisionsPage,
    experimental_sidebarAccessory: OpenCount,
  });
});
