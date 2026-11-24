import { experimental_threadIndicators } from "@omnyo/plugin-sdk/app";
import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
  PluginSidebarThreadRowStatus,
} from "@omnyo/plugin-sdk/app";

type WorkSummary = NonNullable<PluginSidebarThread["experimental_work"]>;

export type ThreadListIndicatorState = Parameters<
  typeof experimental_threadIndicators.resolve
>[0];

export type ThreadListIndicatorKind = PluginSidebarThreadIndicator;

export function resolveThreadListIndicator(
  state: ThreadListIndicatorState,
): ThreadListIndicatorKind {
  if (
    state.work?.primary.label !== "needs-you" &&
    (state.work?.optionalInput.length ?? 0) > 0
  )
    return "input-welcome";

  return experimental_threadIndicators.resolve(state);
}

export function getThreadListIndicatorLabel(
  kind: ThreadListIndicatorKind,
): string | null {
  return kind === "input-welcome"
    ? "Open decision; the agent can continue"
    : experimental_threadIndicators.label(kind);
}

export const hasThreadListWorkingActivity =
  experimental_threadIndicators.working;

export function strongestThreadWorkSummary(
  summaries: readonly (WorkSummary | null | undefined)[],
): WorkSummary | null {
  const strongest = experimental_threadIndicators.strongest(summaries);

  const optionalInput = new Map(
    summaries.flatMap((summary) =>
      (summary?.optionalInput ?? []).map((input) => [input.id, input] as const),
    ),
  );

  if (optionalInput.size === 0) return strongest;

  const selected = strongest ?? summaries.find((summary) => summary != null);

  if (selected === null || selected === undefined) return null;

  const activity = new Map(
    summaries.flatMap((summary) =>
      (summary?.activity ?? []).map((entry) => [entry.id, entry] as const),
    ),
  );

  return {
    ...selected,
    optionalInput: [...optionalInput.values()],
    activity: [...activity.values()],
  };
}

interface ThreadStatusResolution {
  accessibleLabel: string | null;
  indicatorKind: ThreadListIndicatorKind;
  rowStatusIsVisible: boolean;
  rowStatus: PluginSidebarThreadRowStatus | null;
}

export const STOPPING_ROW_STATUS: PluginSidebarThreadRowStatus = {
  icon: "Square",
  label: "Stopping",
  tone: "default",
};

export function resolveThreadStatus(
  state: ThreadListIndicatorState,
  rowStatus: PluginSidebarThreadRowStatus | null,
  stopping = false,
): ThreadStatusResolution {
  if (stopping && hasThreadListWorkingActivity(state))
    return {
      accessibleLabel: STOPPING_ROW_STATUS.label,
      indicatorKind: "none",
      rowStatusIsVisible: true,
      rowStatus: STOPPING_ROW_STATUS,
    };

  const indicatorKind = resolveThreadListIndicator(state);

  const rowStatusIsVisible =
    rowStatus !== null &&
    (indicatorKind === "open" ||
      indicatorKind === "none" ||
      indicatorKind === "draft");

  return {
    accessibleLabel: rowStatusIsVisible
      ? rowStatus.label
      : indicatorKind === "input-welcome"
        ? hasThreadListWorkingActivity(state)
          ? "Open decision; work is running"
          : getThreadListIndicatorLabel(indicatorKind)
        : (state.work?.primary.reason.text ?? "Work status unavailable."),
    indicatorKind,
    rowStatusIsVisible,
    rowStatus: rowStatusIsVisible ? rowStatus : null,
  };
}

export function threadListIndicatorStateForThread(
  thread: Pick<PluginSidebarThread, "experimental_work">,
  hasUnsubmittedDraft: boolean,
): ThreadListIndicatorState {
  return { work: thread.experimental_work ?? null, hasUnsubmittedDraft };
}

export interface CollapsedChildActivity {
  threadIds: readonly string[];
  work: WorkSummary | null;
  parentRowWork: readonly (WorkSummary | null)[];
  summaries: readonly WorkSummary[];
  unread: boolean;
  unreadError: boolean;
}

export const NO_COLLAPSED_CHILD_ACTIVITY: CollapsedChildActivity = {
  threadIds: [],
  work: null,
  parentRowWork: [],
  summaries: [],
  unread: false,
  unreadError: false,
};

export function getCollapsedChildActivity(
  threads: readonly Pick<
    PluginSidebarThread,
    "id" | "status" | "parentThreadId" | "isUnread" | "experimental_work"
  >[],
): CollapsedChildActivity {
  const summaries = threads.flatMap((thread) =>
    thread.experimental_work === null || thread.experimental_work === undefined
      ? []
      : [thread.experimental_work],
  );

  return {
    threadIds: threads.map((thread) => thread.id),
    work: strongestThreadWorkSummary(
      threads.map((thread) => thread.experimental_work),
    ),
    parentRowWork: threads.flatMap((thread) =>
      parentRowChildWork(thread.experimental_work ?? null),
    ),
    summaries,
    unread: threads.some(
      (thread) => isUnreadThread(thread) && thread.status !== "error",
    ),
    unreadError: threads.some(
      (thread) => isUnreadThread(thread) && thread.status === "error",
    ),
  };
}

function parentRowChildWork(work: WorkSummary | null): (WorkSummary | null)[] {
  if (work === null) return [null];

  if (work.primary.label === "needs-you") return [];

  return [
    work.optionalInput.length === 0 ? work : { ...work, optionalInput: [] },
  ];
}

export function isUnreadThread(
  thread: Pick<PluginSidebarThread, "isUnread" | "experimental_work">,
): boolean {
  return (
    thread.isUnread &&
    !hasThreadListWorkingActivity(
      threadListIndicatorStateForThread(thread, false),
    )
  );
}
