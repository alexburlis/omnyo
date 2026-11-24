import { Command } from "commander";
import type {
  InboxEventCheckResponse,
  InboxEventSourceView,
  InboxWaitActionResponse,
  InboxWaitRegisterRequest,
  InboxWaitRegisterResponse,
  InboxWaitView,
} from "@omnyo/domain";
import { action, CliUsageError } from "../action.js";
import { createCliOmnyoSdk } from "../client.js";
import { resolveContextThreadId } from "../context-env.js";
import { missingThreadIdHint } from "../context-hints.js";
import {
  collectOption,
  outputJson,
  printThreadContextLabel,
  requireThreadIdOrSelf,
  type ResolvedId,
} from "./helpers.js";
import {
  FUTURE_TIME_FORMS,
  formatLocalTime,
  parseFutureTime,
} from "./thread/send-time.js";

interface WaitTargetOptions {
  self?: boolean;
  json?: boolean;
}

interface WaitRegisterOptions extends WaitTargetOptions {
  key?: string;
  for?: string;
  chat: string[];
  event: string[];
  check?: string;
  at?: string;
  report?: string;
  all?: boolean;
  any?: boolean;
  by?: string;
  resume?: string;
  after?: string;
}

interface WaitMetOptions extends WaitTargetOptions {
  condition: string;
  result?: string;
}

type CliSdk = ReturnType<typeof createCliOmnyoSdk>;

interface WaitOutcome {
  description: string;
  send(
    sdk: CliSdk,
    args: { threadId: string; waitId: string },
  ): Promise<InboxWaitActionResponse>;
  describe(response: InboxWaitActionResponse): string;
}

const SELF_HELP = "Target the current thread (from OMNYO_THREAD_ID)";

const JSON_HELP = "Print machine-readable JSON output";

const WAIT_OUTCOMES = {
  rearm: {
    description:
      "Declare not yet for the check that woke this turn; the wait checks again later",
    send: (sdk, args) => sdk.experimental_inbox.rearmWait(args),
    describe: ({ wait }) =>
      wait.nextCheckAt === null
        ? `Wait ${wait.id} re-armed.`
        : `Wait ${wait.id} re-armed; next check ${formatLocalTime(wait.nextCheckAt)}.`,
  },
  done: {
    description:
      "Resolve a report-it wait because the owner's message reports its event",
    send: (sdk, args) => sdk.experimental_inbox.doneWait(args),
    describe: ({ wait }) => `Wait ${wait.id} done: ${wait.forText}.`,
  },
  cancel: {
    description:
      "Cancel a wait; cancelling one the owner created or accepted proposes it instead",
    send: (sdk, args) => sdk.experimental_inbox.cancelWait(args),
    describe: ({ wait, proposed }) =>
      proposed
        ? `Proposed to the owner: Stop waiting: ${wait.forText}?`
        : `Wait ${wait.id} cancelled: ${wait.forText}.`,
  },
} satisfies Record<string, WaitOutcome>;

function resolveWaitThread(
  id: string | undefined,
  opts: WaitTargetOptions,
): ResolvedId {
  if (id !== undefined || opts.self)
    return {
      id: requireThreadIdOrSelf(id, opts),
      source: id === undefined ? "env" : "arg",
    };

  const context = resolveContextThreadId();

  if (context !== undefined) return { id: context, source: "env" };

  throw new CliUsageError({
    code: "missing_required",
    hint: missingThreadIdHint(),
    message:
      "Missing thread ID. Pass <threadId> or --self, or run inside an Omnyo chat.",
  });
}

function requireFlag(
  value: string | undefined,
  flag: string,
  hint: string,
): string {
  if (value === undefined || value.trim() === "")
    throw new CliUsageError({
      code: "missing_required",
      hint,
      message: `Missing ${flag}.`,
    });

  return value;
}

function waitRegistration(opts: WaitRegisterOptions): InboxWaitRegisterRequest {
  if (opts.all && opts.any)
    throw new CliUsageError({
      code: "invalid_value",
      hint: null,
      message: "Pass --all or --any, not both.",
    });

  if ((opts.check === undefined) !== (opts.at === undefined))
    throw new CliUsageError({
      code: "missing_required",
      hint: 'Pass both: --check "<what>" --at <when>.',
      message: "--check and --at go together.",
    });

  return {
    key: requireFlag(
      opts.key,
      "--key",
      "Pass a stable --key that names this wait, such as --key review-pr-42.",
    ),
    for: requireFlag(
      opts.for,
      "--for",
      'Pass --for "<what the chat waits for>", at most 60 characters.',
    ),
    chats: opts.chat,
    events: opts.event,
    check:
      opts.check === undefined || opts.at === undefined
        ? null
        : { what: opts.check, at: parseFutureTime(opts.at, "--at") },
    report: opts.report ?? null,
    readiness: opts.any ? "any" : "all",
    by: opts.by === undefined ? null : parseFutureTime(opts.by, "--by"),
    resume: opts.resume ?? null,
    after: opts.after ?? null,
  };
}

function registrationState(response: InboxWaitRegisterResponse): string {
  if (response.existing) return "already registered";

  return response.wait.status === "proposed"
    ? "proposed to the owner"
    : "registered";
}

function waitTimingLines(wait: InboxWaitView): string[] {
  return [
    ...(wait.deadline === null
      ? []
      : [`Deadline: ${formatLocalTime(wait.deadline)}`]),
    ...(wait.nextCheckAt === null
      ? []
      : [`Next check: ${formatLocalTime(wait.nextCheckAt)}`]),
  ];
}

function chatSources(wait: InboxWaitView): string[] {
  return wait.conditions
    .filter((condition) => condition.kind === "chat")
    .map((condition) => condition.label);
}

function printRegistration(
  threadId: string,
  response: InboxWaitRegisterResponse,
): void {
  const { wait } = response;

  console.log(
    `Wait ${wait.id} ${registrationState(response)} (${wait.kind}): ${wait.forText}`,
  );

  if (wait.status === "proposed")
    console.log("The owner accepts it from the Inbox.");

  for (const line of waitTimingLines(wait)) console.log(line);
  console.log(`Marker: ${wait.marker}`);

  const sources = chatSources(wait);

  if (sources.length === 0) return;
  console.log(`Ask ${sources.join(", ")} to reply with:`);
  console.log(
    `  omnyo thread tell ${threadId} --mode auto "${wait.marker} <result>"`,
  );
}

function conditionText(condition: InboxWaitView["conditions"][number]): string {
  const label =
    condition.label === "" || condition.key.endsWith(condition.label)
      ? ""
      : ` "${condition.label}"`;

  return `${condition.key}${label} ${condition.met ? "met" : "pending"}`;
}

function printWaitList(
  threadId: string,
  waits: readonly InboxWaitView[],
): void {
  if (waits.length === 0) {
    console.log(`No open waits on ${threadId}.`);

    return;
  }

  for (const wait of waits) {
    console.log(`${wait.id} · ${wait.kind} · ${wait.status} · ${wait.forText}`);

    const timing = [
      ...(wait.deadline === null
        ? []
        : [`deadline ${formatLocalTime(wait.deadline)}`]),
      ...(wait.nextCheckAt === null
        ? []
        : [`next check ${formatLocalTime(wait.nextCheckAt)}`]),
      ...(wait.checkCount === 0 ? [] : [`checked ${wait.checkCount}×`]),
    ];

    if (timing.length > 0) console.log(`  ${timing.join(" · ")}`);
    console.log(
      `  Conditions: ${wait.conditions.map(conditionText).join(", ")}`,
    );

    if (chatSources(wait).length > 0) console.log(`  Marker: ${wait.marker}`);
  }
}

function everyText(everyMs: number): string {
  const minutes = Math.round(everyMs / 60_000);

  return minutes < 60
    ? `every ${minutes} min`
    : `every ${Math.round(minutes / 60)} h`;
}

function healthText(source: InboxEventSourceView): string {
  const { health } = source;

  switch (health.state) {
    case "idle":
      return "not checked yet";
    case "ok":
      return health.lastCheckAt === null
        ? "ok"
        : `ok, checked ${formatLocalTime(health.lastCheckAt)}`;
    case "failing":
      return `failing ${health.consecutiveFailures}×: ${health.lastError ?? "unknown error"}`;
    case "proof-failed":
      return `cannot check: ${health.proof ?? "unknown error"}`;
  }
}

function printEventSources(sources: readonly InboxEventSourceView[]): void {
  for (const source of sources) {
    const traits = [
      source.owner === "core" ? "core" : `plugin ${source.owner}`,
      source.kind === "push" || source.everyMs === null
        ? "push"
        : `poll ${everyText(source.everyMs)}`,
      ...(source.approval === "owner" ? ["asks the owner"] : []),
    ];

    console.log(`${source.family} · ${traits.join(" · ")}`);
    console.log(`  ${source.label}`);
    console.log(`  Format: ${source.keyFormat}`);
    console.log(`  Example: ${source.examples.join(", ")}`);

    if (source.kind === "poll" || source.pendingKeys > 0)
      console.log(
        `  Pending: ${source.pendingKeys} · ${source.kind === "poll" ? healthText(source) : "push"}`,
      );
  }
}

function printEventCheck(response: InboxEventCheckResponse): void {
  if (!response.valid) {
    console.log(`Invalid: ${response.error ?? response.key}`);

    return;
  }

  console.log(`${response.key}: ${response.describe ?? response.key}`);
  console.log(
    `Source: ${response.family ?? "unknown"} (${response.kind ?? "unknown"}${response.approval === "owner" ? ", asks the owner" : ""})`,
  );

  if (response.kind === "push") {
    console.log("Its owner reports this event when it happens.");

    return;
  }

  if (response.error !== null) {
    console.log(`Dry run failed: ${response.error}`);

    return;
  }

  console.log(
    response.fired
      ? `Fires now: ${response.result ?? ""}`
      : "Not yet; a wait on this key keeps checking.",
  );
}

function registerOutcomeCommand(
  wait: Command,
  name: keyof typeof WAIT_OUTCOMES,
  getUrl: () => string,
): void {
  const outcome: WaitOutcome = WAIT_OUTCOMES[name];

  wait
    .command(`${name} <waitId> [threadId]`)
    .description(outcome.description)
    .option("--self", SELF_HELP)
    .option("--json", JSON_HELP)
    .action(
      action(
        async (
          waitId: string,
          id: string | undefined,
          opts: WaitTargetOptions,
        ) => {
          const target = resolveWaitThread(id, opts);

          const response = await outcome.send(createCliOmnyoSdk(getUrl()), {
            threadId: target.id,
            waitId,
          });

          if (outputJson(opts, { threadId: target.id, ...response })) return;
          printThreadContextLabel(target);
          console.log(outcome.describe(response));
        },
      ),
    );
}

export function registerWaitCommands(
  program: Command,
  getUrl: () => string,
): void {
  const wait = program
    .command("wait [threadId]")
    .description(
      "Register a continuation that wakes this chat, then end the turn",
    )
    .option("--self", SELF_HELP)
    .option(
      "--key <key>",
      "Stable key for this logical wait; the same key and content return the existing wait",
    )
    .option("--for <text>", "What the chat waits for, at most 60 characters")
    .option(
      "--chat <threadId>",
      "Another chat delivers the result (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--event <key>",
      "An event key wakes the chat, such as host-reconnect:<hostId>; omnyo wait sources lists installed formats (repeatable)",
      collectOption,
      [],
    )
    .option("--check <what>", "What the agent checks itself, starting --at")
    .option("--at <when>", `First check: ${FUTURE_TIME_FORMS}`)
    .option(
      "--report <event>",
      "An event only the owner can notice; proposes an On you wait",
    )
    .option("--all", "Wake when every condition is met (default)")
    .option("--any", "Wake when any condition is met")
    .option(
      "--by <deadline>",
      `Deadline (default 7 days): ${FUTURE_TIME_FORMS}`,
    )
    .option("--resume <step>", "Next step the wake turn carries")
    .option(
      "--after <waitId>",
      "Register the successor of the wait that woke this turn; keeps its deadline",
    )
    .option("--json", JSON_HELP)
    .action(
      action(async (id: string | undefined, opts: WaitRegisterOptions) => {
        const request = waitRegistration(opts);
        const target = resolveWaitThread(id, opts);

        const response = await createCliOmnyoSdk(
          getUrl(),
        ).experimental_inbox.registerWait({
          threadId: target.id,
          wait: request,
        });

        if (outputJson(opts, { threadId: target.id, ...response })) return;
        printThreadContextLabel(target);
        printRegistration(target.id, response);
      }),
    );

  registerOutcomeCommand(wait, "rearm", getUrl);

  wait
    .command("met <waitId> [threadId]")
    .description(
      "Record a met condition of the joined wait that woke this turn",
    )
    .requiredOption(
      "--condition <key>",
      "Condition key: check, chat:<threadId> or event:<key> (omnyo wait list shows them)",
    )
    .option("--result <text>", "Result delivered with the condition")
    .option("--self", SELF_HELP)
    .option("--json", JSON_HELP)
    .action(
      action(
        async (
          waitId: string,
          id: string | undefined,
          opts: WaitMetOptions,
        ) => {
          const target = resolveWaitThread(id, opts);

          const response = await createCliOmnyoSdk(
            getUrl(),
          ).experimental_inbox.metWait({
            threadId: target.id,
            waitId,
            condition: opts.condition,
            result: opts.result ?? null,
          });

          if (outputJson(opts, { threadId: target.id, ...response })) return;
          printThreadContextLabel(target);

          const pending = response.wait.conditions
            .filter((condition) => !condition.met)
            .map((condition) => condition.key);

          console.log(
            pending.length === 0
              ? `Condition ${opts.condition} met on wait ${response.wait.id}.`
              : `Condition ${opts.condition} met on wait ${response.wait.id}; pending: ${pending.join(", ")}.`,
          );
        },
      ),
    );

  registerOutcomeCommand(wait, "done", getUrl);
  registerOutcomeCommand(wait, "cancel", getUrl);

  wait
    .command("list [threadId]")
    .description("List a chat's open waits")
    .option("--self", SELF_HELP)
    .option("--json", JSON_HELP)
    .action(
      action(async (id: string | undefined, opts: WaitTargetOptions) => {
        const target = resolveWaitThread(id, opts);

        const { waits } = await createCliOmnyoSdk(
          getUrl(),
        ).experimental_inbox.waits({ threadId: target.id });

        if (outputJson(opts, { threadId: target.id, waits })) return;
        printThreadContextLabel(target);
        printWaitList(target.id, waits);
      }),
    );

  wait
    .command("sources")
    .description(
      "List the event sources --event keys can name, with formats and health",
    )
    .option("--json", JSON_HELP)
    .action(
      action(async (opts: { json?: boolean }) => {
        const { sources } =
          await createCliOmnyoSdk(getUrl()).experimental_inbox.eventSources();

        if (outputJson(opts, { sources })) return;
        printEventSources(sources);
      }),
    );

  wait
    .command("check <key>")
    .description(
      "Validate an event key and run its source once without registering a wait",
    )
    .option("--json", JSON_HELP)
    .action(
      action(async (key: string, opts: { json?: boolean }) => {
        const response = await createCliOmnyoSdk(
          getUrl(),
        ).experimental_inbox.checkEvent({ key });

        if (!response.valid || response.error !== null) process.exitCode = 1;

        if (outputJson(opts, response)) return;
        printEventCheck(response);
      }),
    );
}
