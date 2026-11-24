import type { ThreadEvent } from "@omnyo/domain";
import type {
  EventProjectionMessage,
  EventProjection,
  EventProjectionEntry,
  EventProjectionTurn,
  EventProjectionTurnStatus,
} from "./event-projection-types.js";
import {
  getThreadEventScopeTurnId,
  requireThreadEventScopeTurnId,
} from "@omnyo/domain";
import { assertNever } from "./assert-never.js";
import { normalizeTurnGitActivity } from "./turn-git-activity.js";
import type { EventMeta } from "./event-decode.js";
import {
  assertTerminalMessageIncludedInMessages,
  getProjectionSummaryCount,
} from "./apply-turn-message-detail.js";
import { findLastTerminalTimelineMessage } from "./timeline-message-helpers.js";
import { isExternalUserBoundaryForTurn } from "./external-user-boundaries.js";
import { isHumanThreadInput } from "./user-message-source.js";

export interface ThreadEventWithMeta {
  event: ThreadEvent;
  meta: EventMeta;
}

type TurnCompletedEvent = Extract<ThreadEvent, { type: "turn/completed" }>;

type TurnStartedEvent = Extract<ThreadEvent, { type: "turn/started" }>;

interface ProjectionTurnDraft {
  completionSequence: number | null;
  messages: EventProjectionMessage[];
  startedSequence: number;
  turn: EventProjectionTurn;
}

interface ProjectionTurnBoundsUpdate {
  createdAt: number;
  sourceSeqEnd: number;
  sourceSeqStart: number;
  threadId: string;
}

interface GroupEventProjectionTurnsArgs {
  delegatedTurnIds: ReadonlySet<string>;
  events: ThreadEventWithMeta[];
  messages: EventProjectionMessage[];
}

export interface TimelineProjectionDiagnostic {
  operation: "timeline-read";
  stage: "execute";
  failureClass: "internal";
  outcome: "terminal";
  reason: "missing-turn-start";
  source: "turn/completed" | "turn/input/accepted" | "message";
  projectionEventCount: number;
  projectionMessageCount: number;
  projectionStartSequence: number;
  projectionEndSequence: number;
  failureSequence: number;
  turnEventCount: number;
  turnStartCount: number;
  eventsOrdered: boolean;
  storedStart:
    | "unknown"
    | "missing"
    | "before-window"
    | "in-window"
    | "after-failure";
  storedStartSequence?: number;
}

export class MissingProjectionTurnStartedError extends Error {
  readonly diagnostic: TimelineProjectionDiagnostic;

  constructor(
    readonly threadId: string,
    readonly turnId: string,
    source: TimelineProjectionDiagnostic["source"],
    failureSequence: number,
    args: GroupEventProjectionTurnsArgs,
  ) {
    super("Timeline projection is missing turn/started");
    let projectionStartSequence = failureSequence;
    let projectionEndSequence = failureSequence;
    let turnEventCount = 0;
    let turnStartCount = 0;
    let previousSequence = 0;
    let eventsOrdered = true;

    for (const { event, meta } of args.events) {
      projectionStartSequence = Math.min(projectionStartSequence, meta.seq);
      projectionEndSequence = Math.max(projectionEndSequence, meta.seq);

      if (meta.seq < previousSequence) eventsOrdered = false;
      previousSequence = meta.seq;

      if (getThreadEventScopeTurnId(event.scope) !== turnId) continue;
      turnEventCount += 1;

      if (event.type === "turn/started") turnStartCount += 1;
    }

    this.diagnostic = {
      operation: "timeline-read",
      stage: "execute",
      failureClass: "internal",
      outcome: "terminal",
      reason: "missing-turn-start",
      source,
      projectionEventCount: args.events.length,
      projectionMessageCount: args.messages.length,
      projectionStartSequence,
      projectionEndSequence,
      failureSequence,
      turnEventCount,
      turnStartCount,
      eventsOrdered,
      storedStart: "unknown",
    };
  }
}

interface TurnEntryDraft {
  kind: "turn";
  createdAt: number;
  sourceSeqStart: number;
  turnId: string;
}

interface StandaloneMessageEntryDraft {
  kind: "projected-message";
  createdAt: number;
  message: EventProjectionMessage;
  sourceSeqStart: number;
}

type ProjectionEntryDraft = TurnEntryDraft | StandaloneMessageEntryDraft;

export function getOrderedThreadEvents(
  events: readonly ThreadEventWithMeta[],
): ThreadEventWithMeta[] {
  let areEventsOrdered = true;

  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].meta.seq > events[index].meta.seq) {
      areEventsOrdered = false;
      break;
    }
  }

  return areEventsOrdered
    ? Array.from(events)
    : Array.from(events).sort((a, b) => a.meta.seq - b.meta.seq);
}

function toEventProjectionTurnStatus(
  status: TurnCompletedEvent["status"],
): EventProjectionTurnStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
      return "interrupted";
    default:
      return assertNever(status);
  }
}

function createProjectionTurn(
  event: TurnStartedEvent,
  meta: EventMeta,
): ProjectionTurnDraft {
  const turnId = requireThreadEventScopeTurnId({
    type: event.type,
    scope: event.scope,
  });

  return {
    completionSequence: null,
    messages: [],
    startedSequence: meta.seq,
    turn: {
      turnId,
      threadId: event.threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      startedAt: meta.createdAt,
      createdAt: meta.createdAt,
      completedAt: null,
      status: "pending",
      summaryCount: 0,
      gitActivity: null,
    },
  };
}

function updateProjectionTurnBounds(
  draft: ProjectionTurnDraft,
  update: ProjectionTurnBoundsUpdate,
): void {
  draft.turn.threadId = update.threadId;
  draft.turn.sourceSeqStart = Math.min(
    draft.turn.sourceSeqStart,
    update.sourceSeqStart,
  );
  draft.turn.sourceSeqEnd = Math.max(
    draft.turn.sourceSeqEnd,
    update.sourceSeqEnd,
  );
  draft.turn.createdAt = Math.max(draft.turn.createdAt, update.createdAt);
}

function updateProjectionTurnCompletion(
  draft: ProjectionTurnDraft,
  event: TurnCompletedEvent,
  meta: EventMeta,
): void {
  updateProjectionTurnBounds(draft, {
    threadId: event.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
  });
  draft.turn.completedAt = meta.createdAt;
  draft.turn.status = toEventProjectionTurnStatus(event.status);
  draft.completionSequence ??= meta.seq;
}

function addProjectionTurnMessage(
  draft: ProjectionTurnDraft,
  message: EventProjectionMessage,
): void {
  draft.messages.push(message);
  updateProjectionTurnBounds(draft, {
    threadId: message.threadId,
    sourceSeqStart: message.sourceSeqStart,
    sourceSeqEnd: message.sourceSeqEnd,
    createdAt: message.createdAt,
  });
}

function canGroupThreadMessageInTurn(message: EventProjectionMessage): boolean {
  switch (message.kind) {
    case "operation":
      return message.opType === "warning" || message.opType === "deprecation";
    case "permission-grant-lifecycle":
    case "plugin-form-lifecycle":
    case "user-question-lifecycle":
      return true;
    default:
      return false;
  }
}

function findRootTurnRunningAtSequence(
  turnsById: ReadonlyMap<string, ProjectionTurnDraft>,
  delegatedTurnIds: ReadonlySet<string>,
  sequence: number,
): ProjectionTurnDraft | null {
  let running: ProjectionTurnDraft | null = null;

  for (const [turnId, draft] of turnsById) {
    if (delegatedTurnIds.has(turnId) || draft.startedSequence >= sequence) {
      continue;
    }

    if (
      draft.completionSequence !== null &&
      draft.completionSequence < sequence
    ) {
      continue;
    }

    if (running === null || draft.startedSequence > running.startedSequence) {
      running = draft;
    }
  }

  return running;
}

function applyExternalUserBoundaries(
  turnsById: Map<string, ProjectionTurnDraft>,
  messages: EventProjectionMessage[],
): void {
  const userMessages = messages.flatMap((message) =>
    message.kind === "user" && isHumanThreadInput(message)
      ? [
          {
            sequence: message.sourceSeqStart,
            turnId: message.scope.kind === "turn" ? message.scope.turnId : null,
          },
        ]
      : [],
  );

  for (const [turnId, draft] of turnsById) {
    const span = {
      completionSequence: draft.completionSequence,
      sequenceStart: draft.turn.sourceSeqStart,
      turnId,
    };

    const boundarySeqs = new Set<number>();

    for (const message of userMessages) {
      if (isExternalUserBoundaryForTurn(span, message)) {
        boundarySeqs.add(message.sequence);
      }
    }

    if (boundarySeqs.size > 0) {
      draft.turn.externalUserBoundarySeqs = [...boundarySeqs].sort(
        (left, right) => left - right,
      );
    }
  }
}

function createEventProjectionEntry(
  draft: ProjectionEntryDraft,
  turnsById: Map<string, ProjectionTurnDraft>,
): EventProjectionEntry {
  if (draft.kind === "projected-message") {
    return {
      kind: "projected-message",
      message: draft.message,
    };
  }

  const turnDraft = turnsById.get(draft.turnId);

  if (!turnDraft) {
    throw new Error(
      `Cannot build timeline projection for missing turn ${draft.turnId}`,
    );
  }

  const terminalMessage = findLastTerminalTimelineMessage(turnDraft.messages);

  const turn: EventProjectionTurn = {
    ...turnDraft.turn,
    summaryCount: getProjectionSummaryCount(
      turnDraft.messages,
      terminalMessage,
    ),
    messages: turnDraft.messages,
  };

  if (terminalMessage) {
    turn.terminalMessage = terminalMessage;
  }

  assertTerminalMessageIncludedInMessages(turn);

  return {
    kind: "turn",
    turn,
  };
}

export function groupEventProjectionTurns(
  args: GroupEventProjectionTurnsArgs,
): EventProjection {
  const turnsById = new Map<string, ProjectionTurnDraft>();
  const clientRequestMetaById = new Map<string, EventMeta>();
  const entryDrafts: ProjectionEntryDraft[] = [];

  for (const { event, meta } of args.events) {
    if (event.type === "client/turn/requested") {
      clientRequestMetaById.set(event.requestId, meta);
    }
  }

  for (const { event, meta } of args.events) {
    if (event.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });

      if (turnsById.has(turnId)) {
        continue;
      }

      turnsById.set(turnId, createProjectionTurn(event, meta));
      entryDrafts.push({
        kind: "turn",
        turnId,
        sourceSeqStart: meta.seq,
        createdAt: meta.createdAt,
      });
      continue;
    }

    if (event.type === "turn/completed") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });

      const existing = turnsById.get(turnId);

      if (!existing) {
        throw new MissingProjectionTurnStartedError(
          event.threadId,
          turnId,
          "turn/completed",
          meta.seq,
          args,
        );
      }

      updateProjectionTurnCompletion(existing, event, meta);
      continue;
    }

    if (event.type === "system/git-activity") {
      const turnId = getThreadEventScopeTurnId(event.scope);
      const existing = turnId === undefined ? undefined : turnsById.get(turnId);

      if (existing) {
        existing.turn.gitActivity = normalizeTurnGitActivity(event.activity);
      }

      continue;
    }

    if (event.type === "turn/input/accepted") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });

      const existing = turnsById.get(turnId);

      if (!existing) {
        throw new MissingProjectionTurnStartedError(
          event.threadId,
          turnId,
          "turn/input/accepted",
          meta.seq,
          args,
        );
      }

      const clientRequestMeta = clientRequestMetaById.get(
        event.clientRequestId,
      );

      if (clientRequestMeta) {
        updateProjectionTurnBounds(existing, {
          threadId: event.threadId,
          sourceSeqStart: clientRequestMeta.seq,
          sourceSeqEnd: clientRequestMeta.seq,
          createdAt: clientRequestMeta.createdAt,
        });
      }
    }
  }

  for (const message of args.messages) {
    if (message.scope.kind === "thread") {
      const runningTurn = canGroupThreadMessageInTurn(message)
        ? findRootTurnRunningAtSequence(
            turnsById,
            args.delegatedTurnIds,
            message.sourceSeqStart,
          )
        : null;

      if (runningTurn !== null) {
        addProjectionTurnMessage(runningTurn, message);
        continue;
      }

      entryDrafts.push({
        kind: "projected-message",
        message,
        sourceSeqStart: message.sourceSeqStart,
        createdAt: message.createdAt,
      });
      continue;
    }

    const turnId = message.scope.turnId;
    const turnDraft = turnsById.get(turnId);

    if (!turnDraft) {
      throw new MissingProjectionTurnStartedError(
        message.threadId,
        turnId,
        "message",
        message.sourceSeqStart,
        args,
      );
    }

    addProjectionTurnMessage(turnDraft, message);
  }

  applyExternalUserBoundaries(turnsById, args.messages);

  const orderedEntryDrafts = [...entryDrafts].sort((left, right) => {
    if (left.sourceSeqStart !== right.sourceSeqStart) {
      return left.sourceSeqStart - right.sourceSeqStart;
    }

    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }

    return 0;
  });

  return {
    state: {
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
    },
    entries: orderedEntryDrafts.map((entryDraft) =>
      createEventProjectionEntry(entryDraft, turnsById),
    ),
  };
}
