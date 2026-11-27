import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  experimental_Icon as Icon,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { PluginContentScriptContext } from "@omnyo/plugin-sdk/app";
import type { CoordinatorCallbackStatus, rpcContract } from "../../contract";

type CallbackSnapshot = {
  coordinators: readonly CoordinatorCallbackStatus[];
  status: "loading" | "ready" | "error";
};

const empty: CallbackSnapshot = { coordinators: [], status: "loading" };

let snapshot = empty;

const listeners = new Set<() => void>();

const current = () => snapshot;

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

function update(next: CallbackSnapshot) {
  snapshot = next;

  for (const listener of listeners) listener();
}

function details(wait: CoordinatorCallbackStatus) {
  if (wait.state === "queued")
    return `${wait.queued} ${wait.queued === 1 ? "package" : "packages"} queued`;

  if (wait.state === "running")
    return `${wait.running} running${wait.queued ? ` · ${wait.queued} queued` : ""}`;

  return `${wait.packageCount} ${wait.packageCount === 1 ? "package" : "packages"}`;
}

function heading(wait: CoordinatorCallbackStatus, status: CallbackSnapshot["status"]) {
  if (status === "error") return "Sentry callback status unavailable";

  if (wait.state === "blocked") return "Sentry callback blocked";

  if (wait.state === "waiting") return "Waiting for Sentry completion";

  return "Waiting for Sentry packages";
}

export function mountSentryCallbackRows(context: PluginContentScriptContext): () => void {
  const setter = context.experimental_setThreadRowStatus;

  if (!setter) return () => {};

  let owned = new Set<string>();

  const paint = () => {
    const next = new Set(snapshot.coordinators.map((wait) => wait.threadId));

    for (const id of owned) if (!next.has(id)) setter(id, null);

    for (const wait of snapshot.coordinators) {
      const blocked = snapshot.status === "error" || wait.state === "blocked";
      setter(wait.threadId, {
        icon: blocked ? "CircleAlert" : "Clock",
        label: `${heading(wait, snapshot.status)}: ${details(wait)}${wait.reason ? ` · ${wait.reason}` : ""}`,
        tone: "default",
      });
    }

    owned = next;
  };

  listeners.add(paint);
  paint();

  return () => {
    listeners.delete(paint);

    for (const id of owned) setter(id, null);
    owned.clear();
  };
}

export function SentryCallbackBridge() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;

    try {
      const result = await rpc.call("callback.status", null);

      if (request === sequence.current)
        update({ coordinators: result.coordinators, status: "ready" });
    } catch {
      if (request === sequence.current) update({ ...snapshot, status: "error" });
    }
  }, [rpc]);

  useRealtime("changed", () => {
    void refresh();
  });
  useEffect(() => {
    void refresh();

    return () => {
      sequence.current += 1;
      update(empty);
    };
  }, [refresh]);
  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);

  return null;
}

export function SentryCallbackFooter() {
  const composer = useComposer();
  const data = useSyncExternalStore(subscribe, current, current);
  const scope = composer.scope;

  if (scope.kind !== "thread") return null;
  const wait = data.coordinators.find((entry) => entry.threadId === scope.threadId);

  if (!wait) return null;
  const blocked = data.status === "error" || wait.state === "blocked";

  return (
    <div
      className="flex items-start gap-2 text-xs text-muted-foreground"
      role="status"
      data-sentry-callback-footer={wait.threadId}
    >
      <Icon name={blocked ? "CircleAlert" : "Clock"} className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <div>
          {heading(wait, data.status)} · {details(wait)}
        </div>
        {wait.reason ? <div className="mt-1 break-words">{wait.reason}</div> : null}
      </div>
    </div>
  );
}
