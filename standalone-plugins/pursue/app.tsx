// Thread-header control for Pursue.
//
// Shows a pill in the thread header whenever the thread has a goal, with the
// objective text, progress, and edit/cancel controls. On phones the host hides
// header controls, so the same goal is a thread-actions menu item. Both open one
// dialog, mounted once through an app overlay. Loops show in Glance's
// chat card instead. Every action
// here touches plugin state only — the thread's turn is never interrupted, so
// you can retarget or call off a goal while the agent is mid-run.
import * as React from "react";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  useRpc,
  useRealtime,
} from "@omnyo/plugin-sdk/app";

import { z } from "zod";
import type { rpcContract } from "./server.js";
import {
  createGoalDialogStore,
  goalLabel,
  goalThreadAction,
  type ThreadGoal,
} from "./goal-menu.js";
import { PlanRunBar } from "./plan-runs";
import { PlanSettings } from "./plan-settings";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Icon } from "./components/ui/icon.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";

const goalDialog = createGoalDialogStore();

function useGoalStates(threadIds: readonly string[]) {
  const rpc = useRpc<typeof rpcContract>();
  const [goals, setGoals] = React.useState<ReadonlyMap<string, ThreadGoal | null>>(new Map());
  const [failed, setFailed] = React.useState<ReadonlySet<string>>(new Set());
  const requested = React.useRef(new Set<string>());
  const key = threadIds.join("\n");

  const load = React.useCallback(
    async (ids: readonly string[]) => {
      try {
        const loaded = await rpc.call("pursue_goals", { threadIds: [...ids] });

        setFailed((current) => new Set([...current].filter((id) => !ids.includes(id))));

        setGoals(
          (current) =>
            new Map([...current, ...ids.map((id) => [id, loaded.goals[id] ?? null] as const)]),
        );
      } catch {
        for (const id of ids) requested.current.delete(id);
        setFailed((current) => new Set([...current, ...ids]));
      }
    },
    [rpc],
  );

  React.useEffect(() => {
    const missing = key === "" ? [] : key.split("\n").filter((id) => !requested.current.has(id));

    for (const id of missing) requested.current.add(id);

    if (missing.length > 0) void load(missing);
  }, [key, load]);

  // The backend publishes on every mutation, including the ones it makes
  // itself after each judgement, so progress stays live.
  useRealtime("pursue-changed", (payload) => {
    const changed = z.object({ threadId: z.string() }).safeParse(payload);

    if (changed.success && requested.current.has(changed.data.threadId)) {
      void load([changed.data.threadId]);
    }
  });

  const apply = React.useCallback((threadId: string, goal: ThreadGoal | null) => {
    setGoals((current) => new Map([...current, [threadId, goal]]));
  }, []);

  return { goals, failed, apply };
}

function PursueHeaderAction({ threadId }: { threadId: string }) {
  const { goals } = useGoalStates([threadId]);
  const goal = goals.get(threadId) ?? null;

  // A met goal is deleted by the backend, so a goal that is still here but no
  // longer active stopped for a reason the user should see — it stays in the
  // header, static and dismissible, rather than silently disappearing.
  if (goal === null) return null;

  const label = goalLabel(goal);
  const active = goal.status === "active";

  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-7 max-w-[16rem] gap-1.5 px-2${active ? "" : " text-muted-foreground"}`}
      onClick={() => goalDialog.open(threadId)}
      aria-label={
        active
          ? `Goal, checked ${goal.iterations} of ${goal.maxIterations} times: ${goal.objective}`
          : `${label}: ${goal.objective}`
      }
    >
      <Icon name="Target" className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 text-xs font-medium">{active ? "Goal" : label}</span>
      {active ? (
        <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-state-hover px-1.5 text-2xs font-semibold tabular-nums text-muted-foreground">
          {goal.iterations}/{goal.maxIterations}
        </span>
      ) : null}
      <span className="min-w-0 truncate text-xs text-muted-foreground">{goal.objective}</span>
    </Button>
  );
}

function GoalDialogContent({
  threadId,
  goal,
  apply,
}: {
  threadId: string;
  goal: ThreadGoal;
  apply: (threadId: string, goal: ThreadGoal | null) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = React.useState(goal.objective);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const stoppedGoal = goal.status !== "active";

  const run = async (action: () => Promise<{ goal: ThreadGoal | null }>) => {
    setBusy(true);
    setError(null);

    try {
      apply(threadId, (await action()).goal);
      goalDialog.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : goalDialog.close())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="Target" className="size-4 text-muted-foreground" aria-hidden />
            {stoppedGoal ? goalLabel(goal) : "Goal for this chat"}
          </DialogTitle>
          <DialogDescription>
            {stoppedGoal
              ? "This goal is no longer being checked. Dismiss it, or resume it with the same or a new objective."
              : "After each turn, an independent judge checks whether this objective is met. If not, the chat keeps working on what is missing; once it is met, the goal clears itself. Editing or cancelling never interrupts the current turn."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Objective</span>
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="What has to be true when this chat is done"
              disabled={busy}
              autoFocus
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-muted-foreground">Checks used</span>
              <span className="tabular-nums text-foreground">
                {goal.iterations} of {goal.maxIterations}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label="Checks used"
              aria-valuemin={0}
              aria-valuemax={goal.maxIterations}
              aria-valuenow={goal.iterations}
              className="h-1.5 overflow-hidden rounded-full bg-state-active"
            >
              <div
                className="h-full origin-left rounded-full bg-foreground transition-transform duration-(--motion-duration-slow) ease-(--motion-ease-smooth) motion-reduce:transition-none"
                style={{
                  transform: `scaleX(${Math.min(1, goal.iterations / Math.max(1, goal.maxIterations))})`,
                }}
              />
            </div>
          </div>
          {goal.lastVerdict !== null ? (
            <div className="rounded-lg border border-border bg-surface-recessed px-3 py-2.5">
              <p className="text-xs font-medium text-muted-foreground">Judge's last verdict</p>
              <p className="mt-1 text-sm leading-relaxed text-foreground">{goal.lastVerdict}</p>
            </div>
          ) : null}
          {error !== null ? (
            <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive-text">
              <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
          <Button
            variant="ghost"
            className="text-destructive-text hover:bg-destructive/10 hover:text-destructive-text"
            disabled={busy}
            onClick={() => run(() => rpc.call("pursue_clear_goal", { threadId }))}
          >
            {stoppedGoal ? "Dismiss" : "Cancel goal"}
          </Button>
          <Button
            disabled={
              busy ||
              draft.trim() === "" ||
              // A stopped goal resumes on the same objective, so an
              // unchanged draft is still a real action there.
              (draft === goal.objective && !stoppedGoal)
            }
            onClick={() =>
              run(() => rpc.call("pursue_edit_goal", { threadId, objective: draft.trim() }))
            }
          >
            {stoppedGoal ? "Resume" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GoalDialog({ threadId }: { threadId: string }) {
  const { goals, failed, apply } = useGoalStates([threadId]);
  const goal = goals.get(threadId);
  const loadFailed = failed.has(threadId);

  React.useEffect(() => {
    if (goal === null || loadFailed) goalDialog.close();
  }, [goal, loadFailed]);

  if (goal === undefined || goal === null) return null;

  return <GoalDialogContent threadId={threadId} goal={goal} apply={apply} />;
}

function GoalDialogHost() {
  const threadId = React.useSyncExternalStore(
    goalDialog.subscribe,
    goalDialog.getSnapshot,
    goalDialog.getSnapshot,
  );

  return threadId === null ? null : <GoalDialog key={threadId} threadId={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "plan-execution",
    title: "Plan execution defaults",
    component: PlanSettings,
  });
  app.composer.customize({
    id: "plan-runs",
    scopes: ["thread"],
    banners: [
      {
        id: "plan-runs",
        chrome: "bare",
        experimental_placement: "adjacent-to-composer",
        component: PlanRunBar,
      },
    ],
  });
  app.slots.experimental_threadHeaderAction({
    id: "pursue",
    title: "Goals",
    component: PursueHeaderAction,
  });
  app.slots.experimental_appOverlay({
    id: "goal-dialog",
    component: GoalDialogHost,
  });
  app.slots.experimental_threadAction({
    id: "goal",
    title: "Goal",
    icon: "Target",
    group: experimental_THREAD_ACTION_GROUPS.settings,
    useData: ({ threadIds }) => useGoalStates(threadIds).goals,
    item: ({ thread, data }) =>
      goalThreadAction(data.get(thread.id), () => goalDialog.open(thread.id)),
  });
});
