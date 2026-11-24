import {
  type ChildThreadActivityState,
  type Thread,
  childThreadOutcomeSchema,
  threadEventTurnStatusSchema,
  type PromptInput,
  type SystemMessageSubject,
  type ThreadEventTurnStatus,
  type ThreadQuestionInput,
  type ChildThreadOutcome,
} from "@omnyo/domain";
import {
  getThread,
  listActiveBackgroundTaskCountsByThreadIds,
} from "@omnyo/db";
import { renderTemplate } from "@omnyo/templates";
import { z } from "zod";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requestQueuedMessageDispatchAt } from "./queued-message-dispatch.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { postCoalescedSystemNotice } from "./coalesced-system-notices.js";
import {
  buildParentSystemInputFromTemplateSlot,
  buildParentSystemThreadMention,
  parentSystemThreadLabel,
  queueParentSystemMessage,
  type ParentSystemInputSegment,
  type ParentSystemMessageTaxonomy,
  type ParentSystemRenderedMention,
  type ParentSystemThreadMentionSource,
} from "./parent-system-messages.js";
import {
  childOutcomeSystemMessageKind,
  systemMessageKindForTemplate,
} from "./system-message-kind.js";
import { getLastThreadOutput } from "./thread-data.js";
import { recordQuietParentChildActivity } from "./quiet-parent.js";
import { resolveChildOutcomeOwner } from "./thread-parent.js";
import { inboxRootOf } from "../inbox/family.js";
import { dispatchWake, storeChildCompletion } from "../inbox/waits.js";

export type ChildThreadNotificationSource = ParentSystemThreadMentionSource;

const childThreadTurnNotificationBatchItemSchema = z.object({
  activeWorkflowCount: z.number().int().nonnegative(),
  childThread: z.object({
    id: z.string(),
    projectId: z.string(),
    title: z.string().nullable(),
  }),
  terminalOutput: z.string().nullable(),
  turnStatus: threadEventTurnStatusSchema,
  failureContext: z.string().optional(),
  interruption: childThreadOutcomeSchema.shape.interruption,
});

const childThreadTurnNotificationBatchSchema = z.array(
  childThreadTurnNotificationBatchItemSchema,
);

export type ChildThreadTurnNotificationBatchItem = z.infer<
  typeof childThreadTurnNotificationBatchItemSchema
>;

interface ChildThreadTurnStatusBatchLine {
  item: ChildThreadTurnNotificationBatchItem;
  mention: ParentSystemRenderedMention;
}

interface RenderChildThreadTurnStatusBatchTextArgs {
  lines: ChildThreadTurnStatusBatchLine[];
}

interface FormatChildThreadTurnStatusLineArgs {
  line: ChildThreadTurnStatusBatchLine;
}

interface BuildChildThreadTurnStatusBatchInputArgs {
  items: ChildThreadTurnNotificationBatchItem[];
}

interface BuildChildThreadNeedsAttentionInputArgs {
  blockerSummary: string | null;
  childThread: ChildThreadNotificationSource;
}

interface QueueChildThreadTurnNotificationArgs {
  childThread: ChildThreadNotificationSource;
  parentThreadId: string;
  turnStatus: ThreadEventTurnStatus;
  failureContext?: string;
  interruption?: ChildThreadOutcome["interruption"];
}

interface QueueChildThreadNeedsAttentionNotificationArgs {
  blockerSummary: string | null;
  childThread: ChildThreadNotificationSource;
  parentThreadId: string;
}

export interface ChildThreadQuestion {
  allowFreeText: boolean;
  context: string | null;
  delegable: boolean;
  mode: ThreadQuestionInput["mode"];
  multiSelect: boolean;
  options: readonly {
    description: string | null;
    label: string;
    preview: string | null;
    recommended: boolean;
  }[];
  prompt: string;
}

interface BuildChildThreadQuestionInputArgs {
  childThread: ChildThreadNotificationSource;
  questions: readonly ChildThreadQuestion[];
}

interface QueueChildThreadQuestionArgs extends BuildChildThreadQuestionInputArgs {
  parentThreadId: string;
}

const CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS = 2_000;

const CHILD_THREAD_TURN_NOTIFICATION_COALESCE_KEY = "child-outcomes";

const CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT =
  "__OMNYO_CHILD_THREAD_OUTCOME_BATCH_UPDATES__";

const CHILD_THREAD_MENTION_SLOT = "__OMNYO_CHILD_THREAD_MENTION__";

const CHILD_THREAD_QUESTIONS_SLOT = "__OMNYO_CHILD_THREAD_QUESTIONS__";

const CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT = 4_000;

const CHILD_THREAD_OUTPUT_TRUNCATION_MARKER = "\n\n[... output truncated ...]";

const CHILD_THREAD_INSPECTION_GUIDANCE =
  "Review the thread before deciding next steps.";

const CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY =
  "It is blocked on a pending interaction.";

const CHILD_THREAD_RUNNING_WORKFLOW_GUIDANCE =
  "A workflow it started is still running, so this output is not its final result. The thread will report again when the workflow finishes.";

const CHILD_THREAD_BATCH_RUNNING_WORKFLOW_GUIDANCE =
  "Threads with a workflow still running have not finished; they will report again when their workflow does.";

function childThreadTurnStatusLabel(
  item: ChildThreadTurnNotificationBatchItem,
): string {
  if (item.failureContext) return item.failureContext;
  const { turnStatus } = item;

  switch (turnStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return `was interrupted${childThreadInterruptionCauseText(item.interruption)}`;
    default: {
      const exhaustiveCheck: never = turnStatus;

      return exhaustiveCheck;
    }
  }
}

function childThreadInterruptionCauseText(
  interruption: ChildThreadOutcome["interruption"],
): string {
  if (!interruption) return "";

  if (interruption.cause === "host-connection-lost")
    return " because its host connection was lost";

  switch (interruption.reason) {
    case "host-daemon-restarted":
      return " because its host daemon restarted";
    case "host-removed":
      return " because its host was removed";
    case "provider-turn-idle":
      return " because its provider turn went idle";
    case "app-update":
      return " for an Omnyo update";
    case "manual-stop":
      return "";
  }
}

function truncateChildThreadOutput(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const retainedLength = Math.max(
    0,
    limit - CHILD_THREAD_OUTPUT_TRUNCATION_MARKER.length,
  );

  if (retainedLength === 0) {
    return CHILD_THREAD_OUTPUT_TRUNCATION_MARKER.trimStart();
  }

  return `${text.slice(0, retainedLength).trimEnd()}${CHILD_THREAD_OUTPUT_TRUNCATION_MARKER}`;
}

function formatChildThreadCompletionOutputExcerpt(
  output: string | null,
): string {
  const trimmedOutput = output?.trim();

  if (!trimmedOutput) {
    return "No final output was recorded.";
  }

  return truncateChildThreadOutput(
    trimmedOutput,
    CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT,
  );
}

function formatChildThreadNeedsAttentionSummary(
  summary: string | null,
): string {
  const trimmedSummary = summary?.trim();

  if (!trimmedSummary) {
    return CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY;
  }

  return trimmedSummary;
}

function formatChildThreadRunningWorkflowClause(count: number): string {
  if (count < 1) {
    return "";
  }

  return count === 1
    ? ", with 1 workflow still running"
    : `, with ${count} workflows still running`;
}

function buildSingleChildThreadTurnStatusSegments(
  args: FormatChildThreadTurnStatusLineArgs,
): ParentSystemInputSegment[] {
  const { line } = args;

  switch (line.item.turnStatus) {
    case "completed": {
      const workflowClause = formatChildThreadRunningWorkflowClause(
        line.item.activeWorkflowCount,
      );

      const workflowGuidance =
        workflowClause === ""
          ? ""
          : `\n\n${CHILD_THREAD_RUNNING_WORKFLOW_GUIDANCE}`;

      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` completed${workflowClause}:\n\n${formatChildThreadCompletionOutputExcerpt(line.item.terminalOutput)}${workflowGuidance}`,
        },
      ];
    }

    case "failed":
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` ${line.item.failureContext ?? "failed"}.\n\n${CHILD_THREAD_INSPECTION_GUIDANCE}`,
        },
      ];
    case "interrupted":
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` ${childThreadTurnStatusLabel(line.item)}.\n\n${CHILD_THREAD_INSPECTION_GUIDANCE}`,
        },
      ];
    default: {
      const exhaustiveCheck: never = line.item.turnStatus;

      return exhaustiveCheck;
    }
  }
}

function buildChildThreadBatchStatusLineSegments(
  args: FormatChildThreadTurnStatusLineArgs,
): ParentSystemInputSegment[] {
  const { line } = args;

  const workflowClause = formatChildThreadRunningWorkflowClause(
    line.item.activeWorkflowCount,
  );

  return [
    { kind: "mention", mention: line.mention },
    {
      kind: "text",
      text: ` ${childThreadTurnStatusLabel(line.item)}${workflowClause}.`,
    },
  ];
}

function getChildThreadCompletionOutput(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): string | null {
  if (args.turnStatus !== "completed") {
    return null;
  }

  return getLastThreadOutput(deps.db, args.childThread.id);
}

function getChildThreadActiveWorkflowCount(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): number {
  const [activity] = listActiveBackgroundTaskCountsByThreadIds(deps.db, {
    threadIds: [args.childThread.id],
  });

  return activity?.activeWorkflowCount ?? 0;
}

function buildChildThreadTurnStatusBatchSegments(
  args: RenderChildThreadTurnStatusBatchTextArgs,
): ParentSystemInputSegment[] {
  if (args.lines.length === 1 && args.lines[0]) {
    return buildSingleChildThreadTurnStatusSegments({
      line: args.lines[0],
    });
  }

  const segments: ParentSystemInputSegment[] = [];
  segments.push({ kind: "text", text: "Child thread updates:" });
  args.lines.forEach((line, index) => {
    segments.push({ kind: "text", text: index === 0 ? "\n\n- " : "\n- " });
    segments.push(...buildChildThreadBatchStatusLineSegments({ line }));
  });

  if (args.lines.some((line) => line.item.activeWorkflowCount > 0)) {
    segments.push({
      kind: "text",
      text: `\n\n${CHILD_THREAD_BATCH_RUNNING_WORKFLOW_GUIDANCE}`,
    });
  }

  return segments;
}

function buildChildThreadTurnStatusBatchLines(
  args: BuildChildThreadTurnStatusBatchInputArgs,
): ChildThreadTurnStatusBatchLine[] {
  return args.items.map((item) => ({
    item,
    mention: buildParentSystemThreadMention({
      thread: item.childThread,
    }),
  }));
}

function childThreadSubject(
  thread: ChildThreadNotificationSource,
): SystemMessageSubject {
  return {
    kind: "thread",
    threadId: thread.id,
    threadName: parentSystemThreadLabel(thread),
  };
}

function childThreadTurnStatusBatchTaxonomy(
  items: ChildThreadTurnNotificationBatchItem[],
): ParentSystemMessageTaxonomy {
  const outcomes: ChildThreadOutcome[] = items.map((item) => ({
    threadId: item.childThread.id,
    status: item.turnStatus,
    ...(item.interruption ? { interruption: item.interruption } : {}),
  }));

  const single = items.length === 1 ? items[0] : undefined;

  if (single) {
    return {
      systemMessageKind: childOutcomeSystemMessageKind(single.turnStatus),
      systemMessageSubject: {
        kind: "thread",
        threadId: single.childThread.id,
        threadName: parentSystemThreadLabel(single.childThread),
        outcomes,
      },
    };
  }

  return {
    systemMessageKind: "child-outcome-batch",
    systemMessageSubject: {
      kind: "thread-batch",
      count: items.length,
      outcomes,
    },
  };
}

export function buildChildThreadTurnStatusBatchInput(
  args: BuildChildThreadTurnStatusBatchInputArgs,
): PromptInput[] {
  const lines = buildChildThreadTurnStatusBatchLines(args);

  const renderedText = renderTemplate("systemMessageChildThreadOutcomeBatch", {
    updates: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
  });

  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
    segments: buildChildThreadTurnStatusBatchSegments({ lines }),
  });
}

export function buildChildThreadNeedsAttentionInput(
  args: BuildChildThreadNeedsAttentionInputArgs,
): PromptInput[] {
  const mention = buildParentSystemThreadMention({
    thread: args.childThread,
  });

  const renderedText = renderTemplate(
    "systemMessageChildThreadNeedsAttention",
    {
      blockerSummary: formatChildThreadNeedsAttentionSummary(
        args.blockerSummary,
      ),
      threadMention: CHILD_THREAD_MENTION_SLOT,
    },
  );

  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: CHILD_THREAD_MENTION_SLOT,
    segments: [{ kind: "mention", mention }],
  });
}

function formatChildThreadQuestion(question: ChildThreadQuestion): string {
  const lines = [
    `${question.mode === "required" ? "Required" : "Optional, the child continues with its stated default"}: ${question.prompt}`,
  ];

  if (question.context !== null && question.context.trim() !== "")
    lines.push(question.context.trim());

  for (const option of question.options) {
    lines.push(
      `- ${option.label}${option.recommended ? " (recommended)" : ""}${option.description === null || option.description.trim() === "" ? "" : `: ${option.description.trim()}`}`,
    );

    if (option.preview !== null && option.preview.trim() !== "")
      lines.push(
        option.preview
          .trim()
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
      );
  }

  if (question.multiSelect) lines.push("Several options may be chosen.");

  if (question.delegable)
    lines.push(
      "The child marked this question delegable: a reversible choice within its existing authority.",
    );

  if (!question.allowFreeText && question.options.length > 0)
    lines.push("Only the listed options are accepted.");

  return lines.join("\n");
}

export function buildChildThreadQuestionInput(
  args: BuildChildThreadQuestionInputArgs,
): PromptInput[] {
  const [only, ...others] = args.questions;

  const questionsText =
    only !== undefined && others.length === 0
      ? formatChildThreadQuestion(only)
      : args.questions
          .map(
            (question, index) =>
              `${index + 1}. ${formatChildThreadQuestion(question)}`,
          )
          .join("\n\n");

  const renderedText = renderTemplate("systemMessageChildThreadQuestion", {
    childThreadId: args.childThread.id,
    questions: CHILD_THREAD_QUESTIONS_SLOT,
    threadMention: CHILD_THREAD_MENTION_SLOT,
  });

  const [head, tail, ...extra] = renderedText.split(
    CHILD_THREAD_QUESTIONS_SLOT,
  );

  if (head === undefined || tail === undefined || extra.length > 0)
    throw new Error("Child question template must contain one question slot");

  const [input] = buildParentSystemInputFromTemplateSlot({
    renderedText: head,
    slot: CHILD_THREAD_MENTION_SLOT,
    segments: [
      {
        kind: "mention",
        mention: buildParentSystemThreadMention({ thread: args.childThread }),
      },
    ],
  });

  if (input === undefined || input.type !== "text")
    throw new Error("Child question message must start with text");

  return [{ ...input, text: `${input.text}${questionsText}${tail}` }];
}

export async function queueChildThreadQuestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadQuestionArgs,
): Promise<boolean> {
  return queueParentSystemMessage(deps, {
    input: buildChildThreadQuestionInput({
      childThread: args.childThread,
      questions: args.questions,
    }),
    parentThreadId: args.parentThreadId,
    systemMessageKind: systemMessageKindForTemplate(
      "systemMessageChildThreadQuestion",
    ),
    systemMessageSubject: childThreadSubject(args.childThread),
  });
}

function childThreadTurnNotificationLogMessage(
  turnStatus: ThreadEventTurnStatus,
): string {
  switch (turnStatus) {
    case "completed":
      return "Failed to queue parent completed-thread notification";
    case "failed":
      return "Failed to queue parent failed-thread notification";
    case "interrupted":
      return "Failed to queue parent interrupted-thread notification";
    default: {
      const exhaustiveCheck: never = turnStatus;

      return exhaustiveCheck;
    }
  }
}

function mergeChildThreadTurnNotificationItem(
  items: readonly ChildThreadTurnNotificationBatchItem[],
  item: ChildThreadTurnNotificationBatchItem,
): ChildThreadTurnNotificationBatchItem[] {
  const existingIndex = items.findIndex(
    (entry) =>
      entry.childThread.id === item.childThread.id &&
      entry.failureContext === item.failureContext,
  );

  if (existingIndex === -1) {
    return [...items, item];
  }

  const previous = items[existingIndex];

  const merged =
    item.turnStatus === "interrupted" &&
    !item.interruption &&
    previous?.turnStatus === "interrupted" &&
    previous.interruption
      ? { ...item, interruption: previous.interruption }
      : item;

  return items.map((entry, index) =>
    index === existingIndex ? merged : entry,
  );
}

async function queueChildThreadTurnNotificationBatchItem(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): Promise<void> {
  const parentThread = getThread(deps.db, args.parentThreadId);

  if (
    !parentThread ||
    parentThread.archivedAt !== null ||
    parentThread.deletedAt !== null
  ) {
    return;
  }

  const item: ChildThreadTurnNotificationBatchItem = {
    activeWorkflowCount: getChildThreadActiveWorkflowCount(deps, args),
    childThread: args.childThread,
    terminalOutput: getChildThreadCompletionOutput(deps, args),
    turnStatus: args.turnStatus,
    ...(args.failureContext ? { failureContext: args.failureContext } : {}),
    ...(args.interruption ? { interruption: args.interruption } : {}),
  };

  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: parentThread.id },
  );

  const row = postCoalescedSystemNotice<ChildThreadTurnNotificationBatchItem[]>(
    deps,
    {
      coalesceKey: CHILD_THREAD_TURN_NOTIFICATION_COALESCE_KEY,
      execution,
      merge: (previous) => {
        const items = mergeChildThreadTurnNotificationItem(
          previous ?? [],
          item,
        );

        const taxonomy = childThreadTurnStatusBatchTaxonomy(items);

        return {
          input: buildChildThreadTurnStatusBatchInput({ items }),
          notice: {
            kind: taxonomy.systemMessageKind,
            subject: taxonomy.systemMessageSubject,
          },
          state: items,
        };
      },
      parseState: (stored) =>
        childThreadTurnNotificationBatchSchema.parse(JSON.parse(stored)),
      threadId: parentThread.id,
      windowMs: CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS,
    },
  );

  requestQueuedMessageDispatchAt(deps, row.sendAt);
}

const QUIET_CHILD_OUTCOME_STATE: Record<
  ThreadEventTurnStatus,
  ChildThreadActivityState
> = {
  completed: "finished",
  failed: "failed",
  interrupted: "interrupted",
};

function recordQuietChildOutcome(
  deps: LoggedPendingInteractionWorkSessionDeps,
  owner: Pick<Thread, "id" | "environmentId">,
  args: QueueChildThreadTurnNotificationArgs,
): void {
  if (getChildThreadActiveWorkflowCount(deps, args) > 0) return;

  recordQuietParentChildActivity(deps, {
    parent: owner,
    child: { id: args.childThread.id, title: args.childThread.title },
    state: QUIET_CHILD_OUTCOME_STATE[args.turnStatus],
  });
}

async function deliverChildCompletionToWaits(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): Promise<boolean> {
  if (
    args.turnStatus !== "completed" ||
    getChildThreadActiveWorkflowCount(deps, args) > 0
  )
    return false;

  const now = Date.now();

  const delivered = storeChildCompletion(deps.db, {
    parentThreadId: args.parentThreadId,
    childThreadId: args.childThread.id,
    text:
      getChildThreadCompletionOutput(deps, args) ??
      "Finished without a closing message.",
    now,
  });

  if (!delivered.stored) return false;

  for (const waitId of delivered.readyWaitIds)
    await dispatchWake(deps, { waitId, phase: "resume", now });

  deps.hub.notifyThread(
    inboxRootOf(deps.db, args.parentThreadId)?.id ?? args.parentThreadId,
    ["work-changed"],
  );

  return true;
}

export async function queueChildThreadTurnNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): Promise<void> {
  try {
    const owner = resolveChildOutcomeOwner(
      deps,
      args.childThread.id,
      args.parentThreadId,
    );

    if (owner === null) return;

    if (owner.quiet) {
      recordQuietChildOutcome(deps, owner, args);

      return;
    }

    const delivery = { ...args, parentThreadId: owner.id };

    if (await deliverChildCompletionToWaits(deps, delivery)) return;

    await queueChildThreadTurnNotificationBatchItem(deps, delivery);
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        turnStatus: args.turnStatus,
        err: error,
      },
      childThreadTurnNotificationLogMessage(args.turnStatus),
    );
  }
}

export async function queueChildThreadNeedsAttentionNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadNeedsAttentionNotificationArgs,
): Promise<void> {
  try {
    const owner = resolveChildOutcomeOwner(
      deps,
      args.childThread.id,
      args.parentThreadId,
    );

    if (owner === null || owner.quiet) return;

    await queueParentSystemMessage(deps, {
      input: buildChildThreadNeedsAttentionInput({
        blockerSummary: args.blockerSummary,
        childThread: args.childThread,
      }),
      parentThreadId: owner.id,
      systemMessageKind: systemMessageKindForTemplate(
        "systemMessageChildThreadNeedsAttention",
      ),
      systemMessageSubject: childThreadSubject(args.childThread),
    });
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        err: error,
      },
      "Failed to queue parent needs-attention notification",
    );
  }
}
