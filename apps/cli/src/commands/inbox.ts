import { Command } from "commander";
import {
  chatsWaitingPhrase,
  type InboxActRequest,
  type InboxActResult,
  type InboxCard,
  type InboxCardKind,
  type InboxCounts,
  type InboxEntry,
  type InboxSnapshot,
  type InboxWaitingGroup,
  type InboxWaitingRow,
} from "@omnyo/domain";
import { OmnyoHttpError } from "@omnyo/sdk";
import { action, CliExitError, CliUsageError } from "../action.js";
import { createCliOmnyoSdk } from "../client.js";
import {
  outputJson,
  requireThreadId,
  type JsonOutputOptions,
} from "./helpers.js";
import {
  FUTURE_TIME_FORMS,
  formatLocalTime,
  parseFutureTime,
} from "./thread/send-time.js";

interface InboxFailureAcknowledgeOptions extends JsonOutputOptions {
  failure: string;
  turn: string;
  reason: string;
}

interface InboxActOptions extends JsonOutputOptions {
  until?: string;
  event?: string;
  wait?: string;
  note?: string;
  question?: string;
  target?: string;
  stopRunning?: boolean;
}

const ACT_FLAGS = [
  ["until", "--until"],
  ["event", "--event"],
  ["wait", "--wait"],
  ["note", "--note"],
  ["question", "--question"],
  ["target", "--target"],
  ["stopRunning", "--stop-running"],
] as const;

type ActFlag = (typeof ACT_FLAGS)[number][0];

interface ActFlags {
  until: number | null;
  event: string | null;
  wait: string | null;
  note: string | null;
  question: string | null;
  target: string | null;
  stopRunning: boolean;
}

interface InboxActionSpec {
  flags: readonly ActFlag[];
  build(entry: InboxEntry, flags: ActFlags): InboxActRequest;
}

type CardWaitKind =
  | "accept-proposal"
  | "keep-waiting"
  | "remind-later"
  | "continue-with-result";

const JSON_HELP = "Print machine-readable JSON output";

const CARD_KIND_LABEL: Record<InboxCardKind, string> = {
  question: "Question",
  result: "Result",
  returned: "Returned",
  problem: "Problem",
  runs: "Runs",
  chain: "Chain",
};

const WAITING_GROUP_LABEL: Record<InboxWaitingGroup, string> = {
  "on-you": "On you",
  "comes-back": "Comes back by itself",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function missingFlag(flag: string, hint: string): never {
  throw new CliUsageError({
    code: "missing_required",
    hint,
    message: `Missing ${flag}.`,
  });
}

function missingWait(entry: InboxEntry, actionName: string): never {
  throw new CliUsageError({
    code: "missing_required",
    hint: `\`omnyo wait list ${entry.threadId}\` lists the chat's waits.`,
    message: `Pass --wait <waitId>; this card offers no wait for ${actionName}.`,
  });
}

function shown(entry: InboxEntry) {
  return {
    threadId: entry.threadId,
    displayedReceiptIds:
      entry.card?.causes.map((cause) => cause.receiptId) ?? [],
    latch: entry.latch,
  };
}

function cardWaitId(entry: InboxEntry, kind: CardWaitKind): string | null {
  const primary = entry.card?.primary;

  switch (primary?.kind) {
    case "accept-proposal":
    case "keep-waiting":
    case "remind-later":
    case "continue-with-result":
      return primary.kind === kind ? primary.waitId : null;
    default:
      return null;
  }
}

function waitFor(
  entry: InboxEntry,
  flags: ActFlags,
  kind: CardWaitKind,
): string {
  return flags.wait ?? cardWaitId(entry, kind) ?? missingWait(entry, kind);
}

function untilOr(flags: ActFlags, fallback: number | null): number {
  return (
    flags.until ??
    fallback ??
    missingFlag("--until", `Pass --until <when>: ${FUTURE_TIME_FORMS}.`)
  );
}

function keepWaitingUntil(entry: InboxEntry): number | null {
  const primary = entry.card?.primary;

  return primary?.kind === "keep-waiting" ? primary.until : null;
}

function resumeTarget(entry: InboxEntry): string {
  const primary = entry.card?.primary;

  return primary?.kind === "resume"
    ? primary.targetThreadId
    : missingFlag(
        "--target",
        "This card offers no Resume; `omnyo inbox` shows it.",
      );
}

function onYouWaitId(entry: InboxEntry): string | null {
  return entry.waiting?.group === "on-you" ? entry.waiting.waitId : null;
}

function onlyQuestionId(entry: InboxEntry): string {
  const [only, ...rest] = entry.card?.questionIds ?? [];

  if (only !== undefined && rest.length === 0) return only;

  return missingFlag(
    "--question",
    only === undefined
      ? "This card shows no question."
      : `Pass one of: ${[only, ...rest].join(", ")}.`,
  );
}

const INBOX_ACTIONS = new Map<string, InboxActionSpec>([
  ["ok", { flags: [], build: (entry) => ({ action: "ok", ...shown(entry) }) }],
  [
    "archive",
    {
      flags: ["stopRunning"],
      build: (entry, flags) => ({
        action: "archive",
        ...shown(entry),
        stopRunning: flags.stopRunning,
      }),
    },
  ],
  [
    "wait",
    {
      flags: ["until"],
      build: (entry, flags) => ({
        action: "wait",
        ...shown(entry),
        until: untilOr(flags, null),
      }),
    },
  ],
  [
    "wait-report",
    {
      flags: ["event"],
      build: (entry, flags) => ({
        action: "wait-report",
        ...shown(entry),
        event:
          flags.event ??
          missingFlag("--event", 'Pass --event "<what only you can see>".'),
      }),
    },
  ],
  [
    "accept-proposal",
    {
      flags: ["wait"],
      build: (entry, flags) => ({
        action: "accept-proposal",
        ...shown(entry),
        waitId: waitFor(entry, flags, "accept-proposal"),
      }),
    },
  ],
  [
    "keep-waiting",
    {
      flags: ["wait", "until"],
      build: (entry, flags) => ({
        action: "keep-waiting",
        ...shown(entry),
        waitId: waitFor(entry, flags, "keep-waiting"),
        until: untilOr(flags, keepWaitingUntil(entry)),
      }),
    },
  ],
  [
    "remind-later",
    {
      flags: ["wait"],
      build: (entry, flags) => ({
        action: "remind-later",
        ...shown(entry),
        waitId: waitFor(entry, flags, "remind-later"),
      }),
    },
  ],
  [
    "happened",
    {
      flags: ["wait", "note"],
      build: (entry, flags) => ({
        action: "happened",
        threadId: entry.threadId,
        waitId:
          flags.wait ?? onYouWaitId(entry) ?? missingWait(entry, "happened"),
        note: flags.note,
      }),
    },
  ],
  [
    "shelf",
    {
      flags: [],
      build: (entry) => ({
        action: "shelf",
        threadId: entry.threadId,
        shelved: true,
      }),
    },
  ],
  [
    "unshelf",
    {
      flags: [],
      build: (entry) => ({
        action: "shelf",
        threadId: entry.threadId,
        shelved: false,
      }),
    },
  ],
  [
    "snooze-question",
    {
      flags: ["question", "until"],
      build: (entry, flags) => ({
        action: "snooze-question",
        threadId: entry.threadId,
        questionId: flags.question ?? onlyQuestionId(entry),
        until: untilOr(flags, null),
        latch: entry.latch,
      }),
    },
  ],
  [
    "cancel-wait",
    {
      flags: ["wait"],
      build: (entry, flags) => ({
        action: "cancel-wait",
        threadId: entry.threadId,
        waitId:
          flags.wait ??
          entry.waiting?.waitId ??
          missingWait(entry, "cancel-wait"),
      }),
    },
  ],
  [
    "resume",
    {
      flags: ["target"],
      build: (entry, flags) => ({
        action: "resume",
        ...shown(entry),
        targetThreadId: flags.target ?? resumeTarget(entry),
      }),
    },
  ],
  [
    "continue-with-result",
    {
      flags: ["wait"],
      build: (entry, flags) => ({
        action: "continue-with-result",
        ...shown(entry),
        waitId: waitFor(entry, flags, "continue-with-result"),
      }),
    },
  ],
]);

const ACTION_NAMES = [...INBOX_ACTIONS.keys()].join(", ");

function requireAction(name: string, opts: InboxActOptions): InboxActionSpec {
  const spec = INBOX_ACTIONS.get(name);

  if (spec === undefined)
    throw new CliUsageError({
      code: "invalid_value",
      hint: `Actions: ${ACTION_NAMES}.`,
      message: `Unknown inbox action '${name}'.`,
    });

  for (const [flag, label] of ACT_FLAGS) {
    if (opts[flag] === undefined || spec.flags.includes(flag)) continue;

    const accepted = ACT_FLAGS.filter(([key]) => spec.flags.includes(key))
      .map(([, flagLabel]) => flagLabel)
      .join(", ");

    throw new CliUsageError({
      code: "invalid_value",
      hint:
        accepted === ""
          ? `${name} takes no options.`
          : `${name} takes ${accepted}.`,
      message: `${label} does not apply to ${name}.`,
    });
  }

  return spec;
}

function parseActFlags(opts: InboxActOptions): ActFlags {
  return {
    until:
      opts.until === undefined ? null : parseFutureTime(opts.until, "--until"),
    event: opts.event ?? null,
    wait: opts.wait ?? null,
    note: opts.note ?? null,
    question: opts.question ?? null,
    target: opts.target ?? null,
    stopRunning: opts.stopRunning === true,
  };
}

function findEntry(snapshot: InboxSnapshot, threadId: string): InboxEntry {
  const entry = [
    ...snapshot.inbox,
    ...snapshot.waiting,
    ...snapshot.running,
    ...snapshot.shelf,
  ].find((item) => item.threadId === threadId);

  if (entry !== undefined) return entry;

  throw new CliUsageError({
    code: "invalid_value",
    hint: "Pass a top-level chat's ID; `omnyo inbox` lists them.",
    message: `${threadId} is not in the Inbox snapshot.`,
  });
}

async function explainUpdated(
  request: Promise<InboxActResult>,
): Promise<InboxActResult> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof OmnyoHttpError && error.code === "inbox_updated")
      throw new CliExitError(
        "The card changed before the action reached the server.",
        1,
        {
          code: "inbox_updated",
          hint: "Run `omnyo inbox` to see the current card, then act again.",
        },
      );

    throw error;
  }
}

function entryName(entry: InboxEntry): string {
  return `${entry.title === "" ? "Untitled" : entry.title} (${entry.threadId})`;
}

function primaryLabel(card: InboxCard): string {
  const { primary } = card;

  switch (primary.kind) {
    case "answer":
      return "Answer";
    case "accept-proposal":
      return primary.label;
    case "ok":
      return primary.thenWaits === null
        ? "OK"
        : `OK · Then waits: ${primary.thenWaits}`;
    case "reply":
      return primary.waiterTitles.length === 0
        ? "Reply"
        : `Reply · ${chatsWaitingPhrase(primary.waiterTitles)} on this chat's result`;
    case "archive":
      return "Archive";
    case "your-call":
      return card.notAssessed === null
        ? "Your call · Nothing next"
        : `Your call · Not assessed: ${card.notAssessed}`;
    case "resume":
      return primary.targetTitle === null
        ? "Resume"
        : `Resume ${primary.targetTitle}`;
    case "problem-chooser":
      return primary.retryAllowed
        ? "Your call · Retry, Reply or Archive"
        : "Your call · Reply or Archive";
    case "keep-waiting":
      return `Keep waiting until ${formatLocalTime(primary.until)}`;
    case "remind-later":
      return "Remind me in 14 days";
    case "continue-with-result":
      return "Continue with it";
    case "archive-runs":
      return primary.mode === "done"
        ? `Archive ${plural(primary.threadIds.length, "done run")}`
        : `Keep latest · archive ${primary.threadIds.length} older`;
    case "resume-all-at-reset":
      return `Resume all at reset · ${formatLocalTime(primary.resetAt)}`;
  }
}

function failureLine(failure: NonNullable<InboxCard["failure"]>): string {
  return [
    `Failed: ${failure.reason}`,
    ...(failure.queuedCount === 0
      ? []
      : [`${plural(failure.queuedCount, "queued message")} waiting`]),
    ...(failure.scheduledCount === 0
      ? []
      : [`${plural(failure.scheduledCount, "scheduled message")} waiting`]),
  ].join(" · ");
}

function cardLines(entry: InboxEntry, card: InboxCard): string[] {
  const head = [
    entry.state === "failed" ? "Failed" : CARD_KIND_LABEL[card.kind],
    entryName(entry),
    ...(entry.shelved ? ["Shelf"] : []),
    ...(card.questionFrom === null ? [] : [`from ${card.questionFrom}`]),
  ].join(" · ");

  return [
    head,
    `  State: ${entry.state} · ${entry.reason.text}`,
    ...card.causes.map(
      (cause) =>
        `  ${cause.summary}${cause.fromTitle === null ? "" : ` · from ${cause.fromTitle}`}`,
    ),
    ...(card.failure === null ? [] : [`  ${failureLine(card.failure)}`]),
    ...(card.stillOnYou === null ? [] : [`  Still on you: ${card.stillOnYou}`]),
    ...(card.snoozedQuestionUntil === null
      ? []
      : [
          `  Question snoozed until ${formatLocalTime(card.snoozedQuestionUntil)}`,
        ]),
    `  Primary: ${primaryLabel(card)}`,
  ];
}

function retryText(retry: NonNullable<InboxWaitingRow["retry"]>): string {
  const at =
    retry.at === null ? "retries" : `retries ${formatLocalTime(retry.at)}`;

  return retry.attempt === null || retry.maxAttempts === null
    ? at
    : `${at} · ${retry.attempt} of ${retry.maxAttempts}`;
}

function waitingTiming(row: InboxWaitingRow): string[] {
  const checkAt =
    !row.checking &&
    row.checkAt !== null &&
    (row.returnAt === null || row.checkAt < row.returnAt)
      ? row.checkAt
      : null;

  const returnAt =
    row.returnAt === null || row.returnAt === row.retry?.at
      ? null
      : row.returnAt;

  return [
    ...(row.checking ? ["Checking…"] : []),
    ...(row.behind === null ? [] : [`Behind ${row.behind}`]),
    ...(row.retry === null ? [] : [retryText(row.retry)]),
    ...(row.checkCount === 0 ? [] : [`checked ${row.checkCount}×`]),
    ...(checkAt === null ? [] : [`checks ${formatLocalTime(checkAt)}`]),
    ...(returnAt === null
      ? []
      : [
          `${row.group === "on-you" ? "reminder" : "back by"} ${formatLocalTime(returnAt)}`,
        ]),
  ];
}

function waitingLines(
  entries: readonly InboxEntry[],
  group: InboxWaitingGroup,
): string[] {
  return entries.flatMap((entry) => {
    const row = entry.waiting;

    return row?.group === group
      ? [
          [
            entryName(entry),
            entry.state,
            entry.reason.text,
            ...waitingTiming(row),
          ].join(" · "),
        ]
      : [];
  });
}

function runningLabel(entry: InboxEntry): string {
  return entry.running?.label ?? "Working";
}

function summarizeEntry(entry: InboxEntry): string {
  switch (entry.view) {
    case "inbox":
      return entry.card === null
        ? "Inbox"
        : `Inbox · ${entry.state === "failed" ? "Failed" : CARD_KIND_LABEL[entry.card.kind]} · ${primaryLabel(entry.card)}`;
    case "waiting":
      return entry.waiting === null
        ? "Waiting"
        : [
            "Waiting",
            WAITING_GROUP_LABEL[entry.waiting.group],
            entry.waiting.reason,
            ...waitingTiming(entry.waiting),
          ].join(" · ");
    case "running":
      return `Running · ${runningLabel(entry)}`;
    case "resting":
      return "Resting on the Shelf";
    case "archive":
      return "Archive";
  }
}

function headerLines(counts: InboxCounts): string[] {
  const questions =
    counts.questions === 0 ? "" : ` · ${plural(counts.questions, "question")}`;

  const nextBack =
    counts.nextBackAt === null
      ? ""
      : ` · next back ${formatLocalTime(counts.nextBackAt)}`;

  return [
    counts.inbox === 0 ? "All clear" : `Inbox ${counts.inbox}${questions}`,
    `${counts.running} running · ${counts.waiting} waiting${nextBack}`,
    ...(counts.onYou.length === 0
      ? []
      : [`On you: ${counts.onYou.join(", ")}`]),
  ];
}

function printSection(title: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  console.log("");
  console.log(title);

  for (const line of lines) console.log(`  ${line}`);
}

function printSnapshot(snapshot: InboxSnapshot): void {
  for (const line of headerLines(snapshot.counts)) console.log(line);

  printSection(
    "Inbox",
    snapshot.inbox.flatMap((entry) =>
      entry.card === null ? [entryName(entry)] : cardLines(entry, entry.card),
    ),
  );
  printSection("Waiting · On you", waitingLines(snapshot.waiting, "on-you"));
  printSection(
    "Waiting · Comes back by itself",
    waitingLines(snapshot.waiting, "comes-back"),
  );
  printSection(
    "Running",
    snapshot.running.map(
      (entry) => `${entryName(entry)} · ${entry.state} · ${entry.reason.text}`,
    ),
  );
}

function printActResult(result: InboxActResult): void {
  if (result.entry !== null)
    console.log(`Now: ${summarizeEntry(result.entry)}`);

  if (result.moveId !== null)
    console.log(`Undo: omnyo inbox undo ${result.moveId}`);
}

export function registerInboxCommands(
  program: Command,
  getUrl: () => string,
): void {
  const inbox = program
    .command("inbox")
    .description("Show your Inbox: cards in order, then Waiting and Running")
    .option("--json", "Print the snapshot as the app renders it, in order")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const snapshot =
          await createCliOmnyoSdk(getUrl()).experimental_inbox.snapshot();

        if (outputJson(opts, snapshot)) return;
        printSnapshot(snapshot);
      }),
    );

  inbox
    .command("failures <threadId>")
    .description("List a chat's retained failure identities and status")
    .option("--json", JSON_HELP)
    .action(
      action(async (threadId: string, opts: JsonOutputOptions) => {
        const result = await createCliOmnyoSdk(
          getUrl(),
        ).experimental_inbox.failures({
          threadId: requireThreadId(threadId),
        });

        if (outputJson(opts, result)) return;

        if (result.failures.length === 0) console.log("No failures.");

        for (const failure of result.failures)
          console.log(
            `${failure.id} · ${failure.state} · turn ${failure.turnId ?? "unknown"} · ${failure.reason}`,
          );
      }),
    );

  inbox
    .command("acknowledge-failure <threadId>")
    .description(
      "Acknowledge one obsolete failure without replaying work or declaring completion",
    )
    .requiredOption("--failure <id>", "Exact failure ID from inbox failures")
    .requiredOption(
      "--turn <stored-turn-id>",
      "Exact stored turn ID from inbox failures",
    )
    .requiredOption(
      "--reason <text>",
      "Audit reason why this failure is obsolete (1–1,000 characters)",
    )
    .option("--json", JSON_HELP)
    .action(
      action(async (threadId: string, opts: InboxFailureAcknowledgeOptions) => {
        for (const [flag, value] of Object.entries({
          "--failure": opts.failure,
          "--turn": opts.turn,
          "--reason": opts.reason,
        }))
          if (value.trim() === "")
            missingFlag(flag, `Pass a non-empty ${flag} value.`);

        const result = await createCliOmnyoSdk(
          getUrl(),
        ).experimental_inbox.acknowledgeFailure({
          threadId: requireThreadId(threadId),
          failureId: opts.failure,
          turnId: opts.turn,
          reason: opts.reason,
        });

        if (outputJson(opts, result)) return;
        console.log(
          `${result.acknowledged ? "Acknowledged" : "Already acknowledged"} ${result.failure.id} on ${result.failure.threadId}.`,
        );
      }),
    );

  inbox
    .command("act")
    .description("Act on a top-level chat's Inbox card as the owner")
    .argument("<threadId>", "Top-level chat")
    .argument("<action>", `One of: ${ACTION_NAMES}`)
    .option(
      "--until <when>",
      `Date for wait, keep-waiting and snooze-question: ${FUTURE_TIME_FORMS}`,
    )
    .option("--event <text>", "Event only you can see, for wait-report")
    .option("--wait <waitId>", "Wait to act on (default: the card's wait)")
    .option("--note <text>", "Note sent with happened")
    .option(
      "--question <id>",
      "Question to snooze (default: the card's only question)",
    )
    .option(
      "--target <threadId>",
      "Chat to resume (default: the card's Resume target)",
    )
    .option("--stop-running", "Stop running work, then archive")
    .option("--json", JSON_HELP)
    .action(
      action(
        async (threadId: string, actionName: string, opts: InboxActOptions) => {
          const spec = requireAction(actionName, opts);
          const flags = parseActFlags(opts);
          const sdk = createCliOmnyoSdk(getUrl());

          const entry = findEntry(
            await sdk.experimental_inbox.snapshot(),
            requireThreadId(threadId),
          );

          const result = await explainUpdated(
            sdk.experimental_inbox.act({ request: spec.build(entry, flags) }),
          );

          if (outputJson(opts, result)) return;
          console.log(`${actionName} · ${entryName(entry)}`);
          printActResult(result);
        },
      ),
    );

  inbox
    .command("undo [moveId]")
    .description("Undo your most recent Inbox move (default: the last move)")
    .option("--json", JSON_HELP)
    .action(
      action(async (moveId: string | undefined, opts: JsonOutputOptions) => {
        const sdk = createCliOmnyoSdk(getUrl());

        const lastMove =
          moveId === undefined
            ? (await sdk.experimental_inbox.snapshot()).lastMove
            : null;

        const target = moveId ?? lastMove?.moveId;

        if (target === undefined)
          throw new Error("Nothing to undo: the Inbox has no recent move.");

        const result = await sdk.experimental_inbox.undo({ moveId: target });

        if (outputJson(opts, result)) return;
        console.log(
          lastMove === null
            ? `Undid ${target}.`
            : `Undid ${lastMove.kind} on ${lastMove.threadId} (${target}).`,
        );

        if (result.entry !== null)
          console.log(
            `Now: ${entryName(result.entry)} · ${summarizeEntry(result.entry)}`,
          );
      }),
    );
}
