import {
  threadWaitConditions,
  threadWaits,
  type DbQueryConnection,
} from "@omnyo/db";
import {
  splitEventKey,
  type InboxEventCheckResponse,
  type InboxEventSourceView,
} from "@omnyo/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { invokePluginEventSource } from "../plugins/plugin-event-source-registry.js";
import { writeReceipt } from "./engine.js";
import {
  eventKeyShapeProblem,
  eventSourceHealth,
  eventSourceView,
  findEventSource,
  listEventSources,
  type EventSource,
  type EventSourceHealth,
  type EventSourceOutcome,
} from "./event-sources.js";
import { inboxRootOf } from "./family.js";
import { reportEvent } from "./waits.js";

const CHECK_TIMEOUT_MS = 30_000;

const STALL_AFTER_FAILURES = 3;

const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

const MISSING_SOURCE_RETRY_MS = 60_000;

const RESULT_MAX = 2000;

const STALL_SUMMARY_MAX = 200;

const outcomesSchema = z.array(
  z.union([
    z.object({ target: z.string(), result: z.string().min(1) }),
    z.object({ target: z.string(), problem: z.string().min(1) }),
  ]),
);

interface PendingEventCondition {
  waitId: string;
  threadId: string;
  conditionKey: string;
  key: string;
  family: string;
  target: string;
  stallReceiptId: string | null;
}

type SourceOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function listPendingEventConditions(
  db: DbQueryConnection,
): PendingEventCondition[] {
  return db
    .select({
      waitId: threadWaitConditions.waitId,
      threadId: threadWaits.threadId,
      conditionKey: threadWaitConditions.conditionKey,
      key: threadWaitConditions.target,
      stallReceiptId: threadWaitConditions.stallReceiptId,
    })
    .from(threadWaitConditions)
    .innerJoin(threadWaits, eq(threadWaits.id, threadWaitConditions.waitId))
    .where(
      and(
        eq(threadWaitConditions.kind, "event"),
        eq(threadWaitConditions.state, "pending"),
        eq(threadWaits.status, "live"),
      ),
    )
    .all()
    .flatMap((row) => {
      const parts = row.key === null ? null : splitEventKey(row.key);

      return parts === null || row.key === null
        ? []
        : [
            {
              ...row,
              key: row.key,
              family: parts.family,
              target: parts.target,
            },
          ];
    });
}

async function runSource<T>(
  source: EventSource,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<SourceOutcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<SourceOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        error: `timed out after ${CHECK_TIMEOUT_MS / 1000} seconds`,
      });
    }, CHECK_TIMEOUT_MS);
  });

  const call: Promise<SourceOutcome<T>> =
    source.owner.kind === "plugin"
      ? invokePluginEventSource(source.owner.record, label, () =>
          run(controller.signal),
        ).then((outcome) =>
          outcome.ok
            ? { ok: true as const, value: outcome.value }
            : { ok: false as const, error: outcome.error },
        )
      : run(controller.signal).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }),
        );

  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(
  source: EventSource,
  label: string,
  targets: readonly string[],
): Promise<SourceOutcome<EventSourceOutcome[]>> {
  const poll = source.poll;

  if (poll === null) return { ok: true, value: [] };

  const checked = await runSource(source, label, (signal) =>
    poll.check(targets, { signal }),
  );

  if (!checked.ok) return checked;

  const parsed = outcomesSchema.safeParse(checked.value);

  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error:
          "the source returned something other than a list of { target, result } or { target, problem }",
      };
}

async function ensureProof(
  source: EventSource,
  state: EventSourceHealth,
): Promise<SourceOutcome<null>> {
  const prove = source.proof;

  if (prove === null || state.proof?.ok === true)
    return { ok: true, value: null };

  const proven = await runSource(source, `${source.family} proof`, (signal) =>
    prove({ signal }),
  );

  state.proof = proven.ok
    ? { ok: true, detail: proven.value }
    : { ok: false, detail: proven.error };

  return proven.ok ? { ok: true, value: null } : proven;
}

function recordFailure(
  state: EventSourceHealth,
  error: string,
  now: number,
  everyMs: number,
): void {
  state.consecutiveFailures += 1;
  state.lastError = error;
  state.lastCheckAt = now;
  state.nextPollAt =
    now + Math.min(everyMs * 2 ** state.consecutiveFailures, MAX_BACKOFF_MS);
}

function setStallMarker(
  db: DbQueryConnection,
  member: PendingEventCondition,
  stallReceiptId: string | null,
): void {
  db.update(threadWaitConditions)
    .set({ stallReceiptId })
    .where(
      and(
        eq(threadWaitConditions.waitId, member.waitId),
        eq(threadWaitConditions.conditionKey, member.conditionKey),
      ),
    )
    .run();
}

function raiseStalls(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    members: readonly PendingEventCondition[];
    what: (member: PendingEventCondition) => string;
    error: string;
    now: number;
    changed: Set<string>;
  },
): void {
  deps.db.transaction(
    (tx) => {
      for (const member of args.members) {
        if (member.stallReceiptId !== null) continue;

        const receipt = writeReceipt(tx, {
          threadId: member.threadId,
          cause: "stall",
          summary: clip(
            `Can't check "${args.what(member)}": ${args.error}`,
            STALL_SUMMARY_MAX,
          ),
          outcomeRef: member.waitId,
          waitId: member.waitId,
          coveredInputIds: [],
          now: args.now,
        });

        setStallMarker(tx, member, receipt?.id ?? "none");
        args.changed.add(member.threadId);
      }
    },
    { behavior: "immediate" },
  );
}

function clearStalls(
  deps: LoggedPendingInteractionWorkSessionDeps,
  members: readonly PendingEventCondition[],
): void {
  for (const member of members)
    if (member.stallReceiptId !== null) setStallMarker(deps.db, member, null);
}

async function pollFamily(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    family: string;
    members: readonly PendingEventCondition[];
    now: number;
    changed: Set<string>;
  },
): Promise<void> {
  const { family, members, now, changed } = args;
  const state = eventSourceHealth(family);

  if (state.nextPollAt > now) return;

  const source = listEventSources().find((item) => item.family === family);

  if (source === undefined) {
    const error = `no installed source checks ${family} keys`;

    recordFailure(state, error, now, MISSING_SOURCE_RETRY_MS);

    if (state.consecutiveFailures >= STALL_AFTER_FAILURES)
      raiseStalls(deps, {
        members,
        what: (member) => member.key,
        error,
        now,
        changed,
      });

    return;
  }

  const poll = source.poll;

  if (poll === null) return;

  const failed = (error: string) => {
    recordFailure(state, error, now, poll.everyMs);

    if (state.consecutiveFailures >= STALL_AFTER_FAILURES)
      raiseStalls(deps, {
        members,
        what: (member) => source.describe(member.target),
        error,
        now,
        changed,
      });
  };

  const proven = await ensureProof(source, state);

  if (!proven.ok) {
    failed(proven.error);

    return;
  }

  const targets = [...new Set(members.map((member) => member.target))];
  const checked = await runCheck(source, `${family} check`, targets);

  if (!checked.ok) {
    state.proof = null;
    failed(checked.error);

    return;
  }

  state.consecutiveFailures = 0;
  state.lastCheckAt = now;
  state.lastOkAt = now;
  state.lastError = null;
  state.nextPollAt = now + poll.everyMs;

  for (const target of state.targetProblems.keys())
    if (!targets.includes(target)) state.targetProblems.delete(target);

  for (const target of targets) {
    const waiting = members.filter((member) => member.target === target);
    const outcome = checked.value.find((item) => item.target === target);

    if (outcome !== undefined && "problem" in outcome) {
      const count = (state.targetProblems.get(target)?.count ?? 0) + 1;

      state.targetProblems.set(target, { count, problem: outcome.problem });

      if (count >= STALL_AFTER_FAILURES)
        raiseStalls(deps, {
          members: waiting,
          what: () => source.describe(target),
          error: outcome.problem,
          now,
          changed,
        });

      continue;
    }

    state.targetProblems.delete(target);
    clearStalls(deps, waiting);

    if (outcome === undefined) continue;

    await reportEvent(deps, {
      key: `${family}:${target}`,
      result: clip(outcome.result, RESULT_MAX),
      now,
    });

    for (const member of waiting) changed.add(member.threadId);
  }
}

export async function pollEventSources(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<string[]> {
  const byFamily = new Map<string, PendingEventCondition[]>();

  for (const row of listPendingEventConditions(deps.db))
    byFamily.set(row.family, [...(byFamily.get(row.family) ?? []), row]);

  const changed = new Set<string>();

  for (const [family, members] of byFamily)
    await pollFamily(deps, { family, members, now, changed });

  return [...changed];
}

export async function runEventSourcePoll(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<void> {
  const changed = await pollEventSources(deps, now);

  const roots = new Set(
    changed.map((id) => inboxRootOf(deps.db, id)?.id ?? id),
  );

  for (const id of roots) deps.hub.notifyThread(id, ["work-changed"]);
}

export function listEventSourceViews(
  db: DbQueryConnection,
): InboxEventSourceView[] {
  const counts = new Map<string, number>();

  for (const row of listPendingEventConditions(db))
    counts.set(row.family, (counts.get(row.family) ?? 0) + 1);

  return listEventSources().map((source) =>
    eventSourceView(source, counts.get(source.family) ?? 0),
  );
}

export async function checkEventKey(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { key: string; owner: boolean },
): Promise<InboxEventCheckResponse> {
  const { key } = args;
  const problem = eventKeyShapeProblem(deps.db, key);
  const found = findEventSource(key);

  const base: InboxEventCheckResponse = {
    key,
    family: found?.source.family ?? splitEventKey(key)?.family ?? null,
    valid: problem === null,
    error: problem,
    describe:
      found !== null && problem === null
        ? found.source.describe(found.target)
        : null,
    kind: found === null ? null : found.source.poll === null ? "push" : "poll",
    approval: found?.source.approval ?? null,
    fired: null,
    result: null,
  };

  if (problem !== null || found === null || found.source.poll === null)
    return base;

  const { source, target } = found;

  if (source.approval === "owner" && !args.owner)
    return {
      ...base,
      error: `Only the owner can dry-run ${source.family} keys. A wait on this key asks the owner first.`,
    };

  const proven = await ensureProof(source, eventSourceHealth(source.family));

  if (!proven.ok)
    return {
      ...base,
      valid: false,
      error: `The ${source.family} source cannot check keys: ${proven.error}`,
    };

  const checked = await runCheck(source, `${source.family} dry run`, [target]);

  if (!checked.ok) return { ...base, error: checked.error };

  const outcome = checked.value.find((item) => item.target === target);

  if (outcome !== undefined && "problem" in outcome)
    return { ...base, fired: false, error: outcome.problem };

  return {
    ...base,
    fired: outcome !== undefined,
    result: outcome === undefined ? null : clip(outcome.result, RESULT_MAX),
  };
}
