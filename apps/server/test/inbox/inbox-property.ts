import {
  getThread,
  listQueuedThreadMessages,
  threadFailures,
  threadOwnerInputs,
  threadProducers,
  threadQuestions,
  threadReceipts,
  threads,
  threadTurnMarks,
  threadWaitConditions,
  threadWaits,
} from "@omnyo/db";
import {
  INBOX_CALLER_PLUGIN_HEADER,
  INBOX_CALLER_THREAD_HEADER,
  INBOX_DISPLAY_MAX,
  INBOX_STALL_GRACE_MS,
  type InboxActRequest,
  type InboxEntry,
  type InboxSnapshot,
  type Thread,
} from "@omnyo/domain";
import type {
  PluginEventSourceDeclaration,
  PluginEventSourceFiring,
  PluginEventSourceProblem,
} from "@omnyo/plugin-sdk";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { runEventSourcePoll } from "../../src/services/inbox/event-source-runner.js";
import { resetEventSourceHealth } from "../../src/services/inbox/event-sources.js";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import { STALL_ESCALATED_TO_WAITER } from "../../src/services/inbox/waits.js";
import { setPluginEventSourceBridge } from "../../src/services/plugins/plugin-event-source-registry.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import {
  acceptSteer,
  agentRequest,
  endTurn,
  entryOf,
  ownerRequest,
  seedChat,
  seedInboxWorld,
  snapshot,
  startSubmittedTurn,
  type InboxWorld,
  type RunningTurn,
} from "./inbox-driver.js";

const DAY = 24 * 60 * 60 * 1000;

export const PROPERTY_UNIT_MS = 3.5 * DAY;

export type Role = "R" | "S" | "C";

export const WALK_SOURCE_PLUGIN = "walk-sources";

const EVENT_POLL_STEP_MS = 2 * 60 * 1000;

const TRACKER_KEYS = ["tracker:T-1", "tracker:T-2", "tracker:T-3"] as const;

const DEPLOY_KEYS = ["deploy:D-1", "deploy:D-2"] as const;

const HOOK_KEYS = ["hook:H-1", "hook:H-2"] as const;

export interface WalkSourceCall {
  family: string;
  targets: string[];
  threw: boolean;
}

export interface WalkSources {
  fired: Set<string>;
  problems: Set<string>;
  broken: boolean;
  pushed: string | null;
  calls: WalkSourceCall[];
  failureStreak: Map<string, number>;
  problemStreak: Map<string, number>;
}

export interface PropertyWorld extends InboxWorld {
  chats: Record<Role, Thread>;
  turns: Map<string, RunningTurn | null>;
  dispatches: Map<string, string>;
  overrideArmed: Set<string>;
  clockSteps: number;
  sources: WalkSources;
}

export interface Violation {
  code: string;
  role: Role | "-";
  message: string;
}

export type PropertyEvent =
  | { kind: "send"; role: Role }
  | { kind: "send-later"; role: Role }
  | { kind: "tell"; role: Role }
  | { kind: "start"; role: Role }
  | { kind: "steer"; role: Role }
  | { kind: "end"; role: Role; status: "completed" | "failed" | "interrupted" }
  | { kind: "agent-check"; role: Role }
  | { kind: "agent-chat"; role: Role }
  | { kind: "owner-chat"; role: Role }
  | { kind: "agent-join"; role: Role }
  | { kind: "agent-report"; role: Role }
  | { kind: "agent-rearm"; role: Role }
  | { kind: "agent-met"; role: Role }
  | { kind: "agent-done"; role: Role }
  | { kind: "agent-cancel"; role: Role }
  | { kind: "agent-question"; role: Role }
  | { kind: "deliver"; role: Role }
  | { kind: "answer"; role: Role }
  | { kind: "ok"; role: Role; focused: boolean }
  | { kind: "archive"; role: Role; focused: boolean }
  | { kind: "wait"; role: Role }
  | { kind: "wait-report"; role: Role }
  | { kind: "accept"; role: Role }
  | { kind: "keep-waiting"; role: Role }
  | { kind: "remind"; role: Role }
  | { kind: "happened"; role: Role }
  | { kind: "shelf"; role: Role }
  | { kind: "resume"; role: Role }
  | { kind: "retry"; role: Role }
  | { kind: "goal-start"; role: Role }
  | {
      kind: "goal-verdict";
      role: Role;
      verdict: "unmet" | "met" | "limit" | "stopped" | "failed";
    }
  | { kind: "agent-event"; role: Role }
  | { kind: "agent-watch"; role: Role }
  | { kind: "event-fire" }
  | { kind: "event-push" }
  | { kind: "event-poll" }
  | { kind: "event-break" }
  | { kind: "event-heal" }
  | { kind: "event-problem" }
  | { kind: "undo" }
  | { kind: "grace" }
  | { kind: "tick" };

export function describeEvent(event: PropertyEvent): string {
  return Object.entries(event)
    .map(([key, value]) =>
      key === "kind" ? String(value) : `${key}=${String(value)}`,
    )
    .join(" ");
}

type ReceiptRow = typeof threadReceipts.$inferSelect;

type WaitRow = typeof threadWaits.$inferSelect;

type ConditionRow = typeof threadWaitConditions.$inferSelect;

type InputRow = typeof threadOwnerInputs.$inferSelect;

type FailureRow = typeof threadFailures.$inferSelect;

type QuestionRow = typeof threadQuestions.$inferSelect;

type ThreadRow = typeof threads.$inferSelect;

type MarkRow = typeof threadTurnMarks.$inferSelect;

type ProducerRow = typeof threadProducers.$inferSelect;

export interface Observation {
  now: number;
  snapshot: InboxSnapshot;
  entries: Map<string, InboxEntry | null>;
  threads: Map<string, ThreadRow>;
  receipts: ReceiptRow[];
  waits: WaitRow[];
  conditions: ConditionRow[];
  inputs: InputRow[];
  failures: FailureRow[];
  questions: QuestionRow[];
  marks: MarkRow[];
  producers: ProducerRow[];
  queue: Map<string, ReturnType<typeof listQueuedThreadMessages>>;
  submits: Map<string, number>;
  turns: Map<string, RunningTurn | null>;
}

const RUNNING = new Set(["starting", "active", "stopping"]);

function checkWalkSource(
  sources: WalkSources,
  family: string,
  targets: readonly string[],
) {
  const call = {
    family,
    targets: [...targets],
    threw: family === "tracker" && sources.broken,
  };

  sources.calls.push(call);

  if (call.threw) {
    sources.failureStreak.set(
      family,
      (sources.failureStreak.get(family) ?? 0) + 1,
    );

    throw new Error(`${family} is offline`);
  }

  sources.failureStreak.set(family, 0);

  for (const key of [...sources.problemStreak.keys()])
    if (
      key.startsWith(`${family}:`) &&
      !targets.includes(key.slice(family.length + 1))
    )
      sources.problemStreak.delete(key);

  return targets.flatMap(
    (target): (PluginEventSourceFiring | PluginEventSourceProblem)[] => {
      const key = `${family}:${target}`;

      if (sources.problems.has(key)) {
        sources.problemStreak.set(
          key,
          (sources.problemStreak.get(key) ?? 0) + 1,
        );

        return [{ target, problem: "no such item" }];
      }

      sources.problemStreak.delete(key);

      return sources.fired.has(key)
        ? [{ target, result: `${target} happened.` }]
        : [];
    },
  );
}

function walkSource(
  sources: WalkSources,
  family: string,
  approval: "none" | "owner",
  polled: boolean,
): PluginEventSourceDeclaration {
  return {
    family,
    label: `A walk ${family} item happens`,
    keyFormat: `${family}:<item>`,
    examples: [`${family}:X-1`],
    approval,
    validate: (target) =>
      /^[A-Z]-[0-9]+$/.test(target) ? null : "expected <letter>-<number>",
    describe: (target) => `${family} ${target} happens`,
    poll: polled
      ? {
          everyMs: 60_000,
          check: async (targets) => checkWalkSource(sources, family, targets),
        }
      : null,
    proof: null,
  };
}

function installWalkSources(): WalkSources {
  const sources: WalkSources = {
    fired: new Set(),
    problems: new Set(),
    broken: false,
    pushed: null,
    calls: [],
    failureStreak: new Map(),
    problemStreak: new Map(),
  };

  const declarations = [
    walkSource(sources, "tracker", "none", true),
    walkSource(sources, "deploy", "owner", true),
    walkSource(sources, "hook", "none", false),
  ];

  resetEventSourceHealth();
  setPluginEventSourceBridge({
    list: () =>
      declarations.map((source) => ({ pluginId: WALK_SOURCE_PLUGIN, source })),
    invoke: async (_pluginId, _label, run) => {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  return sources;
}

export function uninstallWalkSources(): void {
  setPluginEventSourceBridge(undefined);
  resetEventSourceHealth();
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];

  if (item === undefined) throw new Error("picked from an empty list");

  return item;
}

export function seedPropertyWorld(
  harness: TestAppHarness,
  hostId: string,
): PropertyWorld {
  const base = seedInboxWorld(harness, hostId);
  const root = seedChat(base);
  const source = seedChat(base);

  const side = seedChat(base, {
    lifecycleOwnerThreadId: root.id,
    visibility: "hidden",
  });

  return {
    ...base,
    chats: { R: root, S: source, C: side },
    turns: new Map([
      [root.id, null],
      [source.id, null],
      [side.id, null],
    ]),
    dispatches: new Map(),
    overrideArmed: new Set(),
    clockSteps: 0,
    sources: installWalkSources(),
  };
}

function ids(world: PropertyWorld): string[] {
  return [world.chats.R.id, world.chats.S.id, world.chats.C.id];
}

function roleOf(world: PropertyWorld, threadId: string): Role | "-" {
  for (const role of ["R", "S", "C"] as const)
    if (world.chats[role].id === threadId) return role;

  return "-";
}

function rootOf(world: PropertyWorld, role: Role): Role {
  return role === "C" ? "R" : role;
}

function familyOf(world: PropertyWorld, role: Role): string[] {
  const root = rootOf(world, role);

  return root === "R"
    ? [world.chats.R.id, world.chats.C.id]
    : [world.chats.S.id];
}

export async function settle(world: PropertyWorld): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));

    for (const id of ids(world))
      await runQueuedMessageDispatch(world.harness.deps, {
        kind: "thread-ready",
        threadId: id,
      });

    await runQueuedMessageDispatch(world.harness.deps, {
      kind: "time-reached",
      now: Date.now(),
    });
  }

  await new Promise((resolve) => setImmediate(resolve));
}

export async function observe(world: PropertyWorld): Promise<Observation> {
  const db = world.harness.db;
  const snap = await snapshot(world);
  const threadRows = new Map<string, ThreadRow>();

  for (const id of ids(world)) {
    const row = db.select().from(threads).where(eq(threads.id, id)).get();

    if (row !== undefined) threadRows.set(id, row);
  }

  return {
    now: Date.now(),
    snapshot: snap,
    entries: new Map(
      [world.chats.R.id, world.chats.S.id].map((id) => [id, entryOf(snap, id)]),
    ),
    threads: threadRows,
    receipts: db.select().from(threadReceipts).all(),
    waits: db.select().from(threadWaits).all(),
    conditions: db.select().from(threadWaitConditions).all(),
    inputs: db.select().from(threadOwnerInputs).all(),
    failures: db.select().from(threadFailures).all(),
    questions: db.select().from(threadQuestions).all(),
    marks: db.select().from(threadTurnMarks).all(),
    producers: db.select().from(threadProducers).all(),
    queue: new Map(
      ids(world).map((id) => [id, listQueuedThreadMessages(db, id)]),
    ),
    submits: new Map(
      ids(world).map((id) => [
        id,
        listQueuedThreadCommands(world.harness, "turn.submit", id).length,
      ]),
    ),
    turns: new Map(world.turns),
  };
}

function openFailure(obs: Observation, threadId: string): FailureRow | null {
  return (
    obs.failures
      .filter(
        (failure) =>
          failure.threadId === threadId && failure.state !== "resolved",
      )
      .at(-1) ?? null
  );
}

function openWaits(obs: Observation, threadIds: readonly string[]): WaitRow[] {
  return obs.waits.filter(
    (wait) => threadIds.includes(wait.threadId) && wait.status !== "closed",
  );
}

function activeProducer(
  obs: Observation,
  threadId: string,
): ProducerRow | null {
  return (
    obs.producers.find(
      (producer) =>
        producer.threadId === threadId && producer.status === "active",
    ) ?? null
  );
}

function threadRunning(obs: Observation, threadId: string): boolean {
  const row = obs.threads.get(threadId);

  return (
    (row !== undefined && RUNNING.has(row.status)) ||
    (obs.submits.get(threadId) ?? 0) > 0
  );
}

function outstanding(obs: Observation, rootId: string): ReceiptRow[] {
  return obs.receipts.filter(
    (receipt) => receipt.rootThreadId === rootId && receipt.handledAt === null,
  );
}

function isOwnerQueueRow(
  row: ReturnType<typeof listQueuedThreadMessages>[number],
): boolean {
  return (
    row.payloadKind === "inline" &&
    row.senderThreadId === null &&
    row.requestedByInitiator === null &&
    row.systemNotice === null
  );
}

export function checkState(
  world: PropertyWorld,
  obs: Observation,
): Violation[] {
  const violations: Violation[] = [];

  for (const role of ["R", "S"] as const) {
    const root = world.chats[role];
    const row = obs.threads.get(root.id);
    const entry = obs.entries.get(root.id) ?? null;
    const family = familyOf(world, role);

    if (row === undefined) continue;

    if (row.archivedAt !== null) {
      if (outstanding(obs, root.id).length > 0)
        violations.push({
          code: "A2",
          role,
          message: "an archived chat hides outstanding receipts",
        });

      continue;
    }

    if (entry === null) {
      violations.push({
        code: "I1",
        role,
        message: "an unarchived chat has no view",
      });

      continue;
    }

    if (
      (entry.state === "needs-you" || entry.state === "failed") &&
      (!entry.reason.text.trim() || entry.reason.text === "Turn finished")
    )
      violations.push({
        code: "S1",
        role,
        message: `${entry.state} has no concrete reason`,
      });

    const decisions = outstanding(obs, root.id).filter(
      (receipt) => !["result", "problem", "question"].includes(receipt.cause),
    );

    if (
      entry.state === "needs-you" &&
      entry.reason.kind === "decision" &&
      decisions.length > 0 &&
      decisions.every(
        (receipt) =>
          isChatStall(receipt) &&
          !lastTurnStopped(obs, receipt.threadId) &&
          obs.conditions
            .filter((condition) => condition.stallReceiptId === receipt.id)
            .every(
              (condition) =>
                obs.waits.find((wait) => wait.id === condition.waitId)
                  ?.createdBy === "agent",
            ),
      )
    )
      violations.push({
        code: "CS6",
        role,
        message: "Needs you only because another agent waits on this chat",
      });

    const validViews =
      entry.state === "needs-you" ||
      entry.state === "failed" ||
      entry.state === "finished"
        ? ["inbox"]
        : entry.state === "archive"
          ? ["archive"]
          : entry.state === "resting"
            ? ["resting"]
            : ["inbox", "running", "waiting"];

    if (!validViews.includes(entry.view))
      violations.push({
        code: "S2",
        role,
        message: `${entry.state} contradicts ${entry.view}`,
      });

    const working = family.some((id) =>
      RUNNING.has(obs.threads.get(id)?.status ?? ""),
    );

    const rootMark = obs.marks.find(
      (mark) => mark.threadId === root.id && mark.endedAt === null,
    );

    const checking =
      rootMark !== undefined &&
      obs.waits.some(
        (wait) =>
          wait.id === rootMark.waitId &&
          (wait.kind === "check" || wait.kind === "join"),
      ) &&
      !obs.inputs.some(
        (input) =>
          input.threadId === root.id &&
          (input.turnId === rootMark.turnId || input.turnId === null),
      ) &&
      !family.some(
        (id) =>
          id !== root.id && RUNNING.has(obs.threads.get(id)?.status ?? ""),
      );

    const required = obs.questions.some(
      (question) =>
        family.includes(question.threadId) &&
        question.state === "open" &&
        question.mode === "required" &&
        !openWaits(obs, family).some(
          (wait) => wait.kind === "date" && wait.questionId === question.id,
        ),
    );

    const blocked =
      required ||
      openFailure(obs, root.id)?.state === "actionable" ||
      entry.reason.kind === "unverified" ||
      outstanding(obs, root.id).some(
        (receipt) => !["result", "problem", "question"].includes(receipt.cause),
      );

    if (
      working &&
      !checking &&
      !blocked &&
      entry.state !== "working" &&
      entry.state !== "waiting"
    )
      violations.push({
        code: "S3",
        role,
        message: "Working family needs attention without a blocker",
      });

    if (
      row.shelvedAt === null &&
      (entry.view === "waiting" || entry.view === "running")
    ) {
      const owner =
        family.some((id) => threadRunning(obs, id)) ||
        family.some((id) => activeProducer(obs, id) !== null) ||
        openWaits(obs, family).some(
          (wait) =>
            wait.status !== "proposed" &&
            (wait.kind === "report" ||
              (wait.deadline !== null && wait.deadline > obs.now) ||
              wait.status === "dispatched" ||
              wait.status === "evaluating"),
        ) ||
        family.some((id) => {
          const failure = openFailure(obs, id);

          return failure !== null && failure.state !== "actionable";
        }) ||
        family.some((id) =>
          (obs.queue.get(id) ?? []).some(
            (queued) =>
              isOwnerQueueRow(queued) &&
              queued.sendAt !== null &&
              queued.sendAt > obs.now,
          ),
        );

      if (!owner)
        violations.push({
          code: "I2",
          role,
          message: `${entry.view} without a live owner`,
        });
    }

    if (entry.view === "waiting" && entry.waiting?.returnAt === null)
      violations.push({
        code: "I3",
        role,
        message: "a Waiting row has no return time",
      });

    {
      const id = root.id;
      const failure = openFailure(obs, id);

      if (failure?.state === "actionable" && entry.view !== "inbox")
        violations.push({
          code: "I6",
          role,
          message: `an actionable failure in ${roleOf(world, id)} sits in ${entry.view}`,
        });

      if (
        failure?.state === "actionable" &&
        entry.card?.kind === "problem" &&
        (entry.state !== "failed" || entry.reason.kind !== "failure")
      )
        violations.push({
          code: "S4",
          role,
          message: "an actionable failure has no Failed state",
        });

      if (
        failure?.state === "actionable" &&
        entry.view === "inbox" &&
        entry.card?.kind === "problem" &&
        entry.card.primary.kind === "resume" &&
        entry.card.primary.targetThreadId !== id &&
        openFailure(obs, entry.card.primary.targetThreadId)?.state !==
          "actionable"
      )
        violations.push({
          code: "RT1",
          role,
          message: "Resume targets a chat without a failure",
        });
    }

    for (const question of obs.questions.filter(
      (item) =>
        family.includes(item.threadId) &&
        item.state === "open" &&
        item.mode === "required",
    )) {
      const snoozed = openWaits(obs, family).some(
        (wait) => wait.kind === "date" && wait.questionId === question.id,
      );

      if (
        !snoozed &&
        !(
          entry.card?.kind === "question" &&
          entry.card.questionIds.includes(question.id)
        )
      )
        violations.push({
          code: "I7",
          role,
          message: "a pending question has no Question card",
        });

      if (
        snoozed &&
        !(
          entry.view === "waiting" && entry.waiting?.questionId === question.id
        ) &&
        !(entry.view === "inbox" && entry.card?.snoozedQuestionUntil !== null)
      )
        violations.push({
          code: "I7",
          role,
          message: "a snoozed question is visible nowhere",
        });
    }
  }

  for (const receipt of obs.receipts) {
    if (
      !isChatStall(receipt) ||
      receipt.handledAt !== null ||
      obs.threads.get(receipt.rootThreadId)?.archivedAt !== null
    )
      continue;

    const owed = obs.conditions.some(
      (condition) =>
        condition.stallReceiptId === receipt.id &&
        condition.state === "pending" &&
        obs.waits.some(
          (wait) => wait.id === condition.waitId && wait.status !== "closed",
        ),
    );

    if (!owed)
      violations.push({
        code: "CS2",
        role: roleOf(world, receipt.threadId),
        message: "a callback stall outlived the callback it reported",
      });
  }

  for (const producer of obs.producers)
    if (
      producer.status === "active" &&
      producer.heldUntil !== null &&
      producer.heldUntil <= obs.now
    )
      violations.push({
        code: "G1",
        role: roleOf(world, producer.threadId),
        message: "a held goal iteration outlived its 15-minute bound",
      });

  for (const input of obs.inputs) {
    const role = roleOf(world, input.threadId);
    const thread = obs.threads.get(input.threadId);
    const rootRole = role === "-" ? "-" : rootOf(world, role);

    const root =
      rootRole === "-" ? undefined : obs.threads.get(world.chats[rootRole].id);

    if (thread === undefined || root?.archivedAt !== null) continue;

    if (input.state === "running" && !threadRunning(obs, input.threadId))
      violations.push({
        code: "I5",
        role,
        message: "an owner input runs on an idle chat",
      });

    if (
      input.state === "owed" &&
      openFailure(obs, input.threadId) === null &&
      !threadRunning(obs, input.threadId)
    )
      violations.push({
        code: "I5",
        role,
        message: "an owed answer has no failure to resume",
      });

    if (
      input.state === "handed-off" &&
      !obs.producers.some(
        (producer) =>
          producer.id === input.producerId && producer.status === "active",
      )
    )
      violations.push({
        code: "I5",
        role,
        message: "a handed-off input lost its producer",
      });

    if (
      input.state === "covered" &&
      !obs.receipts.some((receipt) => receipt.id === input.receiptId)
    )
      violations.push({
        code: "I5",
        role,
        message: "a covered input has no receipt",
      });
  }

  for (const id of ids(world)) {
    const role = roleOf(world, id);
    const rootRole = role === "-" ? "R" : rootOf(world, role);

    if (obs.threads.get(world.chats[rootRole].id)?.archivedAt !== null)
      continue;

    for (const queued of obs.queue.get(id) ?? []) {
      if (!isOwnerQueueRow(queued)) continue;

      if (queued.sendAt !== null && queued.sendAt > obs.now) continue;

      if (!threadRunning(obs, id) && openFailure(obs, id) === null)
        violations.push({
          code: "I5",
          role,
          message: "a queued owner message is stranded",
        });
    }
  }

  for (const wait of obs.waits.filter(
    (item) => item.status === "dispatched" || item.status === "evaluating",
  )) {
    const role = roleOf(world, wait.threadId);

    const queued = (obs.queue.get(wait.threadId) ?? []).some(
      (row) => row.id === wait.dispatchQueuedMessageId,
    );

    if (
      !queued &&
      !threadRunning(obs, wait.threadId) &&
      openFailure(obs, wait.threadId) === null
    )
      violations.push({
        code: "I22",
        role,
        message: `a ${wait.status} wait has no owner`,
      });
  }

  for (const wait of obs.waits) {
    if (wait.dispatchKey === null || wait.dispatchQueuedMessageId === null)
      continue;

    const seen = world.dispatches.get(wait.dispatchKey);

    if (seen === undefined)
      world.dispatches.set(wait.dispatchKey, wait.dispatchQueuedMessageId);
    else if (seen !== wait.dispatchQueuedMessageId)
      violations.push({
        code: "I12",
        role: roleOf(world, wait.threadId),
        message: "one readiness dispatched twice",
      });
  }

  return violations;
}

const OVERRIDES = new Set([
  "send",
  "answer",
  "happened",
  "resume",
  "archive",
  "undo",
]);

export function checkTransition(
  world: PropertyWorld,
  before: Observation,
  event: PropertyEvent,
  after: Observation,
  displayed: readonly string[] | null,
  armedBefore: ReadonlySet<string>,
): Violation[] {
  const violations: Violation[] = [];

  for (const role of ["R", "S"] as const) {
    const id = world.chats[role].id;

    if (
      before.threads.get(id)?.shelvedAt !== after.threads.get(id)?.shelvedAt &&
      event.kind !== "shelf" &&
      event.kind !== "undo"
    )
      violations.push({
        code: "I1",
        role,
        message: `Shelf changed by ${event.kind}`,
      });
  }

  if (displayed !== null) {
    const allowed = new Set(displayed);

    for (const receipt of after.receipts) {
      const prior = before.receipts.find((item) => item.id === receipt.id);

      if (
        prior?.handledAt === null &&
        receipt.handledAt !== null &&
        !allowed.has(receipt.id)
      )
        violations.push({
          code: "I11",
          role: roleOf(world, receipt.rootThreadId),
          message: `${event.kind} handled a receipt it never displayed`,
        });
    }
  }

  for (const failure of before.failures.filter(
    (item) => item.state === "actionable",
  )) {
    const now = after.failures.find((item) => item.id === failure.id);

    if (now?.state !== "resolved") continue;

    const permitted =
      OVERRIDES.has(event.kind) ||
      (event.kind === "start" && armedBefore.has(failure.threadId));

    if (!permitted)
      violations.push({
        code: "F1",
        role: roleOf(world, failure.threadId),
        message: `a failure was cleared by ${event.kind}`,
      });
  }

  for (const id of ids(world)) {
    const failure = openFailure(before, id);
    const grew = (after.submits.get(id) ?? 0) > (before.submits.get(id) ?? 0);

    if (
      failure === null ||
      !grew ||
      event.kind === "start" ||
      event.kind === "steer"
    )
      continue;

    const role = roleOf(world, id);
    const eventRole = "role" in event ? event.role : null;

    const admitted =
      (eventRole === role &&
        (event.kind === "answer" ||
          event.kind === "happened" ||
          event.kind === "resume" ||
          (event.kind === "send" && failure.state !== "held") ||
          (event.kind === "retry" && failure.state !== "actionable"))) ||
      (event.kind === "resume" &&
        rootOf(world, role === "-" ? "R" : role) === eventRole) ||
      ((event.kind === "tick" || event.kind === "grace") &&
        failure.state === "held");

    if (!admitted)
      violations.push({
        code: "I17",
        role,
        message: `${event.kind} started a turn on a paused chat (${failure.state})`,
      });
  }

  const clockMoved = event.kind === "tick" || event.kind === "grace";

  if (clockMoved)
    for (const wait of before.waits.filter(
      (item) => item.kind === "report" && item.status === "live",
    )) {
      if (after.waits.find((item) => item.id === wait.id)?.status === "closed")
        violations.push({
          code: "W1",
          role: roleOf(world, wait.threadId),
          message: "a reminder ended a report-it wait",
        });
    }

  if (clockMoved)
    for (const wait of before.waits.filter(
      (item) => item.kind === "chat" && item.status === "live",
    )) {
      const delivered = before.conditions.some(
        (condition) =>
          condition.waitId === wait.id && condition.state === "met",
      );

      const closed = after.waits.find((item) => item.id === wait.id);

      if (
        delivered &&
        closed?.status === "closed" &&
        closed.closedReason === "deadline"
      )
        violations.push({
          code: "D1",
          role: roleOf(world, wait.threadId),
          message: "a deadline dropped a delivered result",
        });
    }

  if (event.kind === "agent-cancel")
    for (const wait of before.waits.filter(
      (item) =>
        item.status !== "closed" &&
        (item.createdBy === "owner" || item.ownerAccepted),
    )) {
      if (after.waits.find((item) => item.id === wait.id)?.status === "closed")
        violations.push({
          code: "O1",
          role: roleOf(world, wait.threadId),
          message: "an agent cancelled a wait the owner owns",
        });
    }

  if (event.kind === "end" && event.status === "completed") {
    const id = world.chats[event.role].id;
    const rootId = world.chats[rootOf(world, event.role)].id;

    const mark = before.marks.find(
      (item) => item.threadId === id && item.endedAt === null,
    );

    const consumed = before.inputs.filter(
      (input) => input.threadId === id && input.state === "running",
    );

    const newReceipts = outstanding(after, rootId).filter(
      (receipt) => !before.receipts.some((item) => item.id === receipt.id),
    );

    const silentByWait =
      mark !== undefined &&
      (mark.rearmed || mark.metCondition !== null || mark.afterWaitId !== null);

    const goal = activeProducer(before, id);

    const silentByRule =
      silentByWait || (consumed.length === 0 && goal !== null);

    const archived = after.threads.get(rootId)?.archivedAt !== null;

    if (
      !archived &&
      consumed.length === 0 &&
      !silentByWait &&
      goal !== null &&
      id === rootId &&
      after.producers.find((producer) => producer.id === goal.id)?.heldUntil ==
        null
    )
      violations.push({
        code: "G1",
        role: event.role,
        message: "a goal iteration was neither held nor surfaced",
      });

    if (!archived && consumed.length > 0 && newReceipts.length === 0)
      violations.push({
        code: "I5",
        role: event.role,
        message: "a turn that consumed owner input ended without a receipt",
      });

    if (
      !archived &&
      consumed.length === 0 &&
      !silentByRule &&
      event.role !== "C" &&
      newReceipts.length === 0
    )
      violations.push({
        code: "I4",
        role: event.role,
        message: "a root turn ended without a receipt",
      });

    if (consumed.length === 0 && mark?.rearmed === true) {
      const beforeRoot = before.threads.get(rootId);
      const afterRoot = after.threads.get(rootId);

      if (
        newReceipts.length > 0 ||
        beforeRoot?.latestAttentionAt !== afterRoot?.latestAttentionAt ||
        beforeRoot?.lastReadAt !== afterRoot?.lastReadAt
      )
        violations.push({
          code: "I9",
          role: event.role,
          message: "a negative check raised attention",
        });
    }
  }

  if (event.kind === "goal-verdict") {
    const id = world.chats[event.role].id;
    const rootId = world.chats[rootOf(world, event.role)].id;
    const goal = activeProducer(before, id);

    const newReceipts = outstanding(after, rootId).filter(
      (receipt) => !before.receipts.some((item) => item.id === receipt.id),
    );

    const archived = after.threads.get(rootId)?.archivedAt !== null;

    if (goal !== null && !archived && event.verdict === "unmet") {
      if (newReceipts.length > 0)
        violations.push({
          code: "G2",
          role: event.role,
          message: "an UNMET verdict raised attention",
        });

      if (
        after.producers.find((producer) => producer.id === goal.id)
          ?.heldUntil != null &&
        goal.heldUntil !== null
      )
        violations.push({
          code: "G2",
          role: event.role,
          message: "an UNMET verdict kept the held iteration",
        });
    }

    if (
      goal !== null &&
      !archived &&
      (event.verdict === "met" ||
        event.verdict === "limit" ||
        event.verdict === "failed" ||
        goal.heldUntil !== null) &&
      event.verdict !== "unmet" &&
      newReceipts.length === 0
    )
      violations.push({
        code: "G2",
        role: event.role,
        message: "a verdict that ended the goal surfaced no card",
      });
  }

  if (event.kind === "deliver") {
    const target = world.chats.R.id;

    const resumed = after.waits.some(
      (wait) =>
        wait.threadId === target &&
        wait.status === "dispatched" &&
        before.waits.some(
          (item) =>
            item.id === wait.id &&
            (item.status === "live" || item.status === "evaluating"),
        ),
    );

    if (
      !resumed &&
      (after.submits.get(target) ?? 0) > (before.submits.get(target) ?? 0)
    )
      violations.push({
        code: "L1",
        role: "R",
        message: "a delivery started a turn",
      });

    if (
      before.threads.get(target)?.archivedAt !== null &&
      after.threads.get(target)?.archivedAt === null
    )
      violations.push({
        code: "L1",
        role: "R",
        message: "a delivery reopened an archived chat",
      });
  }

  if (event.kind === "undo")
    for (const wait of after.waits) {
      const prior = before.waits.find((item) => item.id === wait.id);

      if (
        prior?.status === "closed" &&
        wait.status === "live" &&
        wait.kind !== "report" &&
        wait.deadline !== null &&
        wait.deadline <= after.now
      )
        violations.push({
          code: "U1",
          role: roleOf(world, wait.threadId),
          message: "undo restored an expired wait",
        });
    }

  violations.push(...checkEventTransition(world, before, event, after));
  violations.push(...checkChatStallTransition(world, before, after));

  return violations;
}

function conditionId(condition: ConditionRow): string {
  return `${condition.waitId}|${condition.conditionKey}`;
}

function isChatStall(receipt: ReceiptRow): boolean {
  return receipt.cause === "stall" && receipt.waitId === null;
}

function lastTurnStopped(obs: Observation, threadId: string): boolean {
  const ended = obs.marks
    .filter((mark) => mark.threadId === threadId && mark.endedAt !== null)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];

  return ended?.endedOutcome === "stopped";
}

function checkChatStallTransition(
  world: PropertyWorld,
  before: Observation,
  after: Observation,
): Violation[] {
  const violations: Violation[] = [];
  const known = new Set(before.receipts.map((receipt) => receipt.id));
  const waitAfter = new Map(after.waits.map((wait) => [wait.id, wait]));

  for (const receipt of after.receipts) {
    if (!isChatStall(receipt) || known.has(receipt.id)) continue;

    const role = roleOf(world, receipt.threadId);

    const owners = after.conditions
      .filter((condition) => condition.stallReceiptId === receipt.id)
      .map((condition) => waitAfter.get(condition.waitId)?.createdBy);

    if (
      !owners.some((creator) => creator !== undefined && creator !== "agent") &&
      !lastTurnStopped(after, receipt.threadId)
    )
      violations.push({
        code: "CS1",
        role,
        message: "an agent's callback stall reached the owner",
      });

    if (
      activeProducer(before, receipt.threadId) !== null &&
      activeProducer(after, receipt.threadId) !== null
    )
      violations.push({
        code: "CS3",
        role,
        message: "a callback stall was raised while the source's goal runs",
      });
  }

  const conditionAfter = new Map(
    after.conditions.map((condition) => [conditionId(condition), condition]),
  );

  for (const condition of before.conditions) {
    if (condition.kind !== "chat") continue;

    const next = conditionAfter.get(conditionId(condition));

    if (next === undefined) continue;

    if (
      condition.stallReceiptId !== null &&
      next.stallReceiptId !== condition.stallReceiptId
    )
      violations.push({
        code: "CS4",
        role: roleOf(world, condition.target ?? ""),
        message: "a callback stall was escalated twice",
      });

    if (
      condition.stallReceiptId !== null ||
      next.stallReceiptId !== STALL_ESCALATED_TO_WAITER
    )
      continue;

    const waiterId = waitAfter.get(condition.waitId)?.threadId ?? "";

    const reached =
      (after.submits.get(waiterId) ?? 0) >
        (before.submits.get(waiterId) ?? 0) ||
      (after.queue.get(waiterId)?.length ?? 0) >
        (before.queue.get(waiterId)?.length ?? 0);

    if (!reached)
      violations.push({
        code: "CS5",
        role: roleOf(world, waiterId),
        message: "a callback stall was handed to its waiter without a message",
      });
  }

  return violations;
}

function checkEventTransition(
  world: PropertyWorld,
  before: Observation,
  event: PropertyEvent,
  after: Observation,
): Violation[] {
  const violations: Violation[] = [];
  const { sources } = world;
  const waitBefore = new Map(before.waits.map((wait) => [wait.id, wait]));
  const waitAfter = new Map(after.waits.map((wait) => [wait.id, wait]));

  const conditionAfter = new Map(
    after.conditions.map((condition) => [conditionId(condition), condition]),
  );

  const pendingBefore = before.conditions.filter(
    (condition) =>
      condition.kind === "event" &&
      condition.state === "pending" &&
      condition.target !== null,
  );

  const liveKeys = new Set(
    pendingBefore
      .filter(
        (condition) =>
          waitBefore.get(condition.waitId)?.status === "live" ||
          waitAfter.get(condition.waitId)?.status === "live",
      )
      .map((condition) => condition.target),
  );

  const happened = new Set<string>();

  for (const call of sources.calls) {
    for (const target of call.targets) {
      const key = `${call.family}:${target}`;

      if (!liveKeys.has(key))
        violations.push({
          code: "E2",
          role: "-",
          message: `the ${call.family} source was asked about ${target} with no live wait on it`,
        });

      if (!call.threw && sources.fired.has(key) && !sources.problems.has(key))
        happened.add(key);
    }
  }

  if (event.kind === "event-push" && sources.pushed !== null)
    happened.add(sources.pushed);

  for (const condition of pendingBefore) {
    const wait = waitBefore.get(condition.waitId);

    if (
      condition.target === null ||
      !happened.has(condition.target) ||
      wait?.status !== "live" ||
      waitAfter.get(condition.waitId)?.status === "closed"
    )
      continue;

    if (conditionAfter.get(conditionId(condition))?.state !== "met")
      violations.push({
        code: "E1",
        role: roleOf(world, wait.threadId),
        message: `${condition.target} happened but a live wait on it stayed pending`,
      });
  }

  if (event.kind === "agent-watch") {
    const chatId = world.chats[event.role].id;

    const rootArchived =
      after.threads.get(world.chats[rootOf(world, event.role)].id)
        ?.archivedAt !== null;

    for (const wait of after.waits) {
      if (waitBefore.has(wait.id) || wait.threadId !== chatId) continue;

      const keys = after.conditions
        .filter(
          (condition) =>
            condition.waitId === wait.id && condition.kind === "event",
        )
        .map((condition) => condition.target ?? "");

      if (wait.status !== "proposed" || wait.proposalKind !== "watch")
        violations.push({
          code: "E3",
          role: event.role,
          message: `an agent's wait on ${keys.join(", ")} started ${wait.status} instead of as a watch proposal`,
        });

      const receipt = after.receipts.find(
        (item) => item.cause === "proposal" && item.waitId === wait.id,
      );

      if (
        !rootArchived &&
        (receipt === undefined ||
          !keys.every((key) => receipt.summary.includes(key)))
      )
        violations.push({
          code: "E3",
          role: event.role,
          message: "a watch proposal does not name the key it would check",
        });
    }
  }

  const knownReceipts = new Set(before.receipts.map((receipt) => receipt.id));

  for (const receipt of after.receipts) {
    if (
      receipt.cause !== "stall" ||
      receipt.waitId === null ||
      knownReceipts.has(receipt.id)
    )
      continue;

    for (const condition of after.conditions) {
      if (condition.kind !== "event" || condition.stallReceiptId !== receipt.id)
        continue;

      const key = condition.target ?? "";
      const family = key.split(":")[0] ?? "";

      if (
        (sources.failureStreak.get(family) ?? 0) < 3 &&
        (sources.problemStreak.get(key) ?? 0) < 3
      )
        violations.push({
          code: "E4",
          role: roleOf(world, receipt.threadId),
          message: `a stall receipt for ${key} came before three failed checks in a row`,
        });
    }
  }

  for (const condition of before.conditions) {
    if (condition.kind !== "event" || condition.stallReceiptId === null)
      continue;

    const next = conditionAfter.get(conditionId(condition));

    if (
      next?.stallReceiptId !== null &&
      next?.stallReceiptId !== undefined &&
      next.stallReceiptId !== condition.stallReceiptId
    )
      violations.push({
        code: "E4",
        role: "-",
        message: `${condition.target} was reported stalled twice in one outage`,
      });
  }

  for (const call of sources.calls) {
    if (call.threw) continue;

    for (const target of call.targets) {
      const key = `${call.family}:${target}`;

      if (sources.problems.has(key)) continue;

      for (const condition of after.conditions)
        if (
          condition.kind === "event" &&
          condition.target === key &&
          condition.state === "pending" &&
          condition.stallReceiptId !== null &&
          waitAfter.get(condition.waitId)?.status === "live"
        )
          violations.push({
            code: "E5",
            role: "-",
            message: `${key} checked fine but its wait still reads stalled`,
          });
    }
  }

  return violations;
}

function card(obs: Observation, world: PropertyWorld, role: Role) {
  return obs.entries.get(world.chats[rootOf(world, role)].id) ?? null;
}

function hasPendingTurnRequest(obs: Observation, id: string): boolean {
  return (obs.submits.get(id) ?? 0) > 0;
}

export function enabledEvents(
  world: PropertyWorld,
  obs: Observation,
): PropertyEvent[] {
  const events: PropertyEvent[] = [{ kind: "tick" }];

  if (
    obs.conditions.some(
      (condition) =>
        condition.kind === "chat" &&
        condition.state === "pending" &&
        obs.waits.some(
          (wait) => wait.id === condition.waitId && wait.status === "live",
        ),
    )
  )
    events.push({ kind: "grace" });

  for (const role of ["R", "S"] as const) {
    const other = role === "R" ? "S" : "R";

    if (
      obs.threads.get(world.chats[role].id)?.archivedAt === null &&
      (obs.turns.get(world.chats[other].id) ?? null) !== null
    )
      events.push({ kind: "owner-chat", role });
  }

  for (const role of ["R", "S", "C"] as const) {
    const id = world.chats[role].id;
    const thread = obs.threads.get(id);
    const rootId = world.chats[rootOf(world, role)].id;
    const root = obs.threads.get(rootId);
    const turn = obs.turns.get(id) ?? null;

    if (thread === undefined || root === undefined) continue;

    if (root.archivedAt === null && thread.archivedAt === null) {
      events.push({ kind: "send", role });

      if (role !== "C") events.push({ kind: "send-later", role });

      if (role === "R") events.push({ kind: "tell", role });
    }

    if (hasPendingTurnRequest(obs, id))
      events.push(
        turn === null ? { kind: "start", role } : { kind: "steer", role },
      );

    if (turn !== null && !hasPendingTurnRequest(obs, id)) {
      events.push({ kind: "end", role, status: "completed" });
      events.push({ kind: "end", role, status: "completed" });
      events.push({ kind: "end", role, status: "failed" });
      events.push({ kind: "end", role, status: "interrupted" });
    }

    if (turn !== null && role !== "C") {
      events.push({ kind: "agent-check", role });
      events.push({ kind: "agent-chat", role });
      events.push({ kind: "agent-join", role });
      events.push({ kind: "agent-report", role });
      events.push({ kind: "agent-question", role });
      events.push({ kind: "agent-event", role });
      events.push({ kind: "agent-watch", role });

      const mark = obs.marks.find(
        (item) => item.threadId === id && item.endedAt === null,
      );

      if (mark?.waitId) {
        events.push({ kind: "agent-rearm", role });
        events.push({ kind: "agent-met", role });
      }

      if (openWaits(obs, [id]).length > 0) {
        events.push({ kind: "agent-done", role });
        events.push({ kind: "agent-cancel", role });
      }
    }

    if (role === "S" && turn !== null) events.push({ kind: "deliver", role });

    if (role !== "C" && root.archivedAt === null) {
      if (activeProducer(obs, id) === null)
        events.push({ kind: "goal-start", role });
      else
        for (const verdict of [
          "unmet",
          "met",
          "limit",
          "stopped",
          "failed",
        ] as const)
          events.push({ kind: "goal-verdict", role, verdict });
    }

    if (
      obs.questions.some(
        (item) =>
          item.threadId === id &&
          item.state === "open" &&
          item.mode === "required",
      )
    )
      events.push({ kind: "answer", role });

    if (openFailure(obs, id)?.state === "deciding")
      events.push({ kind: "retry", role });
  }

  for (const role of ["R", "S"] as const) {
    const entry = card(obs, world, role);

    if (entry === null || entry.view === "archive") continue;

    if (entry.card !== null) {
      const primary = entry.card.primary.kind;

      if (primary === "ok")
        events.push(
          { kind: "ok", role, focused: true },
          { kind: "ok", role, focused: false },
        );

      if (entry.card.kind !== "question") {
        events.push(
          { kind: "archive", role, focused: true },
          { kind: "archive", role, focused: false },
        );
      }

      if (entry.card.kind !== "question" && entry.card.kind !== "problem") {
        events.push({ kind: "wait", role }, { kind: "wait-report", role });
      }

      if (primary === "accept-proposal") events.push({ kind: "accept", role });

      if (primary === "keep-waiting")
        events.push({ kind: "keep-waiting", role });

      if (primary === "remind-later") events.push({ kind: "remind", role });

      if (primary === "resume") events.push({ kind: "resume", role });
    }

    if (entry.waiting?.group === "on-you" && entry.waiting.waitId !== null)
      events.push({ kind: "happened", role });

    events.push({ kind: "shelf", role });
  }

  if (obs.snapshot.lastMove !== null) events.push({ kind: "undo" });

  events.push(
    { kind: "event-fire" },
    { kind: "event-push" },
    { kind: "event-poll" },
    { kind: "event-problem" },
    world.sources.broken ? { kind: "event-heal" } : { kind: "event-break" },
  );

  return events;
}

async function act(
  world: PropertyWorld,
  request: InboxActRequest,
): Promise<number> {
  const response = await ownerRequest(world, "/inbox/act", request);

  return response.status;
}

function displayedFor(entry: InboxEntry, focused: boolean): string[] {
  const ids = (entry.card?.causes ?? []).map((cause) => cause.receiptId);

  return focused ? ids : ids.slice(0, INBOX_DISPLAY_MAX);
}

async function sendAs(
  world: PropertyWorld,
  role: Role,
  text: string,
  headers: Record<string, string>,
  senderThreadId?: string,
): Promise<number> {
  const response = await world.harness.app.request(
    `/api/v1/threads/${world.chats[role].id}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        input: [{ type: "text", text, mentions: [] }],
        mode: "auto",
        ...(senderThreadId === undefined ? {} : { senderThreadId }),
      }),
    },
  );

  return response.status;
}

const TOLERATED = new Set([200, 201, 400, 404, 409]);

function expectTolerated(status: number, what: string): void {
  if (!TOLERATED.has(status)) throw new Error(`${what} answered ${status}`);
}

export async function applyEvent(
  world: PropertyWorld,
  obs: Observation,
  event: PropertyEvent,
  random: () => number,
): Promise<string[] | null> {
  const now = Date.now();

  switch (event.kind) {
    case "grace": {
      vi.setSystemTime(now + INBOX_STALL_GRACE_MS + 60_000);
      await runInboxSweep(world.harness.deps, Date.now());

      return null;
    }

    case "owner-chat": {
      const id = world.chats[event.role].id;
      const other = event.role === "R" ? world.chats.S.id : world.chats.R.id;

      expectTolerated(
        (
          await ownerRequest(world, `/threads/${id}/waits`, {
            key: `owner-chat-${now}`,
            for: "the other chat's result",
            chats: [other],
          })
        ).status,
        event.kind,
      );

      return null;
    }

    case "tick": {
      world.clockSteps += 1;
      vi.setSystemTime(now + PROPERTY_UNIT_MS);
      await runInboxSweep(world.harness.deps, Date.now());
      await runEventSourcePoll(world.harness.deps, Date.now());

      return null;
    }

    case "agent-event":
    case "agent-watch": {
      const id = world.chats[event.role].id;

      const key =
        event.kind === "agent-watch"
          ? pick(DEPLOY_KEYS, random)
          : pick(random() < 0.7 ? TRACKER_KEYS : HOOK_KEYS, random);

      expectTolerated(
        (
          await agentRequest(world, id, `/threads/${id}/waits`, {
            key: `event-${now}`,
            for: "an outside item happens",
            events: [key],
          })
        ).status,
        event.kind,
      );

      return null;
    }

    case "event-fire": {
      world.sources.fired.add(pick([...TRACKER_KEYS, ...DEPLOY_KEYS], random));

      return null;
    }

    case "event-push": {
      const key = pick(HOOK_KEYS, random);

      world.sources.fired.add(key);

      const response = await world.harness.app.request("/api/v1/inbox/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INBOX_CALLER_PLUGIN_HEADER]: WALK_SOURCE_PLUGIN,
        },
        body: JSON.stringify({ key, result: `${key} happened.` }),
      });

      expectTolerated(response.status, "event-push");

      if (response.status === 200) world.sources.pushed = key;

      return null;
    }

    case "event-poll": {
      vi.setSystemTime(now + EVENT_POLL_STEP_MS);
      await runEventSourcePoll(world.harness.deps, Date.now());

      return null;
    }

    case "event-break":
    case "event-heal": {
      world.sources.broken = event.kind === "event-break";

      return null;
    }

    case "event-problem": {
      const key = pick(TRACKER_KEYS, random);

      if (world.sources.problems.has(key)) world.sources.problems.delete(key);
      else world.sources.problems.add(key);

      return null;
    }

    case "send": {
      const failure = openFailure(obs, world.chats[event.role].id);

      if (failure !== null && failure.state !== "held")
        world.overrideArmed.add(world.chats[event.role].id);

      expectTolerated(
        await sendAs(world, event.role, `owner ${now}`, {}),
        "send",
      );

      return outstanding(obs, world.chats[rootOf(world, event.role)].id).map(
        (receipt) => receipt.id,
      );
    }

    case "send-later": {
      const response = await world.harness.app.request(
        `/api/v1/threads/${world.chats[event.role].id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: `later ${now}`, mentions: [] }],
            mode: "queue-if-active",
            sendAt: now + PROPERTY_UNIT_MS / 2,
          }),
        },
      );

      expectTolerated(response.status, "send-later");

      return null;
    }

    case "tell": {
      expectTolerated(
        await sendAs(
          world,
          "R",
          `note from S ${now}`,
          { [INBOX_CALLER_THREAD_HEADER]: world.chats.S.id },
          world.chats.S.id,
        ),
        "tell",
      );

      return null;
    }

    case "start": {
      const turn = await startSubmittedTurn(world, world.chats[event.role].id);

      world.turns.set(world.chats[event.role].id, turn);
      world.overrideArmed.delete(world.chats[event.role].id);

      return null;
    }

    case "steer": {
      const turn = world.turns.get(world.chats[event.role].id);

      if (turn) await acceptSteer(world, turn);

      return null;
    }

    case "end": {
      const turn = world.turns.get(world.chats[event.role].id);

      if (turn) {
        await endTurn(world, turn, event.status);
        world.turns.set(world.chats[event.role].id, null);
      }

      return null;
    }

    case "agent-check":
    case "agent-chat":
    case "agent-join":
    case "agent-report": {
      const id = world.chats[event.role].id;
      const other = event.role === "R" ? world.chats.S.id : world.chats.R.id;

      const body =
        event.kind === "agent-check"
          ? {
              key: `check-${now}`,
              for: "the deploy finishes",
              check: { what: "deploy status", at: now + PROPERTY_UNIT_MS / 2 },
            }
          : event.kind === "agent-chat"
            ? {
                key: `chat-${now}`,
                for: "the other chat's result",
                chats: [other],
              }
            : event.kind === "agent-join"
              ? {
                  key: `join-${now}`,
                  for: "result and check",
                  chats: [other],
                  check: {
                    what: "deploy status",
                    at: now + PROPERTY_UNIT_MS / 2,
                  },
                }
              : {
                  key: `report-${now}`,
                  for: "the overlap happens again",
                  report: "the overlap happens again",
                };

      expectTolerated(
        (await agentRequest(world, id, `/threads/${id}/waits`, body)).status,
        event.kind,
      );

      return null;
    }

    case "agent-rearm":
    case "agent-met": {
      const id = world.chats[event.role].id;

      const mark = obs.marks.find(
        (item) => item.threadId === id && item.endedAt === null,
      );

      if (!mark?.waitId) return null;

      const path =
        event.kind === "agent-rearm"
          ? `/threads/${id}/waits/${mark.waitId}/rearm`
          : `/threads/${id}/waits/${mark.waitId}/met`;

      expectTolerated(
        (
          await agentRequest(
            world,
            id,
            path,
            event.kind === "agent-met" ? { condition: "check" } : undefined,
          )
        ).status,
        event.kind,
      );

      return null;
    }

    case "agent-done":
    case "agent-cancel": {
      const id = world.chats[event.role].id;
      const waits = openWaits(obs, [id]);
      const wait = waits[Math.floor(random() * waits.length)];

      if (wait === undefined) return null;

      expectTolerated(
        (
          await agentRequest(
            world,
            id,
            `/threads/${id}/waits/${wait.id}/${event.kind === "agent-done" ? "done" : "cancel"}`,
            undefined,
          )
        ).status,
        event.kind,
      );

      return null;
    }

    case "agent-question": {
      const id = world.chats[event.role].id;

      const response = await agentRequest(
        world,
        id,
        `/threads/${id}/attention`,
        {
          action: "open",
          questions: [
            {
              prompt: "Which build?",
              mode: "required",
              options: [
                { value: "a", label: "Fast" },
                { value: "b", label: "Full" },
              ],
            },
          ],
        },
      );

      expectTolerated(response.status, "agent-question");

      return null;
    }

    case "deliver": {
      const marker = obs.waits.find(
        (wait) =>
          wait.threadId === world.chats.R.id &&
          obs.conditions.some(
            (condition) =>
              condition.waitId === wait.id && condition.kind === "chat",
          ),
      )?.marker;

      if (marker === undefined) return null;

      expectTolerated(
        await sendAs(
          world,
          "R",
          `${marker} done: result ${now}`,
          { [INBOX_CALLER_THREAD_HEADER]: world.chats.S.id },
          world.chats.S.id,
        ),
        "deliver",
      );

      return null;
    }

    case "answer": {
      const id = world.chats[event.role].id;

      const question = obs.questions.find(
        (item) =>
          item.threadId === id &&
          item.state === "open" &&
          item.mode === "required",
      );

      if (question === undefined) return null;

      if (openFailure(obs, id)?.state === "actionable")
        world.overrideArmed.add(id);

      const response = await world.harness.app.request(
        `/api/v1/threads/${id}/attention`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "answer",
            id: question.id,
            revision: question.revision,
            answer: { selected: ["a"] },
          }),
        },
      );

      expectTolerated(response.status, "answer");

      return entryDisplayed(obs, world, event.role, true);
    }

    case "retry": {
      const id = world.chats[event.role].id;

      const response = await world.harness.app.request(
        `/api/v1/threads/${id}/retry`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_PLUGIN_HEADER]: "provider-retry",
          },
          body: JSON.stringify({
            turnRequestId: null,
            sendAt: random() < 0.5 ? null : now + PROPERTY_UNIT_MS / 4,
            reason: "Provider overloaded",
          }),
        },
      );

      expectTolerated(response.status, "retry");

      return null;
    }

    case "goal-start": {
      const response = await world.harness.app.request(
        `/api/v1/threads/${world.chats[event.role].id}/producers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_PLUGIN_HEADER]: "pursue",
          },
          body: JSON.stringify({ kind: "goal", label: "Pursuing: the walk" }),
        },
      );

      expectTolerated(response.status, "goal-start");

      return null;
    }

    case "goal-verdict": {
      const id = world.chats[event.role].id;
      const goal = activeProducer(obs, id);

      if (goal === null) return null;

      const response = await world.harness.app.request(
        `/api/v1/threads/${id}/producers/${goal.id}/settle`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_PLUGIN_HEADER]: "pursue",
          },
          body: JSON.stringify({
            verdict: event.verdict,
            summary: `Goal ${event.verdict}`,
          }),
        },
      );

      expectTolerated(response.status, "goal-verdict");

      if (event.verdict === "unmet")
        expectTolerated(
          await sendAs(world, event.role, `[pursue] ${now}`, {
            [INBOX_CALLER_PLUGIN_HEADER]: "pursue",
          }),
          "goal-continue",
        );

      return null;
    }

    case "undo": {
      const moveId = obs.snapshot.lastMove?.moveId;

      if (moveId === undefined) return null;

      expectTolerated(
        (await ownerRequest(world, "/inbox/undo", { moveId })).status,
        "undo",
      );

      return null;
    }

    default:
      return applyCardEvent(world, obs, event, random);
  }
}

function entryDisplayed(
  obs: Observation,
  world: PropertyWorld,
  role: Role,
  focused: boolean,
): string[] {
  const entry = card(obs, world, role);

  return entry === null ? [] : displayedFor(entry, focused);
}

async function applyCardEvent(
  world: PropertyWorld,
  obs: Observation,
  event: Exclude<
    PropertyEvent,
    | {
        kind:
          | "tick"
          | "grace"
          | "owner-chat"
          | "send"
          | "start"
          | "steer"
          | "end"
          | "undo"
          | "answer"
          | "retry"
          | "deliver";
      }
    | { kind: `agent-${string}` }
    | { kind: `goal-${string}` }
    | { kind: `event-${string}` }
  >,
  random: () => number,
): Promise<string[] | null> {
  const entry = card(obs, world, event.role);

  if (entry === null) return null;

  const threadId = entry.threadId;
  const focused = "focused" in event ? event.focused : true;
  const displayedReceiptIds = displayedFor(entry, focused);
  const latch = entry.latch;
  const now = Date.now();
  const primary = entry.card?.primary;

  switch (event.kind) {
    case "ok":
      expectTolerated(
        await act(world, {
          action: "ok",
          threadId,
          displayedReceiptIds,
          latch,
        }),
        "ok",
      );

      return displayedReceiptIds;
    case "archive":
      expectTolerated(
        await act(world, {
          action: "archive",
          threadId,
          displayedReceiptIds,
          stopRunning: false,
          latch,
        }),
        "archive",
      );

      return displayedReceiptIds;
    case "wait":
      expectTolerated(
        await act(world, {
          action: "wait",
          threadId,
          displayedReceiptIds,
          until: now + PROPERTY_UNIT_MS * (1 + Math.floor(random() * 2)),
          latch,
        }),
        "wait",
      );

      return displayedReceiptIds;
    case "wait-report":
      expectTolerated(
        await act(world, {
          action: "wait-report",
          threadId,
          displayedReceiptIds,
          event: "it happens again",
          latch,
        }),
        "wait-report",
      );

      return displayedReceiptIds;
    case "accept":
      if (primary?.kind !== "accept-proposal" || primary.waitId === null)
        return null;
      expectTolerated(
        await act(world, {
          action: "accept-proposal",
          threadId,
          waitId: primary.waitId,
          displayedReceiptIds,
          latch,
        }),
        "accept",
      );

      return displayedReceiptIds;
    case "keep-waiting":
      if (primary?.kind !== "keep-waiting") return null;
      expectTolerated(
        await act(world, {
          action: "keep-waiting",
          threadId,
          waitId: primary.waitId,
          until: now + PROPERTY_UNIT_MS * 2,
          displayedReceiptIds,
          latch,
        }),
        "keep-waiting",
      );

      return displayedReceiptIds;
    case "remind":
      if (primary?.kind !== "remind-later") return null;
      expectTolerated(
        await act(world, {
          action: "remind-later",
          threadId,
          waitId: primary.waitId,
          displayedReceiptIds,
          latch,
        }),
        "remind",
      );

      return displayedReceiptIds;
    case "resume":
      if (primary?.kind !== "resume") return null;
      world.overrideArmed.add(primary.targetThreadId);
      expectTolerated(
        await act(world, {
          action: "resume",
          threadId,
          targetThreadId: primary.targetThreadId,
          displayedReceiptIds,
          latch,
        }),
        "resume",
      );

      return displayedReceiptIds;
    case "happened":
      if (entry.waiting?.waitId == null) return null;
      expectTolerated(
        await act(world, {
          action: "happened",
          threadId,
          waitId: entry.waiting.waitId,
          note: null,
        }),
        "happened",
      );

      return [];
    case "shelf":
      expectTolerated(
        await act(world, {
          action: "shelf",
          threadId,
          shelved: !entry.shelved,
        }),
        "shelf",
      );

      return [];
  }

  return null;
}

function eventWeight(
  event: PropertyEvent,
  obs: Observation,
  world: PropertyWorld,
): number {
  switch (event.kind) {
    case "start":
      return 8;
    case "steer":
      return 4;
    case "end":
      return event.status === "completed"
        ? 2.5
        : event.status === "failed"
          ? 1
          : 0.4;
    case "agent-rearm":
    case "agent-met": {
      const id = world.chats[event.role].id;

      return obs.marks.some(
        (mark) =>
          mark.threadId === id && mark.endedAt === null && mark.waitId !== null,
      )
        ? 5
        : 0;
    }

    case "agent-check":
    case "agent-chat":
      return 1.5;
    case "owner-chat":
      return 0.8;
    case "grace":
      return 2;
    case "retry":
    case "answer":
      return 2;
    case "tick":
      return 2;
    case "shelf":
      return 0.4;
    case "undo":
      return 0.6;
    case "goal-start":
      return 0.5;
    case "goal-verdict":
      return event.verdict === "unmet" ? 1.2 : 0.3;
    case "send-later":
    case "tell":
      return 0.8;
    case "agent-event":
      return 1.5;
    case "event-poll":
      return world.sources.broken ? 3 : 1.5;
    case "agent-watch":
      return 0.8;
    case "event-heal":
      return 0.5;
    case "event-push":
      return 0.6;
    case "event-break":
    case "event-problem":
      return 0.4;
    default:
      return 1;
  }
}

function pickWeighted(
  events: readonly PropertyEvent[],
  obs: Observation,
  world: PropertyWorld,
  random: () => number,
): PropertyEvent | undefined {
  const weights = events.map((event) => eventWeight(event, obs, world));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;

  for (let index = 0; index < events.length; index += 1) {
    roll -= weights[index] ?? 0;

    if (roll < 0) return events[index];
  }

  return events.at(-1);
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WalkResult {
  steps: number;
  violations: { step: number; trace: string[]; violation: Violation }[];
  eventCounts: Map<string, number>;
}

export async function runWalk(
  world: PropertyWorld,
  args: { seed: number; length: number },
): Promise<WalkResult> {
  const random = seededRandom(args.seed);
  const trace: string[] = [];
  const counts = new Map<string, number>();
  let obs = await observe(world);

  for (let step = 0; step < args.length; step += 1) {
    const events = enabledEvents(world, obs);
    const event = pickWeighted(events, obs, world, random);

    if (event === undefined) break;

    trace.push(describeEvent(event));
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);

    const armed = new Set(world.overrideArmed);

    world.sources.calls = [];
    world.sources.pushed = null;

    const displayed = await applyEvent(world, obs, event, random);

    await settle(world);

    const next = await observe(world);

    if (process.env.INBOX_PROPERTY_TRACE)
      console.info(
        JSON.stringify({
          seed: args.seed,
          step,
          event: describeEvent(event),
          failures: next.failures.map((failure) => [
            roleOf(world, failure.threadId),
            failure.state,
            failure.resolvedBy,
          ]),
          inputs: next.inputs.map((input) => [
            roleOf(world, input.threadId),
            input.kind,
            input.state,
          ]),
          statuses: [...next.threads.entries()].map(([id, row]) => [
            roleOf(world, id),
            row.status,
            row.archivedAt === null ? "open" : "archived",
          ]),
          receipts: next.receipts
            .filter((receipt) => receipt.handledAt === null)
            .map((receipt) => [
              roleOf(world, receipt.rootThreadId),
              receipt.cause,
              receipt.id.slice(-6),
            ]),
          lastMove: next.snapshot.lastMove,
          waits: next.waits
            .filter((wait) => wait.status !== "closed")
            .map((wait) => [
              roleOf(world, wait.threadId),
              wait.kind,
              wait.status,
              wait.id.slice(-6),
              wait.dispatchQueuedMessageId?.slice(-6) ?? null,
              wait.dispatchRequestId?.slice(-6) ?? null,
            ]),
          marks: next.marks
            .filter((mark) => mark.endedAt === null)
            .map((mark) => [
              roleOf(world, mark.threadId),
              mark.turnId,
              mark.waitId?.slice(-6) ?? null,
            ]),
          submits: [...next.submits.entries()].map(([id, count]) => [
            roleOf(world, id),
            count,
          ]),
        }),
      );

    const violations = [
      ...checkTransition(world, obs, event, next, displayed, armed),
      ...checkState(world, next),
    ];

    if (violations.length > 0)
      return {
        steps: step + 1,
        violations: violations.map((violation) => ({
          step,
          trace: [...trace],
          violation,
        })),
        eventCounts: counts,
      };

    obs = next;
  }

  return { steps: args.length, violations: [], eventCounts: counts };
}

export function chatThread(world: PropertyWorld, role: Role): Thread | null {
  return getThread(world.harness.db, world.chats[role].id);
}
