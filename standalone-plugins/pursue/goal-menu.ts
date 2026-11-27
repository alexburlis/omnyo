import type { PluginThreadAction } from "@omnyo/plugin-sdk/app";

export type ThreadGoal = {
  objective: string;
  iterations: number;
  maxIterations: number;
  status: "active" | "complete" | "stopped";
  lastVerdict: string | null;
};

const DETAIL_LIMIT = 80;

export function goalLabel(goal: ThreadGoal) {
  if (goal.status === "active") return `Goal ${goal.iterations}/${goal.maxIterations}`;

  return goal.status === "complete" ? "Goal met" : "Goal stopped";
}

export function goalDetail(goal: ThreadGoal) {
  const objective = goal.objective.replace(/\s+/g, " ").trim();

  return objective.length > DETAIL_LIMIT ? `${objective.slice(0, DETAIL_LIMIT - 1)}…` : objective;
}

export function goalThreadAction(
  goal: ThreadGoal | null | undefined,
  open: () => void,
): PluginThreadAction | null {
  if (goal === null || goal === undefined) return null;

  return {
    label: goalLabel(goal),
    detail: goalDetail(goal),
    icon: "Target",
    run: open,
  };
}

export type GoalDialogStore = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): string | null;
  open(threadId: string): void;
  close(): void;
};

export function createGoalDialogStore(): GoalDialogStore {
  let threadId: string | null = null;
  const listeners = new Set<() => void>();

  const set = (next: string | null) => {
    if (next === threadId) return;
    threadId = next;

    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => threadId,
    open: (id) => set(id),
    close: () => set(null),
  };
}
