// omnyo-plugin-pursue — goals and durable loops for any Omnyo provider.
//
// Two behaviours, both owned by Omnyo's server-side Inbox:
//
//   Goal — the chat's own producer. After every turn, an independent judge
//   thread decides whether the objective is met. Omnyo holds that turn's result
//   for the verdict: UNMET drops it and sends the worker a continuation; MET,
//   the limit or a stop surfaces one card. The worker never grades itself, so
//   it cannot declare victory to stop working.
//
//   Loop — a check wait on the chat. Omnyo wakes the chat with the loop's prompt;
//   a turn that runs `omnyo wait rearm` because nothing changed stays silent and
//   checks again later, and a turn that reports something ends the check, after
//   which pursue opens the next one. Pursue never re-arms by itself.
//
// Both work for every provider (Claude Code, Codex, Pi, ACP) because they
// operate at the Omnyo layer, not inside a provider session.
import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { planRpcContract, planRunsChannel } from "./plan-contract.ts";
import { createPlanService } from "./plans.ts";

const evaluationSchema = z.object({
  ownerThreadId: z.string(),
  goalCreatedAt: z.string(),
  goalRevision: z.number(),
  iteration: z.number(),
  judgeAttempt: z.number().int().min(1).max(2),
  judgeThreadId: z.string().nullable(),
  phase: z.enum(["spawning", "judging", "sending"]),
});

type Evaluation = z.infer<typeof evaluationSchema>;

type JudgeSpawnInput = Parameters<PluginApi["sdk"]["threads"]["spawn"]>[0];

const goalSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  objective: z.string(),
  iterations: z.number(),
  maxIterations: z.number(),
  status: z.enum(["active", "complete", "stopped"]),
  lastVerdict: z.string().nullable(),
  createdAt: z.string(),
  /** Bumped on every edit; a judge's verdict is discarded if it moved. */
  revision: z.number(),
  evaluation: evaluationSchema.optional(),
  /** Omnyo's producer record for this goal; null on an Omnyo without the Inbox API. */
  producerId: z.string().nullable().default(null),
});

type Goal = z.infer<typeof goalSchema>;

/** A loop as stored: its settings and the Omnyo check wait that carries it. */
type Loop = {
  threadId: string;
  prompt: string;
  intervalMs: number;
  /** Checks finished in earlier waits; the current wait adds its own. */
  iterations: number;
  maxIterations: number | null;
  createdAt: string;
  waitId: string;
};

/** Before loops became Omnyo waits they carried their own timer. */
type LegacyLoop = Omit<Loop, "waitId"> & { waitId?: string; nextAtMs?: number };

const loopSchema = z.object({
  threadId: z.string(),
  prompt: z.string(),
  intervalMs: z.number(),
  /** When Omnyo checks next; null while a check is running. */
  nextAtMs: z.number().nullable(),
  iterations: z.number(),
  maxIterations: z.number().nullable(),
  createdAt: z.string(),
});

type LoopView = z.infer<typeof loopSchema>;

type InboxApi = PluginApi["sdk"]["experimental_inbox"];

type GoalVerdict = Parameters<InboxApi["settleProducer"]>[0]["verdict"];

type LoopWorkSignals = Extract<
  Parameters<PluginApi["sdk"]["threads"]["experimental_publishWork"]>[0]["contribution"],
  { kind: "signals" }
>["signals"];

const threadStateSchema = z.object({
  goal: goalSchema.nullable(),
  loop: loopSchema.nullable(),
});

/** Frontend ↔ backend contract for the thread-header control. */
export const rpcContract = defineRpcContract({
  pursue_state: {
    input: z.object({ threadId: z.string() }),
    output: threadStateSchema,
  },
  pursue_goals: {
    input: z.object({ threadIds: z.array(z.string()).max(200) }),
    output: z.object({ goals: z.record(z.string(), goalSchema) }),
  },
  pursue_edit_goal: {
    input: z.object({
      threadId: z.string(),
      objective: z.string().trim().min(1).max(2000),
    }),
    output: threadStateSchema,
  },
  pursue_clear_goal: {
    input: z.object({ threadId: z.string() }),
    output: threadStateSchema,
  },
  pursue_edit_loop: {
    input: z.object({
      threadId: z.string(),
      prompt: z.string().trim().min(1).max(2000),
    }),
    output: threadStateSchema,
  },
  pursue_clear_loop: {
    input: z.object({ threadId: z.string() }),
    output: threadStateSchema,
  },
});

/** Realtime channel the header control refetches on. */
const PURSUE_CHANGED = "pursue-changed";

const GOALS_KEY = "goals";

const LOOPS_KEY = "loops";

const JUDGES_KEY = "judge-thread-ids";

const DEFAULT_MAX_ITERATIONS = 12;

const JUDGE_TIMEOUT_MS = 240_000;

const JUDGE_POLL_MS = 2_000;

const MIN_INTERVAL_MS = 30_000;

const LOOP_WAIT_KEY = "pursue-loop";

/** Omnyo caps an agent's wait at 30 days after the owner last touched the chat. */
const LOOP_WAIT_MS = 30 * 86_400_000;

const WAIT_FOR_MAX = 60;

const CHECK_WHAT_MAX = 500;

const PRODUCER_LABEL_MAX = 120;

const VERDICT_SUMMARY_MAX = 500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `5m` / `30s` / `2h` / `1d` → milliseconds. Returns null on anything else. */
function parseInterval(raw: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(raw.trim());

  if (match === null) return null;
  const amount = Number(match[1]);

  if (!Number.isFinite(amount) || amount <= 0) return null;

  switch (match[2]) {
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    case "d":
      return amount * 86_400_000;
    default:
      return null;
  }
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;

  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;

  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;

  return `${Math.round(ms / 1_000)}s`;
}

/**
 * What a judge answered.
 *
 * `unreadable` is deliberately not a third flavour of "unmet": a judge that
 * cannot say MET or UNMET has told us nothing about the workspace, and nudging
 * the worker on that basis is how a met goal keeps running.
 */
type Verdict = { kind: "met" } | { kind: "unmet"; reason: string } | { kind: "unreadable" };

const VERDICT_PREFIX = /^(?:final\s+answer|verdict|answer|result)\s*[:-]\s*/i;

/** Strip the markdown and punctuation a model wraps its one line in. */
function cleanVerdictLine(line: string): string {
  return line
    .replace(/^[\s>*_`#-]+/, "")
    .replace(/[\s*_`]+$/, "")
    .trim();
}

/**
 * Read MET / UNMET out of a judge's answer.
 *
 * Judges are told to answer in one line and mostly do, but they also bold it,
 * fence it, prefix it with "Verdict:" or add a sign-off after it. Reading only
 * the literal last line turns every one of those into "unparseable", which
 * used to mean "unmet" — so an achieved goal kept nudging the worker until it
 * ran out of iterations. Scan the last few lines instead, and accept MET only
 * when the line says nothing but MET, so a sentence like "Met the objective?
 * No." cannot end a goal early.
 */
function parseVerdict(raw: string): Verdict {
  const lines = raw
    .split("\n")
    .map(cleanVerdictLine)
    .filter((line) => line !== "" && !/^`{3,}/.test(line));

  for (const candidate of lines.slice(-4).reverse()) {
    const line = candidate.replace(VERDICT_PREFIX, "");

    if (/^met\b[\s.!]*$/i.test(line)) return { kind: "met" };
    const unmet = /^unmet\b[\s:-]*(.*)$/i.exec(line);

    if (unmet !== null) {
      const reason = (unmet[1] ?? "").replace(/^[\s:*_`-]+/, "").trim();

      return { kind: "unmet", reason: reason === "" ? "no reason given" : reason };
    }
  }

  return { kind: "unreadable" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();

      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export default async function plugin(api: PluginApi) {
  api.agents.configure(({ thread }) => ({
    tools: [],
    skills: ["pursue"],
    instructions:
      thread.experimental_visibility === "visible"
        ? [
            'For authorized work likely to need multiple turns, use omnyo pursue goal "<verifiable finish line>" when an independent check would help.',
            "Check omnyo pursue status first and reuse an existing goal.",
            "Skip quick tasks and open-ended exploration.",
            "If only the owner can unblock the work, clear the active goal with omnyo pursue goal clear and report the exact blocker.",
          ].join(" ")
        : undefined,
  }));

  api.log.info("pursue loaded");
  const lifetime = new AbortController();
  let goalMutation: Promise<void> = Promise.resolve();

  api.onDispose(async () => {
    lifetime.abort();
    await goalMutation;
  });

  const settings = api.settings.define({
    maxIterations: {
      type: "number",
      label: "Default maximum goal iterations",
      default: DEFAULT_MAX_ITERATIONS,
    },
    judgeModel: {
      type: "string",
      label: "Model for judge threads (blank = project default)",
      default: "",
    },
  });

  const { maxIterations: configuredMax, judgeModel } = await settings.get();

  const parsedMax = z.number().positive().safeParse(configuredMax);
  const defaultMax = parsedMax.success ? Math.floor(parsedMax.data) : DEFAULT_MAX_ITERATIONS;

  const plans = createPlanService(api, async (threadId, projectId, objective) => {
    await mutateGoal(
      threadId,
      async (current) =>
        current ?? {
          threadId,
          projectId,
          objective,
          iterations: 0,
          maxIterations: defaultMax,
          status: "active",
          lastVerdict: null,
          createdAt: new Date().toISOString(),
          revision: 0,
          producerId: await startGoalProducer(threadId, objective),
        },
    );
  });

  // Tell the source chat's run bar when one of its plan runs changes state.
  const relayPlanRun = ({
    thread,
  }: {
    thread: { parentThreadId: string | null; originPluginId: string | null };
  }) => {
    if (thread.originPluginId === "pursue" && thread.parentThreadId !== null)
      api.realtime.publish(planRunsChannel, { sourceThreadId: thread.parentThreadId });
  };

  for (const event of [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
  ] as const)
    api.events.on(event, relayPlanRun);

  api.rpc.register(planRpcContract, {
    pursue_plan_runs: plans.runs,
    pursue_plan_preview: plans.preview,
    pursue_plan_execute: plans.execute,
    pursue_plan_defaults: plans.defaults,
    pursue_plan_save_defaults: plans.saveDefaults,
  });

  // ---------------------------------------------------------------- storage

  async function readGoals(): Promise<Record<string, Goal>> {
    await goalMutation;

    return (await api.storage.kv.get<Record<string, Goal>>(GOALS_KEY)) ?? {};
  }

  function mutateGoal(
    threadId: string,
    change: (
      current: Goal | undefined,
    ) => Goal | undefined | null | Promise<Goal | undefined | null>,
  ): Promise<boolean> {
    const mutation = goalMutation.then(async () => {
      if (lifetime.signal.aborted) return false;
      const goals = (await api.storage.kv.get<Record<string, Goal>>(GOALS_KEY)) ?? {};

      if (lifetime.signal.aborted) return false;
      const next = await change(goals[threadId]);

      if (next === null) return false;

      if (next === undefined) delete goals[threadId];
      else goals[threadId] = next;
      await api.storage.kv.set(GOALS_KEY, goals);

      if (!lifetime.signal.aborted) api.realtime.publish(PURSUE_CHANGED, { threadId });

      return true;
    });

    goalMutation = mutation.then(
      () => undefined,
      () => undefined,
    );

    return mutation;
  }

  function sameGoal(current: Goal | undefined, expected: Goal): boolean {
    return (
      current !== undefined &&
      current.threadId === expected.threadId &&
      current.createdAt === expected.createdAt &&
      current.revision === expected.revision &&
      current.iterations === expected.iterations &&
      current.status === expected.status &&
      current.objective === expected.objective &&
      current.maxIterations === expected.maxIterations &&
      sameEvaluation(current.evaluation, expected.evaluation)
    );
  }

  function writeGoal(goal: Goal, expected?: Goal): Promise<boolean> {
    return mutateGoal(goal.threadId, (current) =>
      expected !== undefined && !sameGoal(current, expected) ? null : goal,
    );
  }

  function removeGoal(threadId: string, expected?: Goal): Promise<boolean> {
    return mutateGoal(threadId, (current) =>
      current === undefined || (expected !== undefined && !sameGoal(current, expected))
        ? null
        : undefined,
    );
  }

  const inbox = api.sdk.experimental_inbox;

  // Loop changes read and write one shared map, so they run one at a time.
  let loopMutation: Promise<unknown> = Promise.resolve();

  function withLoops<T>(work: () => Promise<T>): Promise<T> {
    const run = loopMutation.then(work);
    loopMutation = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  async function readLoops(): Promise<Record<string, LegacyLoop>> {
    return (await api.storage.kv.get<Record<string, LegacyLoop>>(LOOPS_KEY)) ?? {};
  }

  async function writeLoop(loop: Loop): Promise<void> {
    const loops = await readLoops();
    loops[loop.threadId] = loop;
    await api.storage.kv.set(LOOPS_KEY, loops);
    api.realtime.publish(PURSUE_CHANGED, { threadId: loop.threadId });
    await publishLoopWork(loop.threadId, true);
  }

  async function removeLoop(threadId: string, { publish = true } = {}): Promise<boolean> {
    const loops = await readLoops();

    if (loops[threadId] === undefined) return false;
    delete loops[threadId];
    await api.storage.kv.set(LOOPS_KEY, loops);
    api.realtime.publish(PURSUE_CHANGED, { threadId });

    if (publish) await publishLoopWork(threadId, false);

    return true;
  }

  // ------------------------------------------------------------ work status

  const threads = api.sdk.threads;

  // Omnyo's shared work status drives the sidebar, the Glance card and Tidy's
  // archive readiness, and it counts only owners that report themselves. A
  // silent loop left its chat reading "Open · Next owner unconfirmed" and
  // eligible for archiving while the loop still owned the next step.
  async function publishLoopWork(threadId: string, live: boolean): Promise<void> {
    const signals: LoopWorkSignals = {
      complete: true,
      validUntil: null,
      activity: [],
      waits: live
        ? [
            {
              id: `pursue-loop:${threadId}`,
              reason: "This chat's loop checks in again by itself.",
              actor: { kind: "agent", id: threadId, label: "This chat's loop" },
            },
          ]
        : [],
      failures: [],
      postponement: null,
    };

    try {
      await threads.experimental_publishWork({
        threadId,
        pluginId: "pursue",
        contribution: { kind: "signals", signals },
      });
    } catch (error) {
      api.log.warn(`loop work status not published for ${threadId}: ${String(error)}`);
    }
  }

  // A judge thread goes idle like any other thread. Without this list its own
  // idle event would be treated as a worker turn and judged recursively.
  async function rememberJudge(threadId: string): Promise<void> {
    const ids = (await api.storage.kv.get<string[]>(JUDGES_KEY)) ?? [];
    await api.storage.kv.set(JUDGES_KEY, [...ids, threadId].slice(-200));
  }

  async function isJudge(threadId: string): Promise<boolean> {
    const ids = (await api.storage.kv.get<string[]>(JUDGES_KEY)) ?? [];

    return ids.includes(threadId);
  }

  // --------------------------------------------------------------- producer

  // Omnyo holds each iteration's result for the judge's verdict, so a goal that
  // keeps working stays in Running instead of raising a card per turn.
  async function startGoalProducer(threadId: string, objective: string): Promise<string | null> {
    const { producer } = await inbox.startProducer({
      threadId,
      kind: "goal",
      label: clip(`Pursuing: ${objective}`, PRODUCER_LABEL_MAX),
    });

    return producer.id;
  }

  // A verdict Omnyo fails to record leaves the held result to surface on its own
  // after 15 minutes, so the error is logged rather than retried.
  async function settleGoal(
    goal: Goal,
    verdict: GoalVerdict,
    summary: string,
  ): Promise<"active" | "ended" | null> {
    const producerId = goal.producerId ?? null;

    if (producerId === null) return null;

    try {
      const { producer } = await inbox.settleProducer({
        threadId: goal.threadId,
        producerId,
        verdict,
        summary: clip(summary, VERDICT_SUMMARY_MAX),
      });

      return producer.status;
    } catch (error) {
      api.log.error(`goal verdict ${verdict} not recorded on ${goal.threadId}: ${String(error)}`);

      return null;
    }
  }

  // ------------------------------------------------------------------ judge

  function judgePrompt(goal: Goal, lastAssistantText: string | null): string {
    return [
      "You are judging whether another agent has met an objective. You are read-only:",
      "inspect the workspace if it helps, but change nothing and create nothing.",
      "",
      `OBJECTIVE: ${goal.objective}`,
      "",
      "The worker agent just finished a turn. Its closing message was:",
      "---",
      lastAssistantText ?? "(the worker produced no closing message)",
      "---",
      "",
      "Decide whether the OBJECTIVE is now fully met. Judge the actual state of the",
      "workspace, not the worker's claims about it — verify anything checkable.",
      "",
      "Reply with exactly one line and nothing else:",
      "  MET",
      "or",
      "  UNMET: <one sentence naming what is still missing>",
    ].join("\n");
  }

  function withoutEvaluation(goal: Goal): Goal {
    const updated = { ...goal };
    delete updated.evaluation;

    return updated;
  }

  function sameEvaluation(left: Evaluation | undefined, right: Evaluation | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;

    return (
      left.ownerThreadId === right.ownerThreadId &&
      left.goalCreatedAt === right.goalCreatedAt &&
      left.goalRevision === right.goalRevision &&
      left.iteration === right.iteration &&
      left.judgeAttempt === right.judgeAttempt &&
      left.judgeThreadId === right.judgeThreadId &&
      left.phase === right.phase
    );
  }

  async function boundGoal(evaluation: Evaluation): Promise<Goal | undefined> {
    if (lifetime.signal.aborted) return undefined;
    const goal = (await readGoals())[evaluation.ownerThreadId];

    if (lifetime.signal.aborted) return undefined;
    const iterations = evaluation.iteration + (evaluation.phase === "sending" ? 1 : 0);

    if (
      goal === undefined ||
      goal.threadId !== evaluation.ownerThreadId ||
      goal.createdAt !== evaluation.goalCreatedAt ||
      goal.revision !== evaluation.goalRevision ||
      goal.iterations !== iterations ||
      !sameEvaluation(goal.evaluation, evaluation)
    )
      return undefined;

    return goal;
  }

  async function applicableGoal(evaluation: Evaluation): Promise<Goal | undefined> {
    const goal = await boundGoal(evaluation);

    if (goal?.status !== "active") return undefined;
    const owner = await api.sdk.threads.get({ threadId: goal.threadId });

    if (lifetime.signal.aborted || owner.status !== "idle") return undefined;
    const current = await boundGoal(evaluation);

    return current?.status === "active" ? current : undefined;
  }

  async function stopUncertain(evaluation: Evaluation): Promise<void> {
    const goal = await boundGoal(evaluation);
    const action = evaluation.phase === "spawning" ? "judge creation" : "continuation delivery";
    const diagnostic = `${action} outcome uncertain; automatic retry withheld`;

    if (goal === undefined || (goal.status === "stopped" && goal.lastVerdict === diagnostic))
      return;

    if (
      await writeGoal(
        {
          ...goal,
          status: "stopped",
          lastVerdict: diagnostic,
        },
        goal,
      )
    )
      await settleGoal(goal, "failed", `Goal stopped: ${diagnostic}`);
    api.log.error(`${action} outcome uncertain on ${goal.threadId}; not repeated`);
  }

  /** Bind a judge before waiting, and retain its history across reloads. */
  async function runJudge(
    goal: Goal,
    lastAssistantText: string | null,
    retry = false,
  ): Promise<{ evaluation: Evaluation; verdict: Verdict | null } | undefined> {
    let evaluation = goal.evaluation;

    if (evaluation === undefined || retry) {
      const worker = await api.sdk.threads.get({ threadId: goal.threadId });

      if (lifetime.signal.aborted || worker.status !== "idle") return undefined;
      const current = (await readGoals())[goal.threadId];

      if (
        current?.status !== "active" ||
        current.createdAt !== goal.createdAt ||
        current.revision !== goal.revision ||
        current.iterations !== goal.iterations ||
        (goal.evaluation !== undefined && !sameEvaluation(current.evaluation, goal.evaluation))
      )
        return undefined;

      if (worker.environmentId === null) {
        if (
          await writeGoal(
            { ...current, status: "stopped", lastVerdict: "judge unavailable: no environment" },
            current,
          )
        )
          await settleGoal(current, "failed", "Goal stopped: judge unavailable: no environment");

        return undefined;
      }

      evaluation = {
        ownerThreadId: goal.threadId,
        goalCreatedAt: goal.createdAt,
        goalRevision: goal.revision,
        iteration: goal.iterations,
        judgeAttempt: retry ? 2 : 1,
        judgeThreadId: null,
        phase: "spawning",
      };

      if (!(await writeGoal({ ...current, evaluation }, current))) return undefined;

      try {
        const input: JudgeSpawnInput = {
          projectId: goal.projectId,
          environment: { type: "reuse", environmentId: worker.environmentId },
          prompt: judgePrompt(goal, lastAssistantText),
          visibility: "hidden",
          title: `pursue judge: ${goal.objective.slice(0, 40)}`,
        };

        if (judgeModel !== "") input.model = judgeModel;
        const judge = await api.sdk.threads.spawn(input);

        if (lifetime.signal.aborted) return undefined;
        await rememberJudge(judge.id);
        const bound = await boundGoal(evaluation);

        if (bound?.status !== "active") return undefined;
        evaluation = { ...evaluation, judgeThreadId: judge.id, phase: "judging" };

        if (!(await writeGoal({ ...bound, evaluation }, bound))) return undefined;
      } catch (error) {
        if (lifetime.signal.aborted) return undefined;
        api.log.error(`judge creation failed on ${goal.threadId}: ${String(error)}`);
        await stopUncertain(evaluation);

        return undefined;
      }
    }

    if (evaluation.phase !== "judging" || evaluation.judgeThreadId === null) return undefined;

    try {
      // Idle alone is not completion: a newly spawned judge may not have begun.
      const deadline = Date.now() + JUDGE_TIMEOUT_MS;

      while (!lifetime.signal.aborted && Date.now() < deadline) {
        const judge = await api.sdk.threads.get({ threadId: evaluation.judgeThreadId });

        if (lifetime.signal.aborted) return undefined;

        if (judge.status === "error") return { evaluation, verdict: null };

        if (judge.status === "idle") {
          const output = (await api.sdk.threads.output({ threadId: judge.id })).output ?? "";

          if (lifetime.signal.aborted) return undefined;

          if (output.trim() !== "") return { evaluation, verdict: parseVerdict(output) };
        }

        await sleep(JUDGE_POLL_MS, lifetime.signal);
      }

      return lifetime.signal.aborted ? undefined : { evaluation, verdict: null };
    } catch (error) {
      if (lifetime.signal.aborted) return undefined;
      api.log.error(`judge read failed on ${goal.threadId}: ${String(error)}`);

      return { evaluation, verdict: null };
    }
  }

  // Shared by idle events and the one startup pass, never by a second timer.
  const evaluating = new Set<string>();

  async function evaluateGoal(goal: Goal, lastAssistantText: string | null): Promise<void> {
    let result = await runJudge(goal, lastAssistantText);

    if (result === undefined) return;

    if (result.verdict?.kind === "unreadable" && result.evaluation.judgeAttempt === 1) {
      const current = await applicableGoal(result.evaluation);

      if (current === undefined) return;
      result = await runJudge(current, lastAssistantText, true);

      if (result === undefined) return;
    }

    const current = await applicableGoal(result.evaluation);

    if (current === undefined) return;
    const { verdict, evaluation } = result;

    if (verdict === null || verdict.kind === "unreadable") {
      const lastVerdict =
        verdict === null ? "judge unavailable" : "judge returned no clear verdict twice";

      if (
        await writeGoal(
          {
            ...withoutEvaluation(current),
            status: "stopped",
            lastVerdict,
          },
          current,
        )
      )
        await settleGoal(current, "failed", `Goal stopped: ${lastVerdict}`);

      return;
    }

    if (verdict.kind === "met") {
      if (await removeGoal(current.threadId, current)) {
        api.log.info(`goal met on ${current.threadId}, cleared`);
        await settleGoal(current, "met", `Goal met: ${current.objective}`);
      }

      return;
    }

    const iterations = current.iterations + 1;
    const atLimit = iterations >= current.maxIterations;

    const ruled = await settleGoal(
      current,
      atLimit ? "limit" : "unmet",
      atLimit
        ? `Goal stopped after ${current.maxIterations} checks: ${verdict.reason}`
        : verdict.reason,
    );

    // Omnyo ended the producer itself, so a continuation would start work nobody owns.
    if (!atLimit && ruled === "ended") {
      await writeGoal(
        { ...withoutEvaluation(current), status: "stopped", lastVerdict: "goal ended in Omnyo" },
        current,
      );

      return;
    }

    const sending: Evaluation = { ...evaluation, phase: "sending" };

    // SDK send has no idempotency key. Persist intent first; a crash or an
    // ambiguous error leaves a visible stop instead of a duplicate model turn.
    if (
      !(await writeGoal(
        {
          ...current,
          iterations,
          status: atLimit ? "stopped" : "active",
          lastVerdict: atLimit
            ? `iteration limit (${current.maxIterations}) reached: ${verdict.reason}`
            : verdict.reason,
          evaluation: sending,
        },
        current,
      ))
    )
      return;

    if (lifetime.signal.aborted || (await boundGoal(sending)) === undefined) return;

    try {
      await api.sdk.threads.send({
        threadId: current.threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            mentions: [],
            text: atLimit
              ? `[pursue] Goal stopped after ${current.maxIterations} iterations without being met. Still missing: ${verdict.reason}. Report where you got to and what is blocking it — do not keep going.`
              : [
                  `[pursue] Goal not met yet (check ${iterations}/${current.maxIterations}).`,
                  `Still missing: ${verdict.reason}`,
                  "",
                  `Keep working toward: ${current.objective}`,
                  "Stop and say so if you are blocked on something only the user can resolve.",
                ].join("\n"),
          },
        ],
      });
    } catch (error) {
      if (lifetime.signal.aborted) return;
      api.log.error(`goal send failed on ${current.threadId}: ${String(error)}`);
      await stopUncertain(sending);

      return;
    }

    const sentGoal = await boundGoal(sending);

    if (sentGoal !== undefined) await writeGoal(withoutEvaluation(sentGoal), sentGoal);
  }

  async function evaluateThread(threadId: string, lastAssistantText: string | null): Promise<void> {
    if (lifetime.signal.aborted || evaluating.has(threadId)) return;
    evaluating.add(threadId);

    try {
      const goal = (await readGoals())[threadId];

      if (goal === undefined) return;

      if (goal.evaluation?.phase === "spawning" || goal.evaluation?.phase === "sending") {
        await stopUncertain(goal.evaluation);

        return;
      }

      if (goal.status !== "active") return;
      const owner = await api.sdk.threads.get({ threadId });

      if (lifetime.signal.aborted || owner.status !== "idle") return;
      await evaluateGoal(goal, lastAssistantText);
    } catch (error) {
      if (!lifetime.signal.aborted)
        api.log.error(`goal evaluation failed on ${threadId}: ${String(error)}`);
    } finally {
      evaluating.delete(threadId);
    }
  }

  async function reconcileGoals(): Promise<void> {
    for (const goal of Object.values(await readGoals())) {
      // A goal set before Omnyo held iterations for verdicts gets its producer now.
      if (goal.status === "active" && (goal.producerId ?? null) === null) {
        try {
          const producerId = await startGoalProducer(goal.threadId, goal.objective);
          await writeGoal({ ...goal, producerId }, goal);
        } catch (error) {
          api.log.error(`goal producer not started on ${goal.threadId}: ${String(error)}`);
        }
      }

      // A pre-repair goal has no trustworthy owner/revision → judge binding.
      // Its legacy recovery requires an exact approved binding, never a title guess.
      if (goal.evaluation !== undefined) void evaluateThread(goal.threadId, null);
    }
  }

  api.events.on("thread.created", async ({ thread }) => {
    await plans.initialize(thread);
  });

  function requireInbox(): InboxApi {
    return inbox;
  }

  // Omnyo owns the timing: it wakes the chat with the loop's prompt, keeps a turn
  // that ran `omnyo wait rearm` silent, and backs off while nothing changes.
  async function armLoop(settings: Omit<Loop, "waitId">, at: number): Promise<Loop> {
    const { wait } = await requireInbox().registerWait({
      threadId: settings.threadId,
      wait: {
        key: LOOP_WAIT_KEY,
        for: clip(`Loop: ${settings.prompt}`, WAIT_FOR_MAX),
        check: { what: clip(settings.prompt, CHECK_WHAT_MAX), at },
        resume: settings.prompt,
        by: Date.now() + LOOP_WAIT_MS,
      },
    });

    return { ...settings, waitId: wait.id };
  }

  async function openLoopWait(threadId: string): Promise<string | null> {
    const { waits } = await requireInbox().waits({ threadId });

    return waits.find((wait) => wait.key === LOOP_WAIT_KEY)?.id ?? null;
  }

  async function cancelLoopWait(threadId: string, waitId: string | undefined): Promise<void> {
    if (waitId === undefined) return;
    const inboxApi = requireInbox();
    const { wait } = await inboxApi.wait({ threadId, waitId });

    if (wait.status !== "closed") await inboxApi.cancelWait({ threadId, waitId });
  }

  /** Bring one loop in line with its Omnyo wait; the wait is the truth. */
  async function reconcileLoop(threadId: string): Promise<Loop | undefined> {
    const stored = (await readLoops())[threadId];

    if (stored === undefined) return undefined;
    const inboxApi = requireInbox();

    if (stored.waitId === undefined) {
      const { nextAtMs, ...settings } = stored;
      const adopted = await openLoopWait(threadId);

      const loop =
        adopted === null
          ? await armLoop(settings, Math.max(nextAtMs ?? 0, Date.now() + 1_000))
          : { ...settings, waitId: adopted };

      await writeLoop(loop);

      return loop;
    }

    const loop: Loop = { ...stored, waitId: stored.waitId };
    const { wait, closedReason } = await inboxApi.wait({ threadId, waitId: loop.waitId });

    if (wait.status !== "closed") {
      if (
        wait.status === "live" &&
        loop.maxIterations !== null &&
        loop.iterations + wait.checkCount >= loop.maxIterations
      ) {
        await inboxApi.cancelWait({ threadId, waitId: loop.waitId });
        await removeLoop(threadId);

        return undefined;
      }

      return loop;
    }

    // A turn that reported something ends the check; any other close (a
    // deadline, a cancel, an archive) ends the loop.
    if (closedReason !== "resumed") {
      await removeLoop(threadId);
      api.log.info(`loop on ${threadId} ended: its wait closed (${closedReason ?? "unknown"})`);

      return undefined;
    }

    const iterations = loop.iterations + wait.checkCount + 1;

    if (loop.maxIterations !== null && iterations >= loop.maxIterations) {
      await removeLoop(threadId);

      return undefined;
    }

    try {
      const next = await armLoop({ ...loop, iterations }, Date.now() + loop.intervalMs);
      await writeLoop(next);

      return next;
    } catch (error) {
      await removeLoop(threadId);
      api.log.error(`loop on ${threadId} ended: Omnyo refused its next check: ${String(error)}`);

      return undefined;
    }
  }

  async function reconcileLoopSafely(threadId: string): Promise<Loop | undefined> {
    try {
      return await withLoops(() => reconcileLoop(threadId));
    } catch (error) {
      api.log.error(`loop reconcile failed on ${threadId}: ${String(error)}`);

      return undefined;
    }
  }

  async function loopView(loop: Loop): Promise<LoopView> {
    const { wait } = await requireInbox().wait({ threadId: loop.threadId, waitId: loop.waitId });

    return {
      threadId: loop.threadId,
      prompt: loop.prompt,
      intervalMs: loop.intervalMs,
      nextAtMs: wait.nextCheckAt,
      iterations: loop.iterations + wait.checkCount,
      maxIterations: loop.maxIterations,
      createdAt: loop.createdAt,
    };
  }

  async function currentLoop(threadId: string): Promise<LoopView | null> {
    const loop = await reconcileLoopSafely(threadId);

    return loop === undefined ? null : await loopView(loop);
  }

  // ----------------------------------------------------------------- events

  api.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (await isJudge(thread.id)) return;
    await plans.initialize(thread);
    await reconcileLoopSafely(thread.id);
    await evaluateThread(thread.id, lastAssistantText);
  });

  // A goal on a thread the user deleted would poke a dead thread forever.
  api.events.on("thread.deleted", async ({ thread }) => {
    await removeGoal(thread.id);
    await withLoops(() => removeLoop(thread.id, { publish: false }));
  });

  // Archive ends the chat's goal in Omnyo, so pursue drops it: no judge runs and
  // no continuation reaches the archived chat. A loop's wait closes with the
  // archive, and Undo reopens it, so the loop follows its wait.
  api.events.on("thread.archived", async ({ thread }) => {
    await removeGoal(thread.id);
  });

  api.background.service("reconcile", {
    async start(signal) {
      await reconcileGoals();

      for (const threadId of Object.keys(await readLoops())) {
        const loop = await reconcileLoopSafely(threadId);

        if (loop !== undefined) await publishLoopWork(threadId, true);
      }

      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  // -------------------------------------------------------------------- RPC

  async function threadState(threadId: string) {
    return {
      goal: (await readGoals())[threadId] ?? null,
      loop: await currentLoop(threadId),
    };
  }

  // The removal queues behind any write in flight, so a verdict being applied
  // re-reads the goal after it and cannot send a continuation for it.
  async function clearGoal(threadId: string): Promise<boolean> {
    let cleared: Goal | undefined;

    const removed = await mutateGoal(threadId, (current) => {
      if (current === undefined) return null;
      cleared = current;

      return undefined;
    });

    if (!removed || cleared === undefined) return false;

    if (cleared.status === "active")
      await settleGoal(cleared, "stopped", `Goal cleared: ${cleared.objective}`);

    return true;
  }

  async function stopLoop(threadId: string): Promise<boolean> {
    return withLoops(async () => {
      const loop = (await readLoops())[threadId];

      if (loop === undefined) return false;
      await cancelLoopWait(threadId, loop.waitId);

      return removeLoop(threadId);
    });
  }

  async function startLoop(settings: Omit<Loop, "waitId">): Promise<Loop> {
    return withLoops(async () => {
      const existing = (await readLoops())[settings.threadId];

      await cancelLoopWait(settings.threadId, existing?.waitId);
      const loop = await armLoop(settings, Date.now() + settings.intervalMs);
      await writeLoop(loop);

      return loop;
    });
  }

  // Judgement is driven by `thread.idle`, so a goal that gains no turn never
  // gets judged again. Setting or retargeting one while the thread sits idle
  // would otherwise stall it forever: nothing else sends the turn whose
  // completion would trigger the next check.
  async function nudgeIfIdle(threadId: string, text: string): Promise<void> {
    const thread = await api.sdk.threads.get({ threadId });

    if (thread.status !== "idle") return; // a live turn ends in idle by itself
    await api.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", mentions: [], text }],
    });
  }

  api.rpc.register(rpcContract, {
    pursue_state: ({ threadId }) => threadState(threadId),
    pursue_goals: async ({ threadIds }) => {
      const stored = await readGoals();

      return {
        goals: Object.fromEntries(
          threadIds.flatMap((id) => (stored[id] === undefined ? [] : [[id, stored[id]]])),
        ),
      };
    },

    // Editing never touches the thread's turn: the objective lives in plugin
    // state, so a running turn keeps running and the next judgement uses the
    // new text. The revision bump discards any verdict already in flight for
    // the old one.
    pursue_edit_goal: async ({ threadId, objective }) => {
      const goal = (await readGoals())[threadId];

      if (goal === undefined) throw new Error("No goal on this thread.");

      // A retarget is a fresh objective, so it gets a fresh budget. Without
      // this, resuming a goal that stopped at its limit would stop again on
      // the very next unmet verdict.
      const producerId = await startGoalProducer(threadId, objective);

      const updated = await writeGoal(
        {
          ...withoutEvaluation(goal),
          objective,
          iterations: 0,
          status: "active",
          lastVerdict: null,
          revision: goal.revision + 1,
          producerId,
        },
        goal,
      );

      if (!updated) throw new Error("Goal changed while editing; refresh before editing again.");
      await nudgeIfIdle(
        threadId,
        `[pursue] The goal was changed to: ${objective}\nWork toward the new objective.`,
      );

      return threadState(threadId);
    },
    pursue_clear_goal: async ({ threadId }) => {
      await clearGoal(threadId);

      return threadState(threadId);
    },
    // Omnyo refuses new content under a live wait's key, so an edit closes the
    // current check and opens one with the new prompt at the same time.
    pursue_edit_loop: async ({ threadId, prompt }) => {
      await withLoops(async () => {
        const loop = await reconcileLoop(threadId);

        if (loop === undefined) throw new Error("No loop on this thread.");
        const { wait } = await requireInbox().wait({ threadId, waitId: loop.waitId });

        await cancelLoopWait(threadId, loop.waitId);
        await writeLoop(
          await armLoop(
            {
              threadId,
              prompt,
              intervalMs: loop.intervalMs,
              iterations: loop.iterations + wait.checkCount,
              maxIterations: loop.maxIterations,
              createdAt: loop.createdAt,
            },
            wait.nextCheckAt ?? Date.now() + loop.intervalMs,
          ),
        );
      });

      return threadState(threadId);
    },
    pursue_clear_loop: async ({ threadId }) => {
      await stopLoop(threadId);

      return threadState(threadId);
    },
  });

  // -------------------------------------------------------------------- CLI

  const usage = [
    "Usage:",
    "  omnyo pursue plan inspect <path> [--json]      Inspect a linked execution plan",
    "  omnyo pursue plan execute <path> [--selection JSON]  Execute it in a dedicated chat",
    "  omnyo pursue plan defaults [JSON]             Read or save plan model defaults",
    "  omnyo pursue goal <objective...> [--max <n>]   Pursue an objective until a judge says it is met",
    "  omnyo pursue goal clear                        Clear this thread's goal",
    "  omnyo pursue loop <interval> <prompt...>       Wake this thread with a prompt, first after <interval> (30s minimum)",
    "  omnyo pursue loop stop                         Stop this thread's loop",
    "  omnyo pursue status                            Show this thread's goal and loop",
    "  omnyo pursue list [--json]                     Show every active goal and loop",
    "",
    "Intervals are <number><s|m|h|d>, e.g. 30s, 5m, 2h. A check that runs",
    '"omnyo wait rearm" because nothing changed stays silent, and Omnyo then waits',
    "twice as long, up to a day.",
  ].join("\n");

  function describeGoal(goal: Goal): string {
    const verdict = goal.lastVerdict === null ? "" : ` — last check: ${goal.lastVerdict}`;

    return `goal [${goal.status}] ${goal.iterations}/${goal.maxIterations}  ${goal.objective}${verdict}`;
  }

  function describeLoop(loop: LoopView): string {
    const limit = loop.maxIterations === null ? "∞" : String(loop.maxIterations);

    const next =
      loop.nextAtMs === null
        ? "checking now"
        : `next in ${formatMs(Math.max(0, loop.nextAtMs - Date.now()))}`;

    return `loop from ${formatMs(loop.intervalMs)} (${loop.iterations}/${limit}, ${next})  ${loop.prompt}`;
  }

  api.cli.register({
    name: "pursue",
    summary: "Pursue a goal until it is met, or loop a prompt on an interval",
    commands: [
      {
        name: "plan",
        summary: "Inspect or execute a saved plan and configure execution defaults",
        usage:
          "omnyo pursue plan inspect <path> | execute <path> [--selection JSON] | defaults [JSON] [--json]",
      },
      {
        name: "goal",
        summary:
          "Pursue an objective: after each turn an independent judge decides whether it is met, and the thread is nudged onward until it is",
        usage: "omnyo pursue goal <objective...> [--max <n>] | omnyo pursue goal clear",
      },
      {
        name: "loop",
        summary:
          "Wake this thread with a prompt until something changes; Omnyo owns the timing, so it survives thread restarts, unlike an in-session cron",
        usage: "omnyo pursue loop <interval> <prompt...> | omnyo pursue loop stop",
      },
      {
        name: "status",
        summary: "Show this thread's goal and loop",
        usage: "omnyo pursue status",
      },
      {
        name: "list",
        summary: "Show every active goal and loop",
        usage: "omnyo pursue list [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const rest = argv.filter((arg) => arg !== "--json");

      let max: number | null = null;
      const maxIndex = rest.indexOf("--max");

      if (maxIndex !== -1) {
        const value = Number(rest[maxIndex + 1]);

        if (!Number.isFinite(value) || value < 1) {
          return { exitCode: 1, stderr: "--max needs a positive integer." };
        }

        max = Math.floor(value);
        rest.splice(maxIndex, 2);
      }

      const [command, ...args] = rest;
      const threadId = ctx.threadId;

      const needsThread = () => ({
        exitCode: 1,
        stderr: "Run this inside a thread — pursue acts on the calling thread.",
      });

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "plan": {
          const [action, ...parameters] = args;

          if (action === "defaults") {
            try {
              const config =
                parameters.length === 0
                  ? await plans.defaults()
                  : await plans.saveDefaults(
                      planRpcContract.pursue_plan_save_defaults.input.parse(
                        JSON.parse(parameters.join(" ")),
                      ),
                    );

              return { exitCode: 0, stdout: JSON.stringify(config) };
            } catch (cause) {
              return {
                exitCode: 1,
                stderr: cause instanceof Error ? cause.message : "Invalid plan defaults.",
              };
            }
          }

          if (threadId === undefined) return needsThread();

          if (action !== "inspect" && action !== "execute") return { exitCode: 1, stderr: usage };
          const selectionIndex = parameters.indexOf("--selection");

          const href = (
            selectionIndex === -1 ? parameters : parameters.slice(0, selectionIndex)
          ).join(" ");

          if (href === "") return { exitCode: 1, stderr: "Give a local Markdown plan path." };

          try {
            const preview = await plans.preview({ sourceThreadId: threadId, href });

            if (action === "inspect") return { exitCode: 0, stdout: JSON.stringify(preview) };

            if (preview.kind !== "plan")
              return { exitCode: 1, stderr: "This file is not an execution plan." };

            const selection =
              selectionIndex === -1
                ? preview.selection
                : planRpcContract.pursue_plan_execute.input.shape.selection.parse(
                    JSON.parse(parameters.slice(selectionIndex + 1).join(" ")),
                  );

            if (selection === null)
              return {
                exitCode: 1,
                stderr:
                  preview.execution.kind === "complete"
                    ? "This plan is already complete. No new execution was started."
                    : preview.execution.kind === "actionable" ||
                        preview.execution.kind === "running"
                      ? "Plan selection unavailable."
                      : preview.execution.message,
              };

            const result = await plans.execute({
              sourceThreadId: threadId,
              href,
              sha256: preview.sha256,
              environmentId: preview.environmentId,
              selection,
              requestId: crypto.randomUUID(),
            });

            return { exitCode: result.kind === "started" ? 0 : 1, stdout: JSON.stringify(result) };
          } catch (cause) {
            return {
              exitCode: 1,
              stderr: cause instanceof Error ? cause.message : "Plan actions are unavailable.",
            };
          }
        }

        case "goal": {
          if (threadId === undefined) return needsThread();

          if (args[0] === "clear") {
            const removed = await clearGoal(threadId);

            return {
              exitCode: 0,
              stdout: removed ? "Goal cleared." : "No goal on this thread.",
            };
          }

          const objective = args.join(" ").trim();

          if (objective === "") {
            return { exitCode: 1, stderr: "Give an objective. " + usage };
          }

          const thread = await api.sdk.threads.get({ threadId });
          const producerId = await startGoalProducer(threadId, objective);

          const goal: Goal = {
            threadId,
            projectId: thread.projectId,
            objective,
            iterations: 0,
            maxIterations: max ?? defaultMax,
            status: "active",
            lastVerdict: null,
            createdAt: new Date().toISOString(),
            revision: 0,
            producerId,
          };

          await writeGoal(goal);

          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(goal)
              : `Goal set (max ${goal.maxIterations} checks): ${objective}\nA judge will check after each turn; clear it with "omnyo pursue goal clear".`,
          };
        }

        case "loop": {
          if (threadId === undefined) return needsThread();

          if (args[0] === "stop") {
            const removed = await stopLoop(threadId);

            return {
              exitCode: 0,
              stdout: removed ? "Loop stopped." : "No loop on this thread.",
            };
          }

          const intervalMs = parseInterval(args[0] ?? "");

          if (intervalMs === null) {
            return {
              exitCode: 1,
              stderr: `Bad interval "${args[0] ?? ""}". Use 30s, 5m, 2h, 1d.`,
            };
          }

          if (intervalMs < MIN_INTERVAL_MS) {
            return {
              exitCode: 1,
              stderr: `Minimum interval is ${formatMs(MIN_INTERVAL_MS)}.`,
            };
          }

          const prompt = args.slice(1).join(" ").trim();

          if (prompt === "") {
            return { exitCode: 1, stderr: "Give a prompt to loop. " + usage };
          }

          let loop: Loop;

          try {
            loop = await startLoop({
              threadId,
              prompt,
              intervalMs,
              iterations: 0,
              maxIterations: max,
              createdAt: new Date().toISOString(),
            });
          } catch (error) {
            return { exitCode: 1, stderr: `Loop not set: ${String(error)}` };
          }

          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(await loopView(loop))
              : `Loop set: first check in ${formatMs(intervalMs)}${max === null ? "" : `, at most ${max} checks`}. A check that finds nothing new runs "omnyo wait rearm" and stays silent. Stop it with "omnyo pursue loop stop".`,
          };
        }

        case "status": {
          if (threadId === undefined) return needsThread();
          const goal = (await readGoals())[threadId];
          const loop = (await currentLoop(threadId)) ?? undefined;

          if (json)
            return {
              exitCode: 0,
              stdout: JSON.stringify({ goal: goal ?? null, loop: loop ?? null }),
            };

          const lines = [
            goal === undefined ? "No goal on this thread." : describeGoal(goal),
            loop === undefined ? "No loop on this thread." : describeLoop(loop),
          ];

          return { exitCode: 0, stdout: lines.join("\n") };
        }

        case "list": {
          const goals = Object.values(await readGoals());
          const loops: LoopView[] = [];

          for (const id of Object.keys(await readLoops())) {
            const loop = await currentLoop(id);

            if (loop !== null) loops.push(loop);
          }

          if (json) return { exitCode: 0, stdout: JSON.stringify({ goals, loops }) };

          if (goals.length === 0 && loops.length === 0) {
            return { exitCode: 0, stdout: "Nothing being pursued." };
          }

          const lines = [
            ...goals.map((goal) => `${goal.threadId}  ${describeGoal(goal)}`),
            ...loops.map((loop) => `${loop.threadId}  ${describeLoop(loop)}`),
          ];

          return { exitCode: 0, stdout: lines.join("\n") };
        }
      }

      return { exitCode: 1, stderr: usage };
    },
  });
}
