import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  advanceThreadHistoryRewriteRevision,
  advanceThreadWorkObligationRevision,
  installedPlugins,
  listRetryingFailures,
  pendingInteractions,
  readStoredThreadWork,
  readThreadAttentionFacts,
  threadPluginMetadata,
  threadWaitConditions,
  threadWaits,
  threads,
  type DbConnection,
  type ThreadAttentionFacts,
  type ThreadConversationSequences,
} from "@omnyo/db";
import {
  projectThreadWork,
  queuedMessageWaitingOnSchema,
  queuedMessageWork,
  threadLifecycleWork,
  type ThreadActivityState,
  type ThreadChangeKind,
  type ThreadQueuedWork,
  type ThreadRuntimeState,
  type ThreadStatus,
  type ThreadVisibility,
  type ThreadWorkActivity,
  type ThreadWorkActor,
  type ThreadWorkEvidence,
  type ThreadWorkSummary,
  type ThreadWorkWait,
} from "@omnyo/domain";
import type { NotificationHub } from "../../ws/hub.js";
import { ThreadWorkFacts } from "./thread-work-facts.js";
import {
  readBoundCompletionReports,
  readWorkContinuations,
} from "./thread-completion.js";
import {
  AUTO_COMPACTION_METADATA_NAMESPACE,
  getLatestMaintenanceRequest,
  readAutoCompactionMetadata,
} from "./maintenance-run.js";

export interface ThreadWorkSource {
  id: string;
  title: string | null;
  titleFallback: string | null;
  originPluginId: string | null;
  visibility: ThreadVisibility;
  status: ThreadStatus;
  runtime: ThreadRuntimeState;
  activity: ThreadActivityState;
  queuedWork: ThreadQueuedWork;
  hasPendingInteraction: boolean;
  archivedAt: number | null;
  deletedAt: number | null;
}

export interface ThreadWorkSources {
  sources: readonly ThreadWorkSource[];
  attentionFacts: ReadonlyMap<string, ThreadAttentionFacts>;
}

export type ResolveThreadWorkSources = (
  threadIds: readonly string[],
) => ThreadWorkSources;

interface ThreadWorkGraph {
  sources: Map<string, ThreadWorkSource>;
  attentionFacts: Map<string, ThreadAttentionFacts>;
  dependents: Map<string, string[]>;
}

type DependentWork =
  | { kind: "activity"; activity: ThreadWorkActivity }
  | { kind: "wait"; wait: ThreadWorkWait };

const OBLIGATION_CHANGES: ReadonlySet<ThreadChangeKind> = new Set([
  "status-changed",
  "queue-changed",
  "interactions-changed",
  "history-rewritten",
]);

const DEPENDENT_WORK_CHANGES: ReadonlySet<ThreadChangeKind> = new Set([
  ...OBLIGATION_CHANGES,
  "thread-created",
  "thread-deleted",
  "work-changed",
  "archived-changed",
  "parent-changed",
]);

const contributorStates = new WeakMap<
  DbConnection,
  () => ReadonlyMap<string, boolean>
>();

const registeredHubs = new WeakSet<NotificationHub>();

export function setThreadWorkContributorStates(
  db: DbConnection,
  read: () => ReadonlyMap<string, boolean>,
): void {
  contributorStates.set(db, read);
}

function listWorkAncestorIds(db: DbConnection, threadId: string): string[] {
  const seen = new Set([threadId]);
  const ancestors: string[] = [];
  let frontier = [threadId];

  while (frontier.length > 0) {
    const next: string[] = [];

    for (const row of db
      .select({
        parentId: threads.parentThreadId,
        ownerId: threads.lifecycleOwnerThreadId,
        launcherId: threads.launchedByThreadId,
        predecessorId: sql<
          string | null
        >`CASE WHEN ${threads.originKind} = 'handoff' THEN ${threads.sourceThreadId} END`,
      })
      .from(threads)
      .where(inArray(threads.id, frontier))
      .all())
      for (const id of [
        row.parentId,
        row.ownerId,
        row.launcherId,
        row.predecessorId,
      ]) {
        if (id === null || seen.has(id)) continue;
        seen.add(id);
        ancestors.push(id);
        next.push(id);
      }

    frontier = next;
  }

  return ancestors;
}

function advancesObligation(
  db: DbConnection,
  threadId: string,
  changes: readonly ThreadChangeKind[],
): boolean {
  const obligations = changes.filter((change) =>
    OBLIGATION_CHANGES.has(change),
  );

  if (obligations.length === 0) return false;

  if (obligations.some((change) => change !== "status-changed")) return true;

  return getLatestMaintenanceRequest(db, threadId) === null;
}

function readMaintenanceBases(
  db: DbConnection,
  ids: readonly string[],
): Map<string, { requestSequence: number } & ThreadConversationSequences> {
  const result = new Map<
    string,
    { requestSequence: number } & ThreadConversationSequences
  >();

  for (let offset = 0; offset < ids.length; offset += 400) {
    for (const row of db
      .select({ threadId: threadPluginMetadata.threadId })
      .from(threadPluginMetadata)
      .where(
        and(
          inArray(
            threadPluginMetadata.threadId,
            ids.slice(offset, offset + 400),
          ),
          eq(threadPluginMetadata.pluginId, AUTO_COMPACTION_METADATA_NAMESPACE),
        ),
      )
      .all()) {
      const snapshot = readAutoCompactionMetadata(
        db,
        row.threadId,
      ).basisSnapshot;

      if (snapshot !== null) result.set(row.threadId, snapshot);
    }
  }

  return result;
}

export function registerThreadWorkRevisions(
  db: DbConnection,
  hub: NotificationHub,
): void {
  if (registeredHubs.has(hub)) return;
  registeredHubs.add(hub);
  const notifying = new Set<string>();

  hub.onThreadChanged((threadId, changes, metadata) => {
    if (notifying.has(threadId)) return;

    if (advancesObligation(db, threadId, changes)) {
      if (changes.includes("history-rewritten"))
        advanceThreadHistoryRewriteRevision(db, threadId);
      advanceThreadWorkObligationRevision(db, threadId);

      const owner = db
        .select({ id: threads.lifecycleOwnerThreadId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .get()?.id;

      if (owner !== null && owner !== undefined && owner !== threadId)
        advanceThreadWorkObligationRevision(db, owner);
    }

    if (
      !changes.some((change) => DEPENDENT_WORK_CHANGES.has(change)) &&
      metadata?.backgroundActivityChanged !== true
    )
      return;

    for (const ancestorId of listWorkAncestorIds(db, threadId)) {
      notifying.add(ancestorId);

      try {
        hub.notifyThread(ancestorId, ["work-changed"]);
      } finally {
        notifying.delete(ancestorId);
      }
    }
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function collectThreadWorkGraph(
  db: DbConnection,
  roots: readonly ThreadWorkSource[],
  attentionFacts: ReadonlyMap<string, ThreadAttentionFacts>,
  resolveSources: ResolveThreadWorkSources,
): ThreadWorkGraph {
  const sources = new Map(roots.map((source) => [source.id, source]));
  const facts = new Map(attentionFacts);
  const dependents = new Map<string, string[]>();
  const expanded = new Set<string>();
  let frontier = [...sources.keys()];

  while (frontier.length > 0) {
    const found = new Set<string>();

    for (const id of frontier) expanded.add(id);

    for (let offset = 0; offset < frontier.length; offset += 400) {
      const batch = frontier.slice(offset, offset + 400);
      const members = new Set(batch);

      for (const row of db
        .select({
          id: threads.id,
          parentId: threads.parentThreadId,
          ownerId: threads.lifecycleOwnerThreadId,
          launcherId: threads.launchedByThreadId,
        })
        .from(threads)
        .where(
          and(
            or(
              inArray(threads.parentThreadId, batch),
              inArray(threads.lifecycleOwnerThreadId, batch),
              inArray(threads.launchedByThreadId, batch),
            ),
            isNull(threads.archivedAt),
            isNull(threads.deletedAt),
          ),
        )
        .all()) {
        for (const ancestorId of [row.parentId, row.ownerId, row.launcherId]) {
          if (
            ancestorId === null ||
            ancestorId === row.id ||
            !members.has(ancestorId)
          )
            continue;
          const children = dependents.get(ancestorId) ?? [];

          if (!children.includes(row.id)) children.push(row.id);
          dependents.set(ancestorId, children);
        }

        found.add(row.id);
      }
    }

    const missing = [...found].filter((id) => !sources.has(id));

    if (missing.length > 0) {
      const resolved = resolveSources(missing);

      for (const source of resolved.sources) sources.set(source.id, source);

      for (const [id, fact] of resolved.attentionFacts) facts.set(id, fact);
    }

    frontier = [...found].filter((id) => sources.has(id) && !expanded.has(id));
  }

  return { sources, attentionFacts: facts, dependents };
}

function dependentsFirst(graph: ThreadWorkGraph): ThreadWorkSource[] {
  const order: ThreadWorkSource[] = [];
  const visited = new Set<string>();

  const visit = (source: ThreadWorkSource): void => {
    if (visited.has(source.id)) return;
    visited.add(source.id);

    for (const childId of graph.dependents.get(source.id) ?? []) {
      const child = graph.sources.get(childId);

      if (child !== undefined) visit(child);
    }

    order.push(source);
  };

  for (const source of graph.sources.values()) visit(source);

  return order;
}

function dependentWork(
  child: ThreadWorkSource,
  work: ThreadWorkSummary,
): DependentWork | null {
  const label =
    [child.title, child.titleFallback].find((value) => value?.trim()) ??
    (child.visibility === "hidden" ? "Background worker" : "Linked chat");

  const actor = { kind: "thread" as const, id: child.id, label };

  if (work.primary.label === "working")
    return {
      kind: "activity",
      activity: {
        id: child.id,
        kind: child.originPluginId === "workflows" ? "workflow" : "agent",
        label,
        phase: work.activity.some((activity) => activity.phase === "running")
          ? "running"
          : "queued",
        actor,
      },
    };

  if (
    child.visibility === "hidden" ||
    (work.archive.eligible && work.primary.label !== "external")
  )
    return null;

  return {
    kind: "wait",
    wait: {
      id: child.id,
      reason: `${label}: ${work.primary.reason.text}`.slice(0, 1000),
      actor,
    },
  };
}

interface PendingWaitCondition {
  kind: string;
  target: string | null;
  label: string;
}

function inboxWaitActor(
  kind: string,
  pending: readonly PendingWaitCondition[],
): ThreadWorkActor {
  if (kind === "report") return { kind: "user", id: null, label: "You" };

  const chat = pending.find(
    (condition) => condition.kind === "chat" && condition.target !== null,
  );

  if (chat !== undefined)
    return {
      kind: "thread",
      id: chat.target,
      label: chat.label.trim().slice(0, 1000) || "Source chat",
    };

  return {
    kind: "external",
    id: null,
    label: pending[0]?.label.trim().slice(0, 1000) || "Omnyo Inbox",
  };
}

function readInboxWaits(
  db: DbConnection,
  ids: readonly string[],
): Map<string, ThreadWorkWait[]> {
  const result = new Map<string, ThreadWorkWait[]>();

  for (let offset = 0; offset < ids.length; offset += 400) {
    const rows = db
      .select({
        id: threadWaits.id,
        threadId: threadWaits.threadId,
        kind: threadWaits.kind,
        forText: threadWaits.forText,
        questionId: threadWaits.questionId,
      })
      .from(threadWaits)
      .where(
        and(
          inArray(threadWaits.threadId, ids.slice(offset, offset + 400)),
          inArray(threadWaits.status, ["live", "evaluating", "dispatched"]),
          ne(threadWaits.kind, "send-later"),
        ),
      )
      .orderBy(asc(threadWaits.createdAt))
      .all()
      .filter((row) => !(row.kind === "date" && row.questionId !== null));

    if (rows.length === 0) continue;

    const pending = new Map<string, PendingWaitCondition[]>();

    for (const condition of db
      .select({
        waitId: threadWaitConditions.waitId,
        kind: threadWaitConditions.kind,
        target: threadWaitConditions.target,
        label: threadWaitConditions.label,
      })
      .from(threadWaitConditions)
      .where(
        and(
          inArray(
            threadWaitConditions.waitId,
            rows.map((row) => row.id),
          ),
          eq(threadWaitConditions.state, "pending"),
        ),
      )
      .all()) {
      const entries = pending.get(condition.waitId) ?? [];
      entries.push(condition);
      pending.set(condition.waitId, entries);
    }

    for (const row of rows) {
      const waits = result.get(row.threadId) ?? [];

      waits.push({
        id: row.id,
        reason:
          `${row.kind === "report" ? "On you" : "Waiting for"}: ${row.forText}`.slice(
            0,
            1000,
          ),
        actor: inboxWaitActor(row.kind, pending.get(row.id) ?? []),
      });
      result.set(row.threadId, waits);
    }
  }

  return result;
}

export function buildThreadWorkSummaries(
  db: DbConnection,
  roots: readonly ThreadWorkSource[],
  resolveSources: ResolveThreadWorkSources,
  attentionFacts?: ReadonlyMap<string, ThreadAttentionFacts>,
  workFacts = new ThreadWorkFacts(db),
): Map<string, ThreadWorkSummary> {
  const graph = collectThreadWorkGraph(
    db,
    roots,
    attentionFacts ??
      readThreadAttentionFacts(
        db,
        roots.map((source) => source.id),
      ),
    resolveSources,
  );

  const sources = dependentsFirst(graph);
  const ids = sources.map((source) => source.id);
  const facts = graph.attentionFacts;
  const stored = readStoredThreadWork(db, ids);
  const maintenanceBases = readMaintenanceBases(db, ids);
  const inboxWaits = readInboxWaits(db, ids);
  const retryingFailures = listRetryingFailures(db, ids);

  const archiveCandidates = [...stored.entries()].flatMap(
    ([threadId, state]) => {
      if (!state.assessments.some(({ value }) => value.archiveReady === true))
        return [];
      const maintenance = maintenanceBases.get(threadId);

      const conversation =
        maintenance?.requestSequence === state.conversation.lastInput
          ? maintenance
          : state.conversation;

      return [
        {
          threadId,
          requestSeq: conversation.lastInput,
          completionSeq: conversation.lastCompleted,
        },
      ];
    },
  );

  const completionReports = readBoundCompletionReports(db, archiveCandidates);

  const continuations = readWorkContinuations(
    db,
    archiveCandidates.map(({ threadId }) => threadId),
  );

  const available =
    contributorStates.get(db)?.() ??
    new Map(
      db
        .select({ id: installedPlugins.id, enabled: installedPlugins.enabled })
        .from(installedPlugins)
        .all()
        .map((plugin) => [plugin.id, plugin.enabled]),
    );

  const interactions = new Map<
    string,
    Array<Pick<typeof pendingInteractions.$inferSelect, "id" | "status">>
  >();

  workFacts.ensure(ids);
  const queue = workFacts.queue;

  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);

    for (const row of db
      .select({
        id: pendingInteractions.id,
        threadId: pendingInteractions.threadId,
        status: pendingInteractions.status,
      })
      .from(pendingInteractions)
      .where(
        and(
          inArray(pendingInteractions.threadId, batch),
          inArray(pendingInteractions.status, ["pending", "resolving"]),
        ),
      )
      .all()) {
      const entries = interactions.get(row.threadId) ?? [];
      entries.push(row);
      interactions.set(row.threadId, entries);
    }
  }

  const result = new Map<string, ThreadWorkSummary>();

  for (const source of sources) {
    const saved = stored.get(source.id);
    const attention = facts.get(source.id);
    const delegated: DependentWork[] = [];

    for (const childId of graph.dependents.get(source.id) ?? []) {
      const child = graph.sources.get(childId);
      const work = result.get(childId);

      if (child === undefined || work === undefined) continue;
      const fact = dependentWork(child, work);

      if (fact !== null) delegated.push(fact);
    }

    const evidence: ThreadWorkEvidence = {
      revision: "",
      basis: "",
      activity: [],
      requiredInput: [],
      optionalInput: [],
      failures: [],
      waits: [],
      coverageComplete: saved?.corrupt !== true,
      unknownReason:
        saved?.corrupt === true
          ? "Stored work evidence could not be read."
          : null,
      assessment: null,
      postponement: null,
      closed: source.archivedAt !== null || source.deletedAt !== null,
    };

    for (const question of attention?.questions ?? []) {
      const input = {
        id: question.id,
        label: question.question.prompt,
        kind: "question" as const,
      };

      if (question.question.mode === "required")
        evidence.requiredInput.push(input);
      else evidence.optionalInput.push(input);
    }

    for (const interaction of interactions.get(source.id) ?? [])
      if (interaction.status === "pending")
        evidence.requiredInput.push({
          id: interaction.id,
          label: "A pending permission or question needs your answer.",
          kind: "permission",
        });
      else
        evidence.waits.push({
          id: interaction.id,
          reason: "Waiting for the agent to apply your answer.",
          actor: { kind: "agent", id: source.id, label: "Agent" },
        });

    if (source.hasPendingInteraction && evidence.requiredInput.length === 0)
      evidence.requiredInput.push({
        id: `interaction:${source.id}`,
        label: "A pending permission or question needs your answer.",
        kind: "permission",
      });

    evidence.waits.push(...(inboxWaits.get(source.id) ?? []));

    const lifecycle = threadLifecycleWork(source);

    if (lifecycle.turn !== null) evidence.activity.unshift(lifecycle.turn);

    if (lifecycle.hostWait !== null) evidence.waits.push(lifecycle.hostWait);

    if (lifecycle.provisioning !== null)
      evidence.activity.push(lifecycle.provisioning);

    for (const entry of queue.get(source.id) ?? []) {
      if (entry.failureReason !== null) continue;

      const fact = queuedMessageWork(
        {
          id: entry.id,
          sendAt: entry.sendAt,
          waitingOn:
            entry.waitingOn === null
              ? null
              : queuedMessageWaitingOnSchema.parse(JSON.parse(entry.waitingOn)),
        },
        {
          threadId: source.id,
          threadStatus: source.status,
          waitingForHost: source.runtime.displayStatus === "waiting-for-host",
          hasRequiredInput: evidence.requiredInput.length > 0,
          pluginAvailable: (pluginId) => available.get(pluginId) === true,
          now: Date.now(),
        },
      );

      if (fact.kind === "activity") evidence.activity.push(fact.activity);
      else if (fact.kind === "wait") evidence.waits.push(fact.wait);
      else if (fact.kind === "unverified") {
        evidence.coverageComplete = false;
        evidence.unknownReason = fact.reason;
      }
    }

    if (source.queuedWork === "failed")
      evidence.failures.push({
        code: "queue-failed",
        text: "A queued message failed to send.",
        sourceId: source.id,
      });

    const retrying = retryingFailures.get(source.id);

    if (source.status === "error" && retrying !== undefined)
      evidence.waits.push({
        id: retrying.id,
        reason: `Retrying: ${retrying.reason}`.slice(0, 1000),
        actor: { kind: "external", id: retrying.id, label: "Automatic retry" },
      });
    else if (source.status === "error")
      evidence.failures.push({
        code: "run-failed",
        text: "The last agent run failed and needs recovery.",
        sourceId: source.id,
      });

    for (const [kind, count, label] of [
      ["workflow", source.activity.activeWorkflowCount, "Workflow"],
      ["agent", source.activity.activeBackgroundAgentCount, "Background agent"],
      [
        "command",
        source.activity.activeBackgroundCommandCount,
        "Background command",
      ],
    ] as const) {
      if (
        lifecycle.hostWait === null &&
        count > 0 &&
        !evidence.activity.some((activity) => activity.kind === kind)
      )
        evidence.activity.push({
          id: `${kind}:${source.id}`,
          kind,
          label: `${label}${count > 1 ? `s (${count})` : ""} running.`,
          phase: "running",
          actor: { kind: "agent", id: source.id, label },
        });
    }

    if (
      source.activity.activeGoalCount > 0 ||
      source.activity.activePlanModeCount > 0
    ) {
      evidence.coverageComplete = false;
      evidence.unknownReason =
        source.activity.activeGoalCount > 0
          ? "A goal remains active; completion has not been established."
          : "A plan remains active; completion has not been established.";
    }

    const contributions = [...(saved?.signals ?? [])].sort((a, b) =>
      a.pluginId.localeCompare(b.pluginId),
    );

    for (const contribution of contributions) {
      const active = available.get(contribution.pluginId) !== false;

      const valid =
        contribution.value.validUntil === null
          ? available.has(contribution.pluginId)
          : contribution.value.validUntil > Date.now();

      const claimsOwnership =
        contribution.value.activity.length > 0 ||
        contribution.value.waits.length > 0;

      evidence.failures.push(...contribution.value.failures);

      if (
        contribution.intentRevision === saved?.obligationRevision &&
        (contribution.value.postponement?.until === null ||
          (contribution.value.postponement?.until ?? 0) > Date.now())
      )
        evidence.postponement ??= contribution.value.postponement;

      if (
        !contribution.value.complete ||
        ((!active || !valid) && claimsOwnership)
      ) {
        evidence.coverageComplete = false;
        evidence.unknownReason = `Work owned by ${contribution.pluginId} could not be verified.`;
      }

      if (!active || !valid) continue;
      evidence.activity.push(...contribution.value.activity);
      evidence.waits.push(...contribution.value.waits);
    }

    const maintenanceBasis = maintenanceBases.get(source.id);

    const conversation =
      maintenanceBasis !== undefined &&
      maintenanceBasis.requestSequence === saved?.conversation.lastInput
        ? maintenanceBasis
        : saved?.conversation;

    evidence.basis = digest([
      3,
      source.id,
      conversation?.lastInput ?? 0,
      conversation?.lastStarted ?? 0,
      conversation?.lastCompleted ?? 0,
      saved?.historyRewriteRevision ?? 0,
    ]);

    const assessments = [...(saved?.assessments ?? [])].sort(
      (a, b) => b.version - a.version || a.pluginId.localeCompare(b.pluginId),
    );

    evidence.assessment =
      assessments.find((candidate) => candidate.value.basis === evidence.basis)
        ?.value ??
      assessments[0]?.value ??
      null;

    if (
      evidence.assessment !== null &&
      assessments.some(
        (candidate) =>
          candidate.value === evidence.assessment &&
          available.get(candidate.pluginId) === false,
      )
    )
      evidence.assessment = {
        ...evidence.assessment,
        availability: "disabled",
        reason: "Completion assessments are disabled.",
        archiveReady: null,
      };
    const assessment = evidence.assessment;

    if (
      assessment?.basis === evidence.basis &&
      assessment.availability === "available" &&
      assessment.archiveReady
    ) {
      const report =
        assessment.sourceSeq === conversation?.lastCompleted
          ? completionReports.get(source.id)
          : undefined;

      const continued = continuations.has(source.id);

      evidence.assessment = {
        ...assessment,
        archiveReady: !continued && report?.status === "complete",
        reason: continued
          ? "Work continued in another chat."
          : report?.status === "complete"
            ? report.evidence
            : (report?.blocker ??
              "No current completion report verifies the requested outcome."),
        recap:
          !continued && report?.status === "complete" ? report.outcome : null,
      };
    }

    const own = delegated.length > 0 ? projectThreadWork(evidence) : null;

    if (own !== null) {
      const delegatedActivity = delegated.flatMap((fact) =>
        fact.kind === "activity" ? [fact.activity] : [],
      );

      const insertionIndex = lifecycle.turn === null ? 0 : 1;
      evidence.activity = [
        ...evidence.activity.slice(0, insertionIndex),
        ...delegatedActivity,
        ...evidence.activity.slice(insertionIndex),
      ];
      evidence.waits = [
        ...delegated.flatMap((fact) =>
          fact.kind === "wait" ? [fact.wait] : [],
        ),
        ...evidence.waits,
      ];
    }

    evidence.revision = digest([
      evidence.basis,
      saved?.obligationRevision ?? 0,
      source.status,
      source.runtime.displayStatus,
      source.queuedWork,
      attention?.questions.map((question) => [
        question.id,
        question.revision,
        question.updatedAt,
      ]),
      attention?.callbacks.map((callback) => [
        callback.id,
        callback.sourceState,
        callback.afterSeq,
      ]),
      [...(interactions.get(source.id) ?? [])],
      source.activity,
      evidence.activity,
      evidence.requiredInput,
      evidence.failures,
      evidence.waits,
      contributions.map((contribution) => [
        contribution.pluginId,
        contribution.version,
        available.get(contribution.pluginId) ?? true,
      ]),
      evidence.coverageComplete,
      assessments.map((candidate) => [
        candidate.pluginId,
        candidate.version,
        available.get(candidate.pluginId) ?? true,
      ]),
      evidence.assessment?.availability,
      evidence.assessment?.archiveReady,
      evidence.assessment?.reason,
      evidence.assessment?.recap,
    ]);
    const work = projectThreadWork(evidence);
    result.set(
      source.id,
      own === null
        ? work
        : {
            ...work,
            experimental_ownState: {
              primary: own.primary,
              hasActivity: own.activity.length > 0,
            },
          },
    );
  }

  return result;
}
