import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    split: { type: "string" },
    until: { type: "string" },
    out: { type: "string" },
    export: { type: "string" },
  },
});

if (!values.db) {
  console.error(
    "Usage: node scripts/baseline.mjs --db PATH [--split YYYY-MM-DD] [--until ISO-TIME] [--out PATH] [--export PATH]",
  );
  process.exit(2);
}

const localMidnight = (day) => new Date(`${day}T00:00:00`).getTime();

const until = values.until ? new Date(values.until).getTime() : Number.MAX_SAFE_INTEGER;

const split = values.split ? localMidnight(values.split) : null;

const db = new DatabaseSync(values.db, { readOnly: true });

const hasAnsweredBy =
  db
    .prepare("select name from pragma_table_info('thread_questions') where name = 'answered_by'")
    .all().length > 0;

const rows = db
  .prepare(
    `select q.id, q.revision, q.thread_id, q.mode, q.state, q.question, q.answer, q.created_at, q.updated_at,
      ${hasAnsweredBy ? "q.answered_by" : "null"} as answered_by, t.title as chat_title, p.name as project
     from thread_questions q join threads t on t.id = q.thread_id join projects p on p.id = t.project_id
     where q.created_at <= ?`,
  )
  .all(until);

const exported = [];

const percentile = (sorted, share) =>
  sorted.length === 0 ? null : sorted[Math.floor(sorted.length * share)];

const rate = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

const emptySlice = () => ({ answered: 0, withRecommendation: 0, choseRecommended: 0 });

const byState = { open: 0, answered: 0, skipped: 0, withdrawn: 0 };

const answeredByMode = { required: 0, optional: 0 };

const recommended = { count: 0, choseRecommended: 0, choseOther: 0, freeTextOnly: 0 };

const slices = { before: emptySlice(), after: emptySlice() };

const perChat = new Map();

const perDay = new Map();

const labels = new Set();

const minutesOpen = [];

let withoutRecommendation = 0;

let withFreeText = 0;

let first = Number.MAX_SAFE_INTEGER;

let last = 0;

for (const row of rows) {
  byState[row.state] += 1;
  perChat.set(row.thread_id, (perChat.get(row.thread_id) ?? 0) + 1);
  const day = new Date(row.created_at).toLocaleDateString("en-CA");
  perDay.set(day, (perDay.get(day) ?? 0) + 1);
  first = Math.min(first, row.created_at);
  last = Math.max(last, row.created_at);

  if (row.state !== "answered" || row.answer === null) continue;
  const question = JSON.parse(row.question);
  const answer = JSON.parse(row.answer);
  const selected = answer.selected ?? [];
  const options = question.options ?? [];
  const pick = options.filter((option) => option.recommended).map((option) => option.value);
  const slice = split === null ? null : row.created_at < split ? slices.before : slices.after;

  answeredByMode[row.mode] += 1;
  labels.add(question.shortLabel ?? "Question");
  exported.push({
    questionId: row.id,
    revision: row.revision,
    threadId: row.thread_id,
    chatTitle: row.chat_title ?? "Untitled chat",
    project: row.project,
    mode: row.mode,
    shortLabel: question.shortLabel ?? "Question",
    prompt: question.prompt,
    context: question.context ?? null,
    multiSelect: question.multiSelect ?? false,
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description ?? null,
      recommended: option.recommended ?? false,
    })),
    chosen: selected,
    freeText: answer.freeText ?? null,
    answeredBy: row.answered_by === null ? null : JSON.parse(row.answered_by),
    createdAt: row.created_at,
  });

  if (answer.freeText) withFreeText += 1;

  if (slice) slice.answered += 1;

  if (options.length > 0) minutesOpen.push((row.updated_at - row.created_at) / 60_000);

  if (pick.length === 0) {
    withoutRecommendation += 1;
    continue;
  }

  const chose = selected.length === pick.length && selected.every((value) => pick.includes(value));
  recommended.count += 1;

  if (slice) slice.withRecommendation += 1;

  if (chose) {
    recommended.choseRecommended += 1;

    if (slice) slice.choseRecommended += 1;
  } else if (selected.length > 0) recommended.choseOther += 1;
  else recommended.freeTextOnly += 1;
}

const sortedMinutes = minutesOpen.toSorted((a, b) => a - b);

const chatCounts = [...perChat.values()].toSorted((a, b) => b - a);

const answered = byState.answered;

const recent = [...perDay.entries()].toSorted(([a], [b]) => a.localeCompare(b)).slice(-14);

const sliceView = (slice) => ({
  ...slice,
  rate: rate(slice.choseRecommended, slice.withRecommendation),
});

const report = {
  window: {
    from: rows.length === 0 ? null : new Date(first).toISOString(),
    to: rows.length === 0 ? null : new Date(last).toISOString(),
  },
  questions: { total: rows.length, byState },
  answeredByMode,
  withRecommendation: {
    ...recommended,
    rateOfAll: rate(recommended.choseRecommended, recommended.count),
    rateWhenAnOptionWasChosen: rate(
      recommended.choseRecommended,
      recommended.count - recommended.freeTextOnly,
    ),
  },
  split:
    split === null
      ? null
      : { at: values.split, before: sliceView(slices.before), after: sliceView(slices.after) },
  withoutRecommendation: {
    count: withoutRecommendation,
    share: rate(withoutRecommendation, answered),
  },
  withFreeText: { count: withFreeText, share: rate(withFreeText, answered) },
  minutesOpenWithOptions: {
    median: percentile(sortedMinutes, 0.5),
    p75: percentile(sortedMinutes, 0.75),
    p90: percentile(sortedMinutes, 0.9),
  },
  distinctShortLabels: labels.size,
  chats: {
    count: chatCounts.length,
    medianQuestions: percentile(chatCounts.toReversed(), 0.5),
    maxQuestions: chatCounts[0] ?? 0,
  },
  perDay: Object.fromEntries(recent),
};

const text = `${JSON.stringify(report, null, 2)}\n`;

if (values.out) writeFileSync(values.out, text);

if (values.export)
  writeFileSync(
    values.export,
    `${JSON.stringify({ until: values.until ?? null, questions: exported })}\n`,
    {
      mode: 0o600,
    },
  );

process.stdout.write(text);
