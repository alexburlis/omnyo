import type { PluginThreadAction } from "@omnyo/plugin-sdk/app";
import type { Action, Run } from "./contract";
import type { Snapshot } from "./state";

export type ThreadActionData = {
  projectId: string | null;
  snapshot: Snapshot;
  confirmingStop: string | null;
  armStop(id: string): void;
  execute(projectId: string, id: string): Promise<Run>;
  stop(projectId: string, id: string): Promise<void>;
};

const STOP_PREFIX = "stop:";

const CONFIRM_STOP_PREFIX = "confirm-stop:";

const isBusy = (run: Run | undefined) => run?.status === "running" || run?.status === "stopping";

function suffixFor(action: Action, snapshot: Snapshot) {
  const run = snapshot.runs.find((item) => item.id === action.id);

  if (run?.status === "stopping") return "Quitting";

  if (run?.status === "running") return run.activity?.text || "Running";

  if (run?.status === "failed") return "Failed";

  return snapshot.states.find((item) => item.id === action.id && item.tone !== "unknown")?.text;
}

function summaryFor(snapshot: Snapshot) {
  const running = snapshot.runs.filter(isBusy).length;

  if (running > 0) return `${running} running`;

  if (snapshot.runs.some((run) => run.status === "failed")) return "Last run failed";

  return snapshot.actions.length === 1 ? "1 action" : `${snapshot.actions.length} actions`;
}

export function projectActionsThreadAction(input: {
  thread: { projectId: string };
  data: ThreadActionData;
  openUrl(url: string): boolean;
  notifyError(message: string): void;
}): PluginThreadAction | null {
  const { thread, data, openUrl, notifyError } = input;
  const { snapshot, projectId } = data;

  if (projectId === null || thread.projectId !== projectId || snapshot.actions.length === 0) {
    return null;
  }

  const items = snapshot.actions.flatMap((action) => {
    const run = snapshot.runs.find((item) => item.id === action.id);
    const suffix = suffixFor(action, snapshot);

    const choice = {
      id: action.id,
      label: suffix ? `${action.label} · ${suffix}` : action.label,
      disabled: isBusy(run),
    };

    if (action.kind !== "command" || run?.status !== "running") return [choice];

    const armed = data.confirmingStop === action.id;

    return [
      choice,
      armed
        ? { id: `${CONFIRM_STOP_PREFIX}${action.id}`, label: `Confirm force quit ${action.label}` }
        : { id: `${STOP_PREFIX}${action.id}`, label: `Force quit ${action.label}` },
    ];
  });

  return {
    label: "Project actions",
    detail: summaryFor(snapshot),
    icon: "Zap",
    choices: { items },
    async run({ value }) {
      if (value === undefined) return;

      if (value.startsWith(CONFIRM_STOP_PREFIX)) {
        const id = value.slice(CONFIRM_STOP_PREFIX.length);

        if (data.confirmingStop !== id) return;

        try {
          await data.stop(projectId, id);
        } catch {
          notifyError(
            `Could not force quit ${snapshot.actions.find((item) => item.id === id)?.label ?? id}.`,
          );
        }

        return;
      }

      if (value.startsWith(STOP_PREFIX)) {
        data.armStop(value.slice(STOP_PREFIX.length));

        return;
      }

      const action = snapshot.actions.find((item) => item.id === value);

      if (action === undefined) return;

      try {
        const result = await data.execute(projectId, action.id);

        if (result.status === "failed") notifyError(`${action.label}: ${result.detail}`);
        else if (result.url && !openUrl(result.url)) notifyError("Omnyo could not open the URL.");
      } catch {
        notifyError(`Could not run ${action.label}.`);
      }
    },
  };
}
