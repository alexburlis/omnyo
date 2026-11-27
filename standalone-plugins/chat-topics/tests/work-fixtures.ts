import type { GroupThread, WorkSummary } from "../lib/grouping.ts";

export function work(
  label: WorkSummary["primary"]["label"],
  change: Partial<WorkSummary> = {},
): WorkSummary {
  return {
    basis: "current-basis",
    revision: "current-revision",
    primary: { label, reason: { code: "fixture", text: `Recorded ${label} reason` } },
    activity: [],
    requiredInput: [],
    optionalInput: [],
    failures: [],
    waits: [],
    nextActors: [],
    assessment: {
      availability: "available",
      reason: "Recorded assessment",
      ask: null,
      recap: null,
      sourceSeq: 10,
      suggestion: "omitted",
      noSuggestionReason: "No reply is needed.",
      waitingOn: label === "external" ? "App Store review" : null,
    },
    postponement: null,
    archive: {
      eligible: label === "ready-to-archive",
      recommended: label === "ready-to-archive",
      reason: "Recorded archive reason",
    },
    ...change,
  };
}

export function chat(
  id: string,
  label: WorkSummary["primary"]["label"] = "open",
  change: Partial<GroupThread> = {},
): GroupThread {
  return {
    id,
    projectId: "omnyo",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    displayTitle: id,
    originPluginId: null,
    createdAt: 1_000_000,
    latestAttentionAt: change.createdAt ?? 1_000_000,
    lastMessageAt: null,
    isUnread: false,
    isPinned: false,
    isHidden: false,
    isArchived: false,
    shelvedAt: null,
    shelfSortKey: null,
    groupId: null,
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    indicator: null,
    hasPendingInteraction: false,
    activity: {},
    work: work(label),
    ...change,
  };
}
