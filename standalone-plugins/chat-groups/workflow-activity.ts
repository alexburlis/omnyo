import { useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "@omnyo/plugin-sdk/app";
import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";
import { z } from "zod";

const activeRuns = z.object({
  runs: z.array(z.object({ id: z.string(), status: z.enum(["queued", "running"]) })),
});

// Workflow helpers are hidden and absent from sidebar bootstrap. Read their
// owner's complete active-run query, including queued runs and gaps between calls.
export function useWorkflowActivity(
  threads: readonly PluginSidebarThread[],
  activeThreadId: string | null,
) {
  const sdk = useSdk();

  const idsKey = threads
    .flatMap((thread) => (thread.isHidden || thread.isArchived ? [] : [thread.id]))
    .sort()
    .join(",");

  const ids = useMemo(() => (idsKey === "" ? [] : idsKey.split(",")), [idsKey]);

  const [state, setState] = useState({
    working: new Set<string>(),
    checked: new Set<string>(),
    failed: new Set<string>(),
  });

  const cache = useRef(state);
  const selected = useRef(activeThreadId);
  selected.current = activeThreadId;

  useEffect(() => {
    let live = true;
    let enabled: boolean | null = null;
    let checking = false;
    let availabilityEpoch = 0;
    const known = new Set(ids);
    const working = new Set(ids.filter((id) => cache.current.working.has(id)));
    const checked = new Set(ids.filter((id) => cache.current.checked.has(id)));
    const failed = new Set(ids.filter((id) => cache.current.failed.has(id)));
    const lastCheck = new Map<string, number>();
    const queue = new Set<string>();
    const revisions = new Map<string, number>();
    const inFlight = new Set<string>();

    const publish = () => {
      if (live) {
        cache.current = {
          working: new Set(working),
          checked: new Set(checked),
          failed: new Set(failed),
        };
        setState(cache.current);
      }
    };

    const drain = () => {
      while (live && enabled && inFlight.size < 6 && queue.size > 0) {
        const id = [...queue].find((candidate) => !inFlight.has(candidate));

        if (id === undefined) break;
        queue.delete(id);
        inFlight.add(id);
        lastCheck.set(id, Date.now());
        const epoch = availabilityEpoch;
        const revision = revisions.get(id) ?? 0;
        sdk.plugins
          .callRpc({
            pluginId: "workflows",
            method: "workflowActiveRuns",
            input: { threadId: id },
            outputSchema: activeRuns,
          })
          .then(
            ({ runs }) => {
              if (
                !live ||
                !enabled ||
                epoch !== availabilityEpoch ||
                revision !== (revisions.get(id) ?? 0)
              )
                return;

              if (runs.length > 0) working.add(id);
              else working.delete(id);
              checked.add(id);
              failed.delete(id);
            },
            () => {
              if (
                live &&
                enabled &&
                epoch === availabilityEpoch &&
                revision === (revisions.get(id) ?? 0)
              )
                failed.add(id);
            },
          )
          .finally(() => {
            inFlight.delete(id);
            lastCheck.set(id, Date.now());
            publish();
            drain();
          });
      }
    };

    const enqueue = (id: string, requireCheck = false) => {
      if (enabled === false) return;

      if (known.has(id)) {
        if (requireCheck) {
          revisions.set(id, (revisions.get(id) ?? 0) + 1);
          checked.delete(id);
          publish();
        }

        queue.add(id);
        drain();
      }
    };

    const discover = async () => {
      if (checking) return;
      checking = true;

      try {
        const { plugins } = await sdk.plugins.list();

        if (!live) return;
        const available = plugins.some((plugin) => plugin.id === "workflows" && plugin.enabled);

        if (available !== enabled) availabilityEpoch += 1;
        enabled = available;

        if (!enabled) {
          working.clear();
          failed.clear();

          for (const id of ids) checked.add(id);
          publish();
        } else {
          if (selected.current !== null) enqueue(selected.current);

          for (const id of ids) if (id !== selected.current) enqueue(id);
        }
      } catch {
        if (live) {
          enabled = null;

          for (const id of ids) failed.add(id);
          publish();
        }
      } finally {
        checking = false;
      }
    };

    publish();
    void discover();

    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;

      if (enabled === null) {
        void discover();

        return;
      }

      if (!enabled) return;
      const now = Date.now();

      for (const id of ids)
        if (now - (lastCheck.get(id) ?? 0) >= (working.has(id) || failed.has(id) ? 4000 : 30000))
          enqueue(id);
    }, 4000);

    const visible = () => {
      if (document.visibilityState !== "hidden") void discover();
    };

    document.addEventListener("visibilitychange", visible);

    const disposers = [
      sdk.subscribe({
        event: "thread:changed",
        callback: ({ id, changes }) => {
          if (
            id !== undefined &&
            changes.some((change) => change === "status-changed" || change === "queue-changed")
          )
            enqueue(id, true);
        },
      }),
      sdk.subscribe({
        event: "realtime:connection",
        callback: ({ state: connection }) => {
          if (connection === "connected") void discover();
        },
      }),
      sdk.subscribe({
        event: "system:changed",
        callback: () => {
          void discover();
        },
      }),
    ];

    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);

      for (const dispose of disposers) dispose();
    };
  }, [sdk, ids]);

  const uncertain = useMemo(
    () => new Set(ids.filter((id) => !state.checked.has(id) || state.failed.has(id))),
    [ids, state],
  );

  return {
    working: state.working,
    uncertain,
    failed: state.failed.size > 0,
  };
}
