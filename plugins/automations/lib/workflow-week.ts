export interface WorkflowArtifactFile {
  name: string;
  content: string;
}

export interface WorkflowReview {
  outcome: "accepted" | "rejected" | "revise";
  reason: string;
  research?: {
    kind: "openseo";
    keyword: string;
    site: string;
    retrievedAt: string;
  };
}

export interface WorkflowDraft {
  name: string;
  title: string;
  body: string;
  content: string;
  date: string | null;
  review: WorkflowReview | null;
}

export interface WorkflowWeek {
  drafts: WorkflowDraft[];
  timezone: string | null;
  calendarProblem: string | null;
}

export interface WorkflowRunResult {
  contentStatus?: string;
  contentError?: string | null;
}

interface CalendarEntry {
  date: string;
  timezone: string;
  candidateId: string;
}

interface ReviewEntry extends WorkflowReview {
  candidateId: string;
}

const OUTCOMES: readonly string[] = ["accepted", "rejected", "revise"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOutcome(value: unknown): value is WorkflowReview["outcome"] {
  return typeof value === "string" && OUTCOMES.includes(value);
}

function readCalendar(value: unknown): CalendarEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: CalendarEntry[] = [];

  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
      !nonEmpty(item.timezone) ||
      !nonEmpty(item.candidateId)
    )
      return null;
    entries.push({
      date: item.date,
      timezone: item.timezone,
      candidateId: item.candidateId,
    });
  }

  return entries;
}

function readReviews(value: unknown): ReviewEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: ReviewEntry[] = [];

  for (const item of value) {
    if (
      !isRecord(item) ||
      !nonEmpty(item.candidateId) ||
      !isOutcome(item.outcome) ||
      typeof item.reason !== "string"
    )
      return null;
    const research = item.research;

    entries.push({
      candidateId: item.candidateId,
      outcome: item.outcome,
      reason: item.reason,
      ...(typeof item.draftDigest === "string" &&
      /^[a-f0-9]{64}$/.test(item.draftDigest) &&
      isRecord(research) &&
      research.kind === "openseo" &&
      typeof research.keyword === "string" &&
      research.keyword.trim() &&
      typeof research.site === "string" &&
      research.site.trim() &&
      typeof research.retrievedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T.*Z$/.test(research.retrievedAt) &&
      Number.isFinite(Date.parse(research.retrievedAt))
        ? {
            research: {
              kind: research.kind,
              keyword: research.keyword,
              site: research.site,
              retrievedAt: research.retrievedAt,
            },
          }
        : {}),
    });
  }

  return entries;
}

function parseJson<T>(
  file: WorkflowArtifactFile | undefined,
  read: (value: unknown) => T | null,
): { value: T | null; problem: string | null } {
  if (!file) return { value: null, problem: null };
  let raw: unknown;

  try {
    raw = JSON.parse(file.content);
  } catch {
    return { value: null, problem: `${file.name} is not valid JSON.` };
  }

  const value = read(raw);

  return value === null
    ? { value: null, problem: `${file.name} has an unexpected shape.` }
    : { value, problem: null };
}

function splitDraft(content: string): { title: string; body: string } {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  const firstBreak = normalized.indexOf("\n");
  const head = firstBreak === -1 ? normalized : normalized.slice(0, firstBreak);

  if (/^#\s+/.test(head)) {
    return {
      title: head.replace(/^#\s+/, "").trim(),
      body: firstBreak === -1 ? "" : normalized.slice(firstBreak + 1).trim(),
    };
  }

  return { title: "", body: normalized };
}

export function parseWorkflowRunResult(
  output: string | null,
): WorkflowRunResult | null {
  if (output === null) return null;

  let raw: unknown;

  try {
    raw = JSON.parse(output);
  } catch {
    return null;
  }

  if (!isRecord(raw)) return null;
  const { contentStatus, contentError } = raw;

  if (contentStatus !== undefined && typeof contentStatus !== "string")
    return null;

  if (
    contentError !== undefined &&
    contentError !== null &&
    typeof contentError !== "string"
  )
    return null;

  return {
    ...(contentStatus === undefined ? {} : { contentStatus }),
    ...(contentError === undefined ? {} : { contentError }),
  };
}

export function readWorkflowWeek(
  files: readonly WorkflowArtifactFile[],
): WorkflowWeek {
  const calendar = parseJson(
    files.find((file) => file.name === "calendar.json"),
    readCalendar,
  );

  const reviews = parseJson(
    files.find((file) => file.name === "reviews.json"),
    readReviews,
  );

  const dates = new Map(
    (calendar.value ?? []).map((entry) => [entry.candidateId, entry.date]),
  );

  const reviewById = new Map(
    (reviews.value ?? []).map((entry) => [
      entry.candidateId,
      {
        outcome: entry.outcome,
        reason: entry.reason,
        ...(entry.research ? { research: entry.research } : {}),
      },
    ]),
  );

  const drafts = files
    .filter((file) => file.name.endsWith(".md"))
    .map((file, index) => {
      const id = file.name.replace(/\.md$/, "");
      const { title, body } = splitDraft(file.content);

      return {
        index,
        draft: {
          name: file.name,
          title,
          body,
          content: file.content,
          date: dates.get(id) ?? null,
          review: reviewById.get(id) ?? null,
        },
      };
    })
    .sort((left, right) => {
      const a = left.draft.date;
      const b = right.draft.date;

      if (a !== null && b !== null && a !== b) return a < b ? -1 : 1;

      if (a === null && b !== null) return 1;

      if (a !== null && b === null) return -1;

      return left.index - right.index;
    })
    .map((entry) => entry.draft);

  const missingDates =
    calendar.value !== null && drafts.some((draft) => draft.date === null);

  return {
    drafts,
    timezone: calendar.value?.[0]?.timezone ?? null,
    calendarProblem:
      calendar.problem ??
      reviews.problem ??
      (missingDates ? "Some drafts have no calendar date." : null),
  };
}

function calendarDate(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

export function formatDraftDay(
  date: string,
  locale?: string,
): { weekday: string; weekdayShort: string; day: string; full: string } {
  const value = calendarDate(date);

  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
      value,
    );

  return {
    weekday: format({ weekday: "long" }),
    weekdayShort: format({ weekday: "short" }),
    day: format({ day: "numeric" }),
    full: format({ weekday: "long", month: "long", day: "numeric" }),
  };
}

export function formatWeekRange(
  drafts: readonly WorkflowDraft[],
  locale?: string,
): string | null {
  const dates = drafts
    .map((draft) => draft.date)
    .filter((date): date is string => date !== null);

  if (dates.length === 0) return null;

  const first = calendarDate(dates[0]);
  const last = calendarDate(dates[dates.length - 1]);

  const format = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  return dates.length === 1
    ? format.format(first)
    : format.formatRange(first, last);
}

export function countWords(text: string): number {
  const words = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);

  return words?.length ?? 0;
}
