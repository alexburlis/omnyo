import { z } from "zod";
import {
  SERVER_UPDATE_WAIT_COPY,
  type QueuedMessageWaitingOn,
} from "./queued-message.js";
import type { ThreadRuntimeState } from "./thread.js";
import type { ThreadStatus } from "./thread-status.js";

const text = z.string().trim().min(1).max(1000);

const displayText = z.string().trim().min(1).max(2000);

export const threadWorkLabelSchema = z.enum([
  "needs-you",
  "working",
  "blocked",
  "failed",
  "waiting",
  "open",
  "external",
  "ready-to-archive",
]);

export const threadWorkActorSchema = z.object({
  kind: z.enum(["user", "agent", "thread", "external", "unknown"]),
  id: z.string().nullable(),
  label: text,
});

export const threadWorkActivitySchema = z.object({
  id: text,
  kind: z.enum(["turn", "queue", "workflow", "agent", "command", "plugin"]),
  label: text,
  phase: z.enum(["running", "queued"]),
  actor: threadWorkActorSchema,
});

export const threadWorkInputSchema = z.object({
  id: text,
  label: displayText,
  kind: z.enum(["question", "permission"]),
});

export const threadWorkFailureSchema = z.object({
  code: text,
  text,
  sourceId: z.string().nullable(),
});

export const threadWorkPostponementSchema = z.object({
  reason: text,
  until: z.number().nullable(),
  resumeActor: threadWorkActorSchema,
});

export const threadWorkWaitSchema = z.object({
  id: text,
  reason: text,
  actor: threadWorkActorSchema,
});

export const threadWorkSignalsSchema = z
  .object({
    complete: z.boolean(),
    validUntil: z.number().nullable(),
    activity: z.array(threadWorkActivitySchema).max(100),
    waits: z.array(threadWorkWaitSchema).max(100),
    failures: z.array(threadWorkFailureSchema).max(100),
    postponement: threadWorkPostponementSchema.nullable(),
  })
  .strict();

export const threadWorkAssessmentSchema = z
  .object({
    basis: text,
    contractVersion: z.literal(1),
    availability: z.enum([
      "checking",
      "available",
      "disabled",
      "failed",
      "skipped",
    ]),
    reason: text,
    sourceSeq: z.number().int().nonnegative().nullable(),
    text: z.string().nullable(),
    noSuggestionReason: text.nullable(),
    waitingOn: text.nullable().default(null),
    ask: z.string().trim().max(200).nullable().default(null),
    recap: z.string().trim().max(400).nullable().default(null),
    archiveReady: z.boolean().nullable(),
  })
  .strict();

export const threadWorkContributionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("assessment"),
      assessment: threadWorkAssessmentSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("signals"), signals: threadWorkSignalsSchema })
    .strict(),
]);

export const publishThreadWorkSchema = z
  .object({
    pluginId: z.string().trim().min(1).max(120),
    contribution: threadWorkContributionSchema,
  })
  .strict();

const threadWorkPrimarySchema = z.object({
  label: threadWorkLabelSchema,
  reason: z.object({ code: text, text: displayText }),
});

export const threadWorkSummarySchema = z.object({
  revision: z.string(),
  basis: z.string(),
  primary: threadWorkPrimarySchema,
  experimental_ownState: z
    .object({
      primary: threadWorkPrimarySchema,
      hasActivity: z.boolean(),
    })
    .optional(),
  activity: z.array(threadWorkActivitySchema),
  requiredInput: z.array(threadWorkInputSchema),
  optionalInput: z.array(threadWorkInputSchema),
  failures: z.array(threadWorkFailureSchema),
  waits: z.array(threadWorkWaitSchema),
  nextActors: z.array(threadWorkActorSchema),
  assessment: z.object({
    availability: z.enum([
      "missing",
      "checking",
      "available",
      "stale",
      "disabled",
      "failed",
      "skipped",
    ]),
    reason: text,
    sourceSeq: z.number().int().nonnegative().nullable(),
    suggestion: z.enum(["available", "omitted", "unavailable"]),
    noSuggestionReason: text.nullable(),
    waitingOn: text.nullable(),
    ask: z.string().trim().max(200).nullable().default(null),
    recap: z.string().trim().max(400).nullable().default(null),
  }),
  postponement: threadWorkPostponementSchema.nullable(),
  archive: z.object({
    eligible: z.boolean(),
    recommended: z.boolean(),
    reason: text,
  }),
});

export type ThreadWorkLabel = z.infer<typeof threadWorkLabelSchema>;

export type ThreadWorkActor = z.infer<typeof threadWorkActorSchema>;

export type ThreadWorkActivity = z.infer<typeof threadWorkActivitySchema>;

export type ThreadWorkInput = z.infer<typeof threadWorkInputSchema>;

export type ThreadWorkFailure = z.infer<typeof threadWorkFailureSchema>;

export type ThreadWorkWait = z.infer<typeof threadWorkWaitSchema>;

export type ThreadWorkSignals = z.infer<typeof threadWorkSignalsSchema>;

export type ThreadWorkAssessment = z.infer<typeof threadWorkAssessmentSchema>;

export type ThreadWorkContribution = z.infer<
  typeof threadWorkContributionSchema
>;

export type PublishThreadWork = z.infer<typeof publishThreadWorkSchema>;

export type ThreadWorkSummary = z.infer<typeof threadWorkSummarySchema>;

export interface ThreadWorkEvidence {
  revision: string;
  basis: string;
  activity: ThreadWorkActivity[];
  requiredInput: ThreadWorkInput[];
  optionalInput: ThreadWorkInput[];
  failures: ThreadWorkFailure[];
  waits: ThreadWorkWait[];
  coverageComplete: boolean;
  unknownReason: string | null;
  assessment: ThreadWorkAssessment | null;
  postponement: z.infer<typeof threadWorkPostponementSchema> | null;
  closed: boolean;
}

export const THREAD_WORK_LABELS: Record<ThreadWorkLabel, string> = {
  "needs-you": "Needs you",
  working: "Working",
  blocked: "Blocked",
  failed: "Failed",
  waiting: "Waiting",
  open: "Open",
  external: "External",
  "ready-to-archive": "Ready to archive",
};

const RUNNING_THREAD_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "active",
  "stopping",
]);

const FAILED_RUN_HELD_WAITS: ReadonlySet<QueuedMessageWaitingOn["kind"]> =
  new Set(["thread-busy", "stopping", "turn-starting"]);

export interface ThreadLifecycleWork {
  turn: ThreadWorkActivity | null;
  provisioning: ThreadWorkActivity | null;
  hostWait: ThreadWorkWait | null;
}

export function threadLifecycleWork(thread: {
  id: string;
  status: ThreadStatus;
  runtime: ThreadRuntimeState;
}): ThreadLifecycleWork {
  const waitingForHost = thread.runtime.displayStatus === "waiting-for-host";

  return {
    turn:
      RUNNING_THREAD_STATUSES.has(thread.status) && !waitingForHost
        ? {
            id: `turn:${thread.id}`,
            kind: "turn",
            label: "The agent is working.",
            phase: "running",
            actor: { kind: "agent", id: thread.id, label: "Agent" },
          }
        : null,
    provisioning:
      thread.runtime.displayStatus === "provisioning"
        ? {
            id: `provision:${thread.id}`,
            kind: "queue",
            label: "The execution environment is being prepared.",
            phase: "queued",
            actor: { kind: "agent", id: thread.id, label: "Environment setup" },
          }
        : null,
    hostWait: waitingForHost
      ? {
          id: `host:${thread.id}`,
          reason: "Waiting for the execution machine to reconnect.",
          actor: { kind: "external", id: null, label: "Execution machine" },
        }
      : null,
  };
}

export type QueuedMessageWork =
  | { kind: "activity"; activity: ThreadWorkActivity }
  | { kind: "wait"; wait: ThreadWorkWait }
  | { kind: "unverified"; reason: string }
  | { kind: "none" };

export function queuedMessageWork(
  message: {
    id: string;
    sendAt: number | null;
    waitingOn: QueuedMessageWaitingOn | null;
  },
  context: {
    threadId: string;
    threadStatus: ThreadStatus;
    waitingForHost: boolean;
    hasRequiredInput: boolean;
    pluginAvailable: (pluginId: string) => boolean;
    now: number;
  },
): QueuedMessageWork {
  const waiting = message.waitingOn;

  if (waiting?.kind === "superseded")
    return {
      kind: "wait",
      wait: {
        id: message.id,
        reason:
          "A newer message overtook this retry. Send or delete the queued input.",
        actor: { kind: "user", id: null, label: "You" },
      },
    };

  if (message.sendAt !== null && message.sendAt > context.now)
    return {
      kind: "wait",
      wait: {
        id: message.id,
        reason: "Waiting for the scheduled message time.",
        actor: {
          kind: "external",
          id: message.id,
          label: "Scheduled dispatch",
        },
      },
    };

  if (waiting?.kind === "host-offline" || waiting?.kind === "host-away")
    return {
      kind: "wait",
      wait: {
        id: message.id,
        reason: `Waiting for ${waiting.hostName} to become available.`,
        actor: { kind: "external", id: null, label: waiting.hostName },
      },
    };

  if (waiting?.kind === "server-update")
    return {
      kind: "wait",
      wait: {
        id: message.id,
        reason: SERVER_UPDATE_WAIT_COPY.status,
        actor: {
          kind: "external",
          id: null,
          label: SERVER_UPDATE_WAIT_COPY.actor,
        },
      },
    };

  if (waiting?.kind === "interaction")
    return context.hasRequiredInput
      ? { kind: "none" }
      : {
          kind: "unverified",
          reason:
            "The queued message's input dependency has not been verified.",
        };

  if (waiting?.kind === "plugin" && !context.pluginAvailable(waiting.pluginId))
    return {
      kind: "unverified",
      reason: `Dispatch readiness from ${waiting.pluginId} could not be verified.`,
    };

  if (
    context.waitingForHost ||
    (context.threadStatus === "error" &&
      waiting !== null &&
      FAILED_RUN_HELD_WAITS.has(waiting.kind))
  )
    return { kind: "none" };

  return {
    kind: "activity",
    activity: {
      id: message.id,
      kind: "queue",
      label:
        waiting?.kind === "plugin"
          ? waiting.reason
          : "A message is queued to continue the work.",
      phase: "queued",
      actor: { kind: "agent", id: context.threadId, label: "Agent queue" },
    },
  };
}

export function projectThreadWork(
  evidence: ThreadWorkEvidence,
): ThreadWorkSummary {
  const candidate = evidence.assessment;
  const fresh = candidate !== null && candidate.basis === evidence.basis;

  const assessment: ThreadWorkSummary["assessment"] =
    candidate === null
      ? {
          availability: "missing",
          reason: "No completion assessment is available.",
          sourceSeq: null,
          suggestion: "unavailable",
          noSuggestionReason: null,
          waitingOn: null,
          ask: null,
          recap: null,
        }
      : !fresh
        ? {
            availability: "stale",
            reason: "The chat has changed since its completion assessment.",
            sourceSeq: candidate.sourceSeq,
            suggestion: "unavailable",
            noSuggestionReason: null,
            waitingOn: null,
            ask: null,
            recap: null,
          }
        : {
            availability: candidate.availability,
            reason: candidate.reason,
            sourceSeq: candidate.sourceSeq,
            suggestion:
              candidate.availability !== "available"
                ? "unavailable"
                : candidate.text?.trim()
                  ? "available"
                  : "omitted",
            noSuggestionReason: candidate.noSuggestionReason,
            waitingOn: candidate.waitingOn,
            ask: candidate.ask,
            recap: candidate.recap,
          };

  const eligible =
    !evidence.closed &&
    evidence.coverageComplete &&
    evidence.requiredInput.length === 0 &&
    evidence.activity.length === 0 &&
    evidence.failures.length === 0 &&
    evidence.waits.length === 0 &&
    evidence.postponement === null;

  const ownerAsk =
    fresh && candidate?.availability === "available"
      ? candidate.ask?.trim() || null
      : null;

  const externalEvent =
    fresh && candidate?.availability === "available" && ownerAsk === null
      ? candidate.waitingOn
      : null;

  const recommended =
    eligible &&
    ownerAsk === null &&
    externalEvent === null &&
    fresh &&
    candidate?.availability === "available" &&
    candidate.archiveReady === true;

  let label: ThreadWorkLabel = "open";
  let code = "assessment-" + assessment.availability;
  let reason = evidence.unknownReason ?? assessment.reason;

  if (evidence.requiredInput.length > 0) {
    label = "needs-you";
    code = "required-input";
    reason = evidence.requiredInput[0]?.label ?? "Answer the pending question.";
  } else if (evidence.activity.length > 0) {
    label = "working";
    code = "owned-work";
    const first = evidence.activity[0]?.label ?? "Work is running.";
    reason =
      evidence.activity.length === 1
        ? first
        : `${first.slice(0, 940)}; ${evidence.activity.length - 1} other active items`;
  } else if (evidence.failures.length > 0) {
    label = "failed";
    code = evidence.failures[0]?.code ?? "work-failed";
    reason = evidence.failures[0]?.text ?? "Work needs recovery.";
  } else if (evidence.waits.length > 0) {
    label = "waiting";
    code = "external-wait";
    reason =
      evidence.waits[0]?.reason ?? "Waiting for the recorded dependency.";
  } else if (evidence.postponement !== null) {
    code = "postponed";
    reason = evidence.postponement.reason;
  } else if (ownerAsk !== null && !evidence.closed) {
    label = "needs-you";
    code = "assessed-ask";
    reason = ownerAsk;
  } else if (externalEvent !== null) {
    label = "external";
    code = "predicted-external-wait";
    reason = `Waiting on ${externalEvent}`;
  } else if (recommended) {
    label = "ready-to-archive";
    code = "assessed-complete";
    reason = candidate?.reason ?? "The requested work is assessed as complete.";
  } else if (!evidence.coverageComplete) {
    code = "unverified-work";
    reason = evidence.unknownReason ?? "Work ownership could not be verified.";
  } else if (fresh && candidate?.availability === "available") {
    code = "assessed-open";
    reason = candidate.reason;
  }

  const actors: ThreadWorkActor[] = [
    ...(label === "needs-you"
      ? [{ kind: "user", id: null, label: "You" } satisfies ThreadWorkActor]
      : []),
    ...evidence.activity.map((activity) => activity.actor),
    ...evidence.waits.map((wait) => wait.actor),
    ...(evidence.postponement === null
      ? []
      : [evidence.postponement.resumeActor]),
    ...(label === "external" && externalEvent !== null
      ? [
          {
            kind: "external",
            id: null,
            label: externalEvent,
          } satisfies ThreadWorkActor,
        ]
      : []),
  ];

  const nextActors = actors.filter(
    (actor, index) =>
      actors.findIndex(
        (other) =>
          other.kind === actor.kind &&
          other.id === actor.id &&
          other.label === actor.label,
      ) === index,
  );

  if (nextActors.length === 0 && label !== "ready-to-archive")
    nextActors.push({
      kind: "unknown",
      id: null,
      label: "Next owner unconfirmed",
    });

  return {
    revision: evidence.revision,
    basis: evidence.basis,
    primary: { label, reason: { code, text: reason } },
    activity: evidence.activity,
    requiredInput: evidence.requiredInput,
    optionalInput: evidence.optionalInput,
    failures: evidence.failures,
    waits: evidence.waits,
    nextActors,
    assessment,
    postponement: evidence.postponement,
    archive: {
      eligible,
      recommended,
      reason: recommended
        ? reason
        : !evidence.coverageComplete
          ? (evidence.unknownReason ?? "Work ownership could not be verified.")
          : !eligible
            ? "The chat still has unresolved work."
            : ownerAsk !== null
              ? ownerAsk
              : externalEvent !== null
                ? `Waiting on ${externalEvent}`
                : assessment.reason,
    },
  };
}
