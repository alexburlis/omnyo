import {
  experimental_useAppNavigate,
  type ExperimentalThreadCompanionProps,
} from "@omnyo/plugin-sdk/app";
import { formatBytes, formatProcessCount } from "../lib/format";
import { PANEL_PATH } from "../lib/names";
import { Button } from "./ui/button";
import { FOCUS_RING_CLASS } from "./ui/focus-ring";
import { Icon } from "./ui/icon";
import { useLeftRunning, workloadRows } from "./use-left-running";

const OPTIONS = { refreshOnOpen: false, withHistory: false };

export function LeftRunningCompanion({ threadId, placement }: ExperimentalThreadCompanionProps) {
  const navigate = experimental_useAppNavigate();
  const { list } = useLeftRunning(threadId, OPTIONS);
  const leftovers = workloadRows(list).filter((row) => row.disposition.kind !== "in-use");
  const largest = leftovers[0];

  if (largest === undefined) return null;

  const memory = formatBytes(leftovers.reduce((total, row) => total + row.memoryBytes, 0));
  const open = () => navigate.toPluginPanel(PANEL_PATH, { subPath: threadId });

  if (placement === "toolbar")
    return (
      <Button variant="ghost" size="sm" className="h-7" onClick={open}>
        {`${memory} left running`}
      </Button>
    );

  return (
    <button
      type="button"
      className={`group/left flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-state-hover ${FOCUS_RING_CLASS}`}
      onClick={open}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-state-hover text-muted-foreground">
        <Icon name="Terminal" aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{`${formatProcessCount(leftovers.length)} left running`}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{`${memory} · ${largest.nextStep === "Busy" ? "Still working" : largest.nextStep}`}</span>
      </span>
      <Icon
        name="ChevronRight"
        aria-hidden="true"
        className="size-4 shrink-0 text-subtle-foreground group-hover/left:text-muted-foreground"
      />
    </button>
  );
}
