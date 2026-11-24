import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const BASELINE_DAYS = 7;

const REPORT_DAYS = [3, 7];

const EVENT_LOOKBACK_MS = 2 * DAY;

const ANSWER_FOLLOW_UP_MS = 15 * MINUTE;

const LONG_TURN_AFTER_QUESTION_MS = 30 * MINUTE;

const PAGE_LIMIT = 100;

const MAX_PAGES = 500;

const FETCH_CONCURRENCY = 6;

const FIX_COMMIT = "24323a8d0f";

const REPORT_ENVIRONMENT = "/Users/developer/projects/fastloop";

const REPORT_MACHINE = "host_0000000002";

const PLAN_PATH =
  "/Users/developer/projects/fastloop/docs/execplans/2026-10-29-reduce-bb-agent-time-sinks.md";

const TURN_EVENT_TYPES = [
  "turn/started",
  "turn/completed",
  "system/thread/interrupted",
];

const INTERACTION_EVENT_TYPES = [
  "system/interaction/lifecycle",
  "system/userQuestion/lifecycle",
  "system/permissionGrant/lifecycle",
];

const OPEN_INTERACTION_STATUSES = new Set(["pending", "resolving"]);

const STATE_FILE = "claude-question-savings-state.json";

export function mergeIntervals(intervals) {
  const merged = [];

  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue;
    const last = merged.at(-1);

    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  return merged;
}

export function totalMs(intervals) {
  return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + b - a, 0);
}

export function intersectIntervals(left, right) {
  const a = mergeIntervals(left);
  const b = mergeIntervals(right);
  const result = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);

    if (end > start) result.push([start, end]);

    if (a[i][1] < b[j][1]) i += 1;
    else j += 1;
  }

  return result;
}

function clip(start, end, window) {
  const from = Math.max(start, window.from);
  const to = Math.min(end, window.to);

  return to > from ? [from, to] : null;
}

export function turnIntervals(events, window) {
  const open = new Map();
  const spans = [];

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const turnId = event.scope?.turnId ?? null;

    if (event.type === "turn/started" && turnId)
      open.set(turnId, event.createdAt);
    else if (event.type === "turn/completed" && turnId && open.has(turnId)) {
      spans.push([open.get(turnId), event.createdAt]);
      open.delete(turnId);
    } else if (event.type === "system/thread/interrupted") {
      for (const start of open.values()) spans.push([start, event.createdAt]);
      open.clear();
    }
  }

  for (const start of open.values()) spans.push([start, window.to]);

  return mergeIntervals(
    spans.map(([a, b]) => clip(a, b, window)).filter((span) => span !== null),
  );
}

function interactionRecord(event) {
  const data = event.data ?? {};

  if (event.type === "system/interaction/lifecycle") {
    const interaction = data.interaction ?? {};

    return {
      id: interaction.id,
      status: interaction.status,
      kind: interaction.payload?.kind ?? null,
      providerId: interaction.origin?.providerId ?? null,
    };
  }

  return {
    id: data.interactionId,
    status: data.status,
    kind:
      event.type === "system/permissionGrant/lifecycle"
        ? "approval"
        : (data.payload?.kind ?? "user_question"),
    providerId: null,
  };
}

export function interactionIntervals(events) {
  const byId = new Map();

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!INTERACTION_EVENT_TYPES.includes(event.type)) continue;
    const record = interactionRecord(event);

    if (!record.id) continue;
    const entry = byId.get(record.id);

    if (!entry) {
      if (record.status !== "pending") continue;
      byId.set(record.id, {
        id: record.id,
        kind: record.kind,
        providerId: record.providerId,
        seq: event.seq,
        start: event.createdAt,
        end: null,
      });
    } else if (
      entry.end === null &&
      !OPEN_INTERACTION_STATUSES.has(record.status)
    ) {
      entry.end = event.createdAt;
    }
  }

  return [...byId.values()];
}

export function durableQuestionIntervals(questions) {
  return questions.map((question) => ({
    id: question.id,
    state: question.state,
    start: question.createdAt,
    end: question.state === "open" ? null : question.updatedAt,
    answered: question.state === "answered",
  }));
}

export function blockedByQuestionsMs(threads) {
  const points = [];

  for (const thread of threads) {
    for (const [a, b] of thread.turns) points.push([a, 1, 0], [b, -1, 0]);

    for (const [a, b] of thread.held) points.push([a, 0, 1], [b, 0, -1]);
  }

  points.sort((x, y) => x[0] - y[0]);
  let open = 0;
  let held = 0;
  let blocked = 0;
  let last = null;
  let index = 0;

  while (index < points.length) {
    const at = points[index][0];

    if (last !== null && open > 0 && held === open) blocked += at - last;

    while (index < points.length && points[index][0] === at) {
      open += points[index][1];
      held += points[index][2];
      index += 1;
    }

    last = at;
  }

  return blocked;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function windowSpan(entry, window) {
  return clip(entry.start, entry.end ?? window.to, window);
}

function newStats() {
  return { count: 0, turnHeldMs: 0, perQuestionHeldMs: [], answerMs: [] };
}

function addEntry(stats, entry, turns, window) {
  const span = windowSpan(entry, window);

  if (span === null) return 0;
  const held = totalMs(intersectIntervals([span], turns));

  stats.turnHeldMs += held;

  if (entry.start >= window.from) {
    stats.count += 1;
    stats.perQuestionHeldMs.push(held);

    if (entry.end !== null && entry.end <= window.to)
      stats.answerMs.push(entry.end - entry.start);
  }

  return held;
}

function finishStats(stats, days) {
  return {
    count: stats.count,
    perDay: stats.count / days,
    turnHeldHours: stats.turnHeldMs / HOUR,
    turnHeldHoursPerDay: stats.turnHeldMs / HOUR / days,
    medianTurnHeldMinutes:
      stats.perQuestionHeldMs.length > 0
        ? median(stats.perQuestionHeldMs) / MINUTE
        : null,
    medianAnswerMinutes:
      stats.answerMs.length > 0 ? median(stats.answerMs) / MINUTE : null,
  };
}

function statsFor(map, key) {
  if (!map.has(key)) map.set(key, newStats());

  return map.get(key);
}

function finishByProvider(map, days) {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerId, stats]) => [providerId, finishStats(stats, days)]),
  );
}

export function summarizeWindow(threads, window) {
  const days = (window.to - window.from) / DAY;
  const native = new Map();
  const durable = new Map();
  const approvals = newStats();
  const claudeNativeQuestions = [];
  const answersWithoutFollowUp = [];
  const claudeTurnsKeptRunning = [];
  const blockedInputs = [];
  const claudeHeldPerQuestionMs = [];
  let claudeFreedMs = 0;
  let occupiedMs = 0;

  for (const thread of threads) {
    const turns = intersectIntervals(thread.turns, [[window.from, window.to]]);
    const nativeSpans = [];

    occupiedMs += totalMs(turns);

    for (const entry of thread.interactions) {
      if (entry.kind === "approval") {
        addEntry(approvals, entry, turns, window);
        continue;
      }

      if (entry.kind !== "user_question") continue;
      const providerId = entry.providerId ?? thread.providerId ?? "unknown";
      const held = addEntry(statsFor(native, providerId), entry, turns, window);
      const span = windowSpan(entry, window);

      if (span !== null) nativeSpans.push(span);

      if (
        providerId === "claude-code" &&
        entry.start >= window.from &&
        entry.start < window.to
      )
        claudeHeldPerQuestionMs.push(held);

      if (
        providerId === "claude-code" &&
        entry.start >= window.from &&
        entry.start < window.to
      )
        claudeNativeQuestions.push({
          threadId: thread.id,
          visibility: thread.visibility,
          seq: entry.seq,
          startedAt: new Date(entry.start).toISOString(),
          turnHeldMinutes: held / MINUTE,
        });
    }

    for (const entry of thread.durable) {
      const providerId = thread.providerId ?? "unknown";

      const held = addEntry(
        statsFor(durable, providerId),
        entry,
        turns,
        window,
      );

      if (entry.start < window.from || entry.start >= window.to) continue;

      if (providerId === "claude-code") {
        const waitMs =
          Math.min(entry.end ?? window.to, window.to) - entry.start;

        claudeHeldPerQuestionMs.push(held);
        claudeFreedMs += Math.max(0, waitMs - held);
      }

      if (
        entry.answered &&
        entry.end !== null &&
        entry.end + ANSWER_FOLLOW_UP_MS <= window.to
      ) {
        const steered = turns.some(([a, b]) => a <= entry.end && entry.end < b);

        const followed = turns.some(
          ([a]) => a >= entry.end && a <= entry.end + ANSWER_FOLLOW_UP_MS,
        );

        if (!steered && !followed)
          answersWithoutFollowUp.push({
            threadId: thread.id,
            questionId: entry.id,
          });
      }

      if (providerId === "claude-code") {
        const turn = turns.find(
          ([a, b]) => a <= entry.start && entry.start < b,
        );

        if (turn && turn[1] - entry.start > LONG_TURN_AFTER_QUESTION_MS)
          claudeTurnsKeptRunning.push({
            threadId: thread.id,
            questionId: entry.id,
            minutesAfterAsking: (turn[1] - entry.start) / MINUTE,
          });
      }
    }

    blockedInputs.push({ turns, held: intersectIntervals(nativeSpans, turns) });
  }

  const nativeStats = finishByProvider(native, days);
  const durableStats = finishByProvider(durable, days);
  const claudeNative = nativeStats["claude-code"]?.count ?? 0;
  const claudeDurable = durableStats["claude-code"]?.count ?? 0;

  const blockingQuestionTurnHours = Object.values(nativeStats).reduce(
    (sum, stats) => sum + stats.turnHeldHours,
    0,
  );

  const durableTurnHours = Object.values(durableStats).reduce(
    (sum, stats) => sum + stats.turnHeldHours,
    0,
  );

  const blockedMs = blockedByQuestionsMs(blockedInputs);

  return {
    window: {
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
      days,
    },
    threads: threads.length,
    occupiedTurnHours: occupiedMs / HOUR,
    blockingQuestionTurnHours,
    blockingQuestionTurnHoursPerDay: blockingQuestionTurnHours / days,
    durableQuestionTurnHours: durableTurnHours,
    durableQuestionTurnHoursPerDay: durableTurnHours / days,
    nativeQuestions: nativeStats,
    durableQuestions: durableStats,
    claudeQuestionsPerDay: (claudeNative + claudeDurable) / days,
    claudeHeldShare:
      claudeNative + claudeDurable > 0
        ? claudeNative / (claudeNative + claudeDurable)
        : null,
    medianClaudeQuestionTurnMinutes:
      claudeHeldPerQuestionMs.length > 0
        ? median(claudeHeldPerQuestionMs) / MINUTE
        : null,
    claudeFreedHours: claudeFreedMs / HOUR,
    claudeFreedHoursPerDay: claudeFreedMs / HOUR / days,
    claudeDurableShare:
      claudeNative + claudeDurable > 0
        ? claudeDurable / (claudeNative + claudeDurable)
        : null,
    approvals: finishStats(approvals, days),
    blockedByQuestionsHours: blockedMs / HOUR,
    blockedByQuestionsHoursPerDay: blockedMs / HOUR / days,
    guards: {
      claudeNativeQuestions,
      answersWithoutFollowUp,
      claudeTurnsKeptRunning,
    },
  };
}

function formatNumber(value, digits = 1) {
  return value === null || value === undefined ? "n/a" : value.toFixed(digits);
}

function formatChange(before, after) {
  if (
    before === null ||
    after === null ||
    before === undefined ||
    after === undefined
  )
    return "n/a";

  if (before === 0) return after === 0 ? "0%" : "new";

  return `${after >= before ? "+" : ""}${Math.round(((after - before) / before) * 100)}%`;
}

function percent(share) {
  return share === null ? null : share * 100;
}

function table(rows, digits = 1) {
  return [
    "| Metric | Before | After | Change |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(
      ([label, a, b]) =>
        `| ${label} | ${formatNumber(a, digits)} | ${formatNumber(b, digits)} | ${formatChange(a, b)} |`,
    ),
  ];
}

export function renderMarkdown(result) {
  const { before, after } = result;

  const blocking = (summary, providerId) =>
    summary.nativeQuestions[providerId]?.turnHeldHoursPerDay ?? 0;

  const visibleClaudeNative = after.guards.claudeNativeQuestions.filter(
    (entry) => entry.visibility !== "hidden",
  );

  const lines = [
    `# Claude question savings: day ${result.reportDay} after the fix`,
    "",
    `Fix: omnyo ${result.fixCommit}, live on the coordinator from ${result.fixAt} (${result.fixAtSource}).`,
    `Before: ${before.window.from} to ${before.window.to}. After: ${after.window.from} to ${after.window.to}.`,
    `Threads read: ${result.eligible} of ${result.listed} listed; ${result.fetchErrors.length} failed to load.`,
    "",
    "## Did Claude stop holding turns open while it waits?",
    "",
    "These are per-question measures, so busy and quiet weeks compare fairly.",
    "",
    ...table([
      [
        "Share of Claude questions that held their turn open (%)",
        percent(before.claudeHeldShare),
        percent(after.claudeHeldShare),
      ],
      [
        "Median minutes a Claude question kept its turn busy",
        before.medianClaudeQuestionTurnMinutes,
        after.medianClaudeQuestionTurnMinutes,
      ],
    ]),
    "",
    "## Estimated time freed",
    "",
    `Durable Claude questions after the fix waited ${formatNumber(after.claudeFreedHours)} hours for answers without holding a turn (${formatNumber(after.claudeFreedHoursPerDay)} per day). Before the fix, each of those waits would have held its chat busy. This is the saving attributable to the fix.`,
    "",
    "## Before and after, for context",
    "",
    "Day totals swing with workload: on 30 October a dry run with no change at all moved them by 60 to 100%. Treat a difference here as real only when the Codex control row stays roughly flat; rely on the two sections above.",
    "",
    ...table([
      [
        "Turn hours blocked by Claude questions, per day",
        blocking(before, "claude-code"),
        blocking(after, "claude-code"),
      ],
      [
        "Turn hours blocked by Codex questions, per day (control)",
        blocking(before, "codex"),
        blocking(after, "codex"),
      ],
      [
        "Hours per day when only question-blocked chats kept Omnyo busy",
        before.blockedByQuestionsHoursPerDay,
        after.blockedByQuestionsHoursPerDay,
      ],
      [
        "Turn hours after a durable question, per day (agent kept working or waited)",
        before.durableQuestionTurnHoursPerDay,
        after.durableQuestionTurnHoursPerDay,
      ],
      [
        "Claude questions asked per day",
        before.claudeQuestionsPerDay,
        after.claudeQuestionsPerDay,
      ],
      [
        "Occupied turn hours per day (workload)",
        before.occupiedTurnHours / before.window.days,
        after.occupiedTurnHours / after.window.days,
      ],
    ]),
    "",
    "## Guard checks",
    "",
    `- Claude blocking questions in visible chats after the fix: ${visibleClaudeNative.length}. Expected only in plan mode or on a worker without the new runtime.`,
    `- Durable answers with no turn within 15 minutes: ${after.guards.answersWithoutFollowUp.length}. Expected 0.`,
    `- Claude turns still running 30 minutes after a durable question: ${after.guards.claudeTurnsKeptRunning.length}. Independent work is fine; waiting in the turn is not.`,
    `- Threads that failed to load: ${result.fetchErrors.length}. Expected 0; otherwise the numbers are incomplete.`,
    ...visibleClaudeNative
      .slice(0, 20)
      .map(
        (entry) =>
          `  - ${entry.threadId} seq ${entry.seq} at ${entry.startedAt}, held ${formatNumber(entry.turnHeldMinutes)} min`,
      ),
    "",
    "## Limits",
    "",
    "- Plan-mode questions and hidden chats (side chats, workflow workers) still block by design.",
    "- A worker keeps the old blocking behaviour until it installs the new runtime.",
    "- Busy hours caused only by question-blocked chats approximate idle-update blocking across all hosts; they do not prove an update was waiting.",
    "- Estimated time freed assumes each durable question would otherwise have held its turn until answered, as Claude's own tool did.",
  ];

  return `${lines.join("\n")}\n`;
}

async function omnyoJson(args) {
  const { stdout } = await execFileAsync(
    process.env.OMNYO_CLI ?? "omnyo",
    [...args, "--json"],
    {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
    },
  );

  return JSON.parse(stdout);
}

async function getJson(path) {
  const base = process.env.OMNYO_SERVER_URL;

  if (!base)
    throw new Error("OMNYO_SERVER_URL is required to read thread events");

  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);

  return response.json();
}

async function threadEvents(threadId, window) {
  const rows = [];
  let beforeSeq = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      types: [...TURN_EVENT_TYPES, ...INTERACTION_EVENT_TYPES].join(","),
      order: "desc",
      limit: String(PAGE_LIMIT),
    });

    if (beforeSeq !== null) query.set("beforeSeq", String(beforeSeq));
    const batch = await getJson(`/api/v1/threads/${threadId}/events?${query}`);

    if (!Array.isArray(batch))
      throw new Error(`invalid events response for ${threadId}`);
    rows.push(...batch);

    if (batch.length < PAGE_LIMIT) return rows;

    if (
      Math.min(...batch.map((event) => event.createdAt)) <
      window.from - EVENT_LOOKBACK_MS
    )
      return rows;
    beforeSeq = Math.min(...batch.map((event) => event.seq));
  }

  throw new Error(
    `event pagination exceeded ${MAX_PAGES} pages for ${threadId}`,
  );
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;

        next += 1;
        results[index] = await task(items[index]);
      }
    }),
  );

  return results;
}

export async function collectThreads(window) {
  const listed = [
    ...(await omnyoJson(["thread", "list", "--include-hidden"])),
    ...(await omnyoJson(["thread", "list", "--include-hidden", "--archived"])),
  ];

  const unique = [
    ...new Map(listed.map((thread) => [thread.id, thread])).values(),
  ];

  const eligible = unique.filter(
    (thread) =>
      (thread.createdAt ?? 0) < window.to &&
      Math.max(thread.updatedAt ?? 0, thread.lastMessageAt ?? 0) >= window.from,
  );

  const fetchErrors = [];

  const threads = await mapLimit(
    eligible,
    FETCH_CONCURRENCY,
    async (thread) => {
      try {
        const [events, attention] = await Promise.all([
          threadEvents(thread.id, window),
          getJson(`/api/v1/threads/${thread.id}/attention`),
        ]);

        return {
          id: thread.id,
          providerId: thread.providerId ?? null,
          visibility: thread.visibility ?? "visible",
          turns: turnIntervals(events, window),
          interactions: interactionIntervals(events),
          durable: durableQuestionIntervals(attention.questions ?? []),
        };
      } catch (error) {
        fetchErrors.push({
          threadId: thread.id,
          error: error instanceof Error ? error.message : String(error),
        });

        return null;
      }
    },
  );

  return {
    threads: threads.filter((thread) => thread !== null),
    listed: unique.length,
    eligible: eligible.length,
    fetchErrors,
  };
}

export async function measure(window, collect = collectThreads) {
  const collected = await collect(window);

  return {
    ...summarizeWindow(collected.threads, window),
    listed: collected.listed,
    eligible: collected.eligible,
    fetchErrors: collected.fetchErrors,
  };
}

export async function compare({
  fixAt,
  fixAtSource,
  reportDay,
  now,
  collect = collectThreads,
}) {
  const before = { from: fixAt - BASELINE_DAYS * DAY, to: fixAt };
  const after = { from: fixAt, to: Math.min(now, fixAt + reportDay * DAY) };
  const collected = await collect({ from: before.from, to: after.to });

  return {
    fixCommit: FIX_COMMIT,
    fixAt: new Date(fixAt).toISOString(),
    fixAtSource,
    reportDay,
    listed: collected.listed,
    eligible: collected.eligible,
    fetchErrors: collected.fetchErrors,
    before: summarizeWindow(collected.threads, before),
    after: summarizeWindow(collected.threads, after),
  };
}

async function readState(stateDir) {
  try {
    return JSON.parse(await readFile(join(stateDir, STATE_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { reported: [] };
    throw error;
  }
}

async function writeState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function detectFix(cli, now) {
  const providers = await cli(["provider", "list"]);

  const list = Array.isArray(providers)
    ? providers
    : (providers.providers ?? []);

  const claude = list.find((provider) => provider.id === "claude-code");

  if (!claude) throw new Error("claude-code provider is not registered");

  if (claude.capabilities?.supportsNativeUserQuestion !== false) return null;
  const status = await cli(["updates", "app", "status"]);
  const finishedAt = Date.parse(status.lastResult?.finishedAt ?? "");

  const fromLastUpdate =
    status.lastResult?.to?.version === status.current?.version &&
    Number.isFinite(finishedAt);

  return {
    fixAt: fromLastUpdate ? finishedAt : now,
    fixAtSource: fromLastUpdate
      ? `coordinator update to ${status.current.version} finished`
      : "first detection by the scheduled check",
    version: status.current?.version ?? null,
  };
}

export async function runCheck({ stateDir, now, cli, collect, publish }) {
  const state = await readState(stateDir);

  if (state.fixAt === undefined) {
    const fix = await detectFix(cli, now);

    if (fix === null)
      return {
        status: "waiting",
        message:
          "Fix not live yet: claude-code still uses its own blocking question tool.",
      };
    Object.assign(state, fix, { detectedAt: new Date(now).toISOString() });
    await writeState(stateDir, state);
  }

  const published = [];

  for (const day of REPORT_DAYS) {
    if (state.reported.includes(day) || now < state.fixAt + day * DAY) continue;

    const result = await compare({
      fixAt: state.fixAt,
      fixAtSource: state.fixAtSource,
      reportDay: day,
      now,
      collect,
    });

    const jsonPath = join(stateDir, `report-day${day}.json`);
    const markdown = renderMarkdown(result);

    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(stateDir, `report-day${day}.md`), markdown);
    await publish({
      day,
      markdown,
      jsonPath,
      final: day === REPORT_DAYS.at(-1),
    });
    state.reported.push(day);
    await writeState(stateDir, state);
    published.push(day);
  }

  const remaining = REPORT_DAYS.filter((day) => !state.reported.includes(day));

  return {
    status: remaining.length === 0 ? "complete" : "measuring",
    message:
      published.length > 0
        ? `Published the day ${published.join(" and ")} report.`
        : remaining.length === 0
          ? "All reports published."
          : `Fix live since ${new Date(state.fixAt).toISOString()}; next report on day ${remaining[0]}.`,
  };
}

function reportPrompt({ day, markdown, jsonPath, final }) {
  return [
    `Automatic day-${day} check of the Claude durable-question change (omnyo ${FIX_COMMIT}).`,
    `scripts/claude-question-savings.mjs computed the report below. Its raw data is at ${jsonPath}.`,
    "",
    "Tell Alex in plain words, in this order: whether Claude questions stopped holding chats busy, the measured savings against the 7 days before the fix with the report's limits, and any guard check that needs a look. Inspect any listed thread before explaining it. Do not change code, settings or automations.",
    final
      ? `Then record the result in the Outcomes & Retrospective section of ${PLAN_PATH}, tick its observation progress item, and commit and push only that file to the private alexburlis/fastloop repo.`
      : `Then add one dated line with the headline numbers under Progress in ${PLAN_PATH}, and commit and push only that file to the private alexburlis/fastloop repo.`,
    "",
    markdown,
  ].join("\n");
}

async function publishThread({ day, markdown, jsonPath, final }) {
  const projectId = process.env.OMNYO_PROJECT_ID;

  if (!projectId)
    throw new Error("OMNYO_PROJECT_ID is required to publish the report");
  const promptPath = join(dirname(jsonPath), `report-day${day}-prompt.md`);

  await writeFile(promptPath, reportPrompt({ day, markdown, jsonPath, final }));
  await omnyoJson([
    "thread",
    "spawn",
    "--project",
    projectId,
    "--environment",
    REPORT_ENVIRONMENT,
    "--machine",
    REPORT_MACHINE,
    "--title",
    `Claude question savings: day ${day}`,
    "--prompt-file",
    promptPath,
  ]);
}

function argValue(args, name) {
  const index = args.indexOf(name);

  return index >= 0 ? args[index + 1] : undefined;
}

function parseTime(value, name) {
  const parsed = Date.parse(value ?? "");

  if (!Number.isFinite(parsed)) throw new Error(`${name} needs an ISO date`);

  return parsed;
}

export function resolveCommand(argv, env) {
  if (argv.length === 0 && env.OMNYO_AUTOMATION_ID) return ["check"];

  return argv;
}

export function completionPauseArgs(env) {
  if (!env.OMNYO_PROJECT_ID)
    throw new Error("OMNYO_PROJECT_ID is required to pause the automation");

  return [
    "automation",
    "pause",
    env.OMNYO_AUTOMATION_ID,
    "--project",
    env.OMNYO_PROJECT_ID,
  ];
}

async function main(argv) {
  const [command, ...args] = resolveCommand(argv, process.env);
  const out = argValue(args, "--out");

  if (command === "measure") {
    const to = argValue(args, "--to");

    const result = await measure({
      from: parseTime(argValue(args, "--from"), "--from"),
      to: to ? parseTime(to, "--to") : Date.now(),
    });

    if (out) await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    return;
  }

  if (command === "compare") {
    const result = await compare({
      fixAt: parseTime(argValue(args, "--fix-at"), "--fix-at"),
      fixAtSource: "given on the command line",
      reportDay: Number(argValue(args, "--days") ?? BASELINE_DAYS),
      now: Date.now(),
    });

    if (out) await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(renderMarkdown(result));

    return;
  }

  if (command === "check") {
    const result = await runCheck({
      stateDir:
        argValue(args, "--state-dir") ??
        dirname(fileURLToPath(import.meta.url)),
      now: Date.now(),
      cli: omnyoJson,
      collect: collectThreads,
      publish: publishThread,
    });

    if (result.status === "complete" && process.env.OMNYO_AUTOMATION_ID)
      await omnyoJson(completionPauseArgs(process.env));
    process.stdout.write(`${result.message}\n`);

    return;
  }

  throw new Error(
    "usage: claude-question-savings.mjs measure --from ISO [--to ISO] [--out FILE] | compare --fix-at ISO [--days N] [--out FILE] | check [--state-dir DIR]; an Omnyo automation run without arguments runs check",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
