import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useAppNavigate,
  useSdk,
  useRealtime,
} from "@omnyo/plugin-sdk/app";
import { z } from "zod";
import {
  planRunChannel,
  planRunEventSchema,
  previewSchema,
  runSchema,
  type PlanPreview,
  type PlanReference,
  type Selection,
} from "./plan-contract";

type Plan = Extract<PlanPreview, { kind: "plan" }>;

type Snapshot =
  | { kind: "loading" }
  | { kind: "not-plan" }
  | { kind: "unavailable" }
  | { kind: "ready"; plan: Plan }
  | { kind: "error"; message: string };

type Load = (reference: PlanReference) => Promise<PlanPreview>;

interface Entry {
  snapshot: Snapshot;
  loadedAt: number;
  generation: number;
  loading: boolean;
  again: boolean;
  scheduled: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
}

const freshForMs = 5_000;

const coalesceMs = 150;

const retainedEntries = 200;

const entries = new Map<string, Entry>();

const httpStatus = z.object({ status: z.number() });

function pursueAbsent(cause: unknown): boolean {
  const parsed = httpStatus.safeParse(cause);

  return parsed.success && (parsed.data.status === 404 || parsed.data.status === 503);
}

function entryFor(key: string): Entry {
  const existing = entries.get(key);

  if (existing !== undefined) return existing;

  const entry: Entry = {
    snapshot: { kind: "loading" },
    loadedAt: 0,
    generation: 0,
    loading: false,
    again: false,
    scheduled: null,
    listeners: new Set(),
  };

  entries.set(key, entry);

  for (const [other, candidate] of entries) {
    if (entries.size <= retainedEntries) break;

    if (
      other !== key &&
      candidate.listeners.size === 0 &&
      !candidate.loading &&
      candidate.scheduled === null
    )
      entries.delete(other);
  }

  return entry;
}

function publish(entry: Entry, snapshot: Snapshot) {
  entry.snapshot = snapshot;
  entry.loadedAt = Date.now();

  for (const listener of entry.listeners) listener();
}

function settle(key: string, snapshot: Snapshot) {
  const entry = entryFor(key);
  entry.generation += 1;
  publish(entry, snapshot);
}

function revalidate(key: string, reference: PlanReference, load: Load, maxAgeMs = 0) {
  const entry = entryFor(key);

  if (entry.loading) {
    if (maxAgeMs === 0) entry.again = true;

    return;
  }

  if (maxAgeMs > 0 && Date.now() - entry.loadedAt < maxAgeMs) return;
  entry.loading = true;
  const generation = entry.generation;

  void load(reference)
    .then(
      (preview): Snapshot => (preview.kind === "plan" ? { kind: "ready", plan: preview } : preview),
      (cause: unknown): Snapshot =>
        pursueAbsent(cause)
          ? { kind: "unavailable" }
          : {
              kind: "error",
              message: cause instanceof Error ? cause.message : "Plan actions unavailable.",
            },
    )
    .then((snapshot) => {
      entry.loading = false;

      if (generation === entry.generation) publish(entry, snapshot);
      else entry.again = true;

      if (!entry.again) return;
      entry.again = false;
      revalidate(key, reference, load);
    });
}

function schedule(key: string, reference: PlanReference, load: Load) {
  const entry = entryFor(key);

  if (entry.scheduled !== null) return;

  entry.scheduled = setTimeout(() => {
    entry.scheduled = null;
    revalidate(key, reference, load);
  }, coalesceMs);
}

const labels = {
  complete: "Completed",
  running: "Running",
  "in-progress": "In progress",
  blocked: "Blocked",
  stopped: "Stopped",
  "no-work": "No remaining steps",
  draft: "Draft",
};

export function PlanAction({ href, sourceThreadId }: { href: string; sourceThreadId: string }) {
  const sdk = useSdk();
  const navigate = experimental_useAppNavigate();
  const key = `${sourceThreadId}\n${href}`;
  const reference = useMemo(() => ({ sourceThreadId, href }), [sourceThreadId, href]);
  const [choice, setChoice] = useState<Selection | null>(null);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const startingNow = useRef(false);
  const requestId = useRef<string | null>(null);

  const load = useCallback<Load>(
    (input) =>
      sdk.plugins.callRpc({
        pluginId: "pursue",
        method: "pursue_plan_preview",
        input,
        outputSchema: previewSchema,
      }),
    [sdk],
  );

  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryFor(key);
      entry.listeners.add(listener);

      return () => {
        entry.listeners.delete(listener);
      };
    },
    [key],
  );

  const snapshot = useSyncExternalStore(subscribe, () => entryFor(key).snapshot);

  const refresh = useCallback(
    (maxAgeMs?: number) => revalidate(key, reference, load, maxAgeMs),
    [key, reference, load],
  );

  useEffect(() => refresh(freshForMs), [refresh]);

  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") refresh(freshForMs);
    };

    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);

    return () => {
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  useRealtime(planRunChannel, (payload) => {
    const event = planRunEventSchema.safeParse(payload);
    const current = entryFor(key).snapshot;

    if (!event.success || current.kind !== "ready") return;
    const run = current.plan.run;

    if (
      run?.kind === "started"
        ? run.threadId === event.data.threadId
        : event.data.parentThreadId === sourceThreadId
    )
      schedule(key, reference, load);
  });

  if (failure !== null || snapshot.kind === "error")
    return (
      <div className="omnyo-inline-file__actions" role="status">
        <span className="omnyo-inline-file__action-error">
          Plan actions unavailable: {failure ?? (snapshot.kind === "error" ? snapshot.message : "")}
        </span>
        <button
          className="omnyo-inline-file__execute"
          onClick={() => {
            setFailure(null);
            refresh();
          }}
        >
          Refresh
        </button>
      </div>
    );

  if (snapshot.kind !== "ready") return null;

  const plan = snapshot.plan;
  const run = plan.run;
  const selection = choice ?? plan.selection;
  const selectionIssue = choice === null ? plan.selectionIssue : null;

  const execution = plan.execution ?? {
    kind: "blocked",
    message: "Refresh plan actions to verify remaining work and ownership.",
  };

  const actionable = execution.kind === "actionable" && run === null && selection !== null;

  const execute = async () => {
    if (startingNow.current) return;

    if (run?.kind === "started") {
      navigate.toThread(run.threadId);

      return;
    }

    if (run?.kind === "pending") {
      refresh();

      return;
    }

    if (!actionable || selection === null) return;

    startingNow.current = true;
    setStarting(true);
    requestId.current ??= crypto.randomUUID();

    try {
      const result = await sdk.plugins.callRpc({
        pluginId: "pursue",
        method: "pursue_plan_execute",
        input: {
          sourceThreadId,
          href,
          sha256: plan.sha256,
          environmentId: plan.environmentId,
          selection,
          requestId: requestId.current,
        },
        outputSchema: runSchema,
      });

      settle(key, {
        kind: "ready",
        plan: {
          ...plan,
          selection,
          run: result,
          execution:
            result.kind === "started"
              ? { kind: "running", threadId: result.threadId }
              : { kind: "blocked", message: result.message },
        },
      });

      if (result.kind === "started") navigate.toThread(result.threadId);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not start the plan.");
    } finally {
      startingNow.current = false;
      setStarting(false);
    }
  };

  return (
    <div className="omnyo-inline-file__actions" data-plan-action="true" aria-label="Plan execution">
      {actionable && selection !== null ? (
        <ProviderModelPicker
          routing={{ kind: "environment", environmentId: plan.environmentId }}
          value={selection}
          onChange={(next) => {
            if (!startingNow.current) setChoice(next);
          }}
          align="end"
          disabled={starting}
        />
      ) : execution.kind !== "actionable" ? (
        <span
          className="omnyo-inline-file__meta"
          role="status"
          title={"message" in execution ? execution.message : undefined}
        >
          {labels[execution.kind]}
        </span>
      ) : null}
      {actionable || run !== null ? (
        <button
          className="omnyo-inline-file__execute"
          disabled={starting || (run === null && selectionIssue !== null)}
          onClick={() => void execute()}
        >
          {starting
            ? "Starting…"
            : run?.kind === "started"
              ? "Open run"
              : run?.kind === "pending"
                ? "Check run"
                : "Execute"}
        </button>
      ) : null}
      {actionable && selectionIssue !== null ? (
        <span className="omnyo-inline-file__action-error" role="status">
          {selectionIssue}
        </span>
      ) : null}
      {run?.kind === "pending" ? (
        <span className="omnyo-inline-file__action-error" role="status">
          {run.message}
        </span>
      ) : null}
    </div>
  );
}
