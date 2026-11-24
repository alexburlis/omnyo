export { formatThreadTimelineText } from "./format-timeline-text.js";

export { parseAgentMessageEnvelope } from "./agent-message-envelope.js";

export {
  parseAutomationDueMessage,
  type AutomationDueMessage,
} from "./automation-due-message.js";

export {
  isHumanThreadInput,
  userMessageSourceLabel,
} from "./user-message-source.js";

export type { ThreadTimelineTextFormat } from "./format-timeline-text.js";

export { assertNever } from "./assert-never.js";

export { MissingProjectionTurnStartedError } from "./group-event-projection-turns.js";

export {
  directoryFromPath,
  fileNameFromPath,
} from "./timeline-path-display.js";

export {
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  findActiveLatestBundleId,
  findTimelineFrontierRow,
} from "./timeline-row-title.js";

export { hasTimelineExplorationIntent } from "./timeline-activity-intents.js";

export {
  activityIntentTitleGlyph,
  workRowGlyph,
  workRowPluginGlyph,
  workRowPresentation,
} from "./timeline-work-row-glyph.js";

export {
  capitalize,
  durationToCompactString,
  formatDiffCount,
  formatDiffStatsText,
  plural,
} from "./format-helpers.js";

export {
  formatGitActivityRemoteLabel,
  formatGitRefLabel,
  formatGitRemoteLabel,
  formatTurnGitActivitySentence,
  gitActivityCommitWebUrl,
  gitCommitWebUrl,
  shortGitSha,
  summarizeTurnGitActivity,
  type TurnGitActivityState,
  type TurnGitActivitySummary,
} from "./turn-git-activity.js";

export type {
  BuildTimelineRowTitleOptions,
  TimelineActivityIntentTitle,
  TimelineTitle,
  TimelineTitleAction,
  TimelineTitleDecoration,
  TimelineTitleLink,
  TimelineTitleSegment,
  TimelineTitleSegmentAccent,
  TimelineTitleTone,
} from "./timeline-row-title.js";

export { THREAD_TIMELINE_EXCLUDED_EVENT_TYPES } from "./timeline-noise-events.js";

export {
  extractShellCommandFromString,
  parseSentThreadMessage,
  type ThreadTellCommand,
} from "./tool-call-parsing.js";

export {
  getFileChangeAction,
  isPatchMetadataLine,
} from "./file-change-summary.js";

export type { FileChangeAction } from "./file-change-summary.js";

export {
  buildThreadTimelineFromEvents,
  buildThreadTimelineTurnDetailsFromEvents,
  createThreadTimelineProjectionCheckpoint,
  appendThreadTimelineProjectionCheckpoint,
  materializeThreadTimelineProjectionCheckpoint,
  type ThreadTimelineProjectionCheckpoint,
} from "./build-thread-timeline.js";

export { extractThreadTimelineActivePlanTurn } from "./active-prompt-mode-extraction.js";

export { extractThreadTimelineGoal } from "./goal-snapshot-extraction.js";

export {
  extractThreadProviderCommands,
  extractThreadSessionOptions,
} from "./provider-state-extraction.js";

export type { AcceptedClientRequestContext } from "./accepted-client-request-context.js";

export {
  buildTimelineViewRows,
  createTimelineViewRowsCache,
} from "./timeline-view.js";

export { APP_UPDATE_INTERRUPTION_TITLE } from "./parse-operation-message.js";

export {
  isChildActivityRow,
  isPreviewActivityRow,
  isTimelineActivityRow,
  previewActivityDisplayUrl,
  type TimelineActivitySystemRow,
} from "./timeline-activity.js";

export type {
  BuildTimelineViewRowsOptions,
  ThreadTimelineViewRow,
  TimelineQuestionViewWorkRow,
  TimelineViewDelegationWorkRow,
  TimelineViewTurnRow,
  TimelineViewWorkflowWorkRow,
  TimelineViewWorkRow,
  TimelineWorkSummaryChild,
} from "./timeline-view.js";

export {
  compactThreadTimelineSummaryEvents,
  MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION,
} from "./summary-event-compaction.js";

export type { ThreadEventWithMeta } from "./group-event-projection-turns.js";

export { extractThreadContextWindowUsage } from "./thread-context-window-usage.js";

export {
  isExternalUserBoundaryForTurn,
  type ExternalUserBoundaryMessage,
  type ExternalUserBoundaryTurnSpan,
} from "./external-user-boundaries.js";
