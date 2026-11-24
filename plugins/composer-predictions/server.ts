import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { registerCompletionReports } from "./completion-report";
import {
  checkRead,
  omitsRequiredReply,
  ownsNextStep,
  predictionAdmission,
  PredictionReadinessError,
  READ_TIMEOUT_MS,
} from "./readiness";
import {
  ASSESSMENT_VERSION,
  archiveVerdictLabel,
  poolPredictionSchema,
  predictionSchema,
  nativeFailureSchema,
  predictionFailureCauseSchema,
  predictionFailureSchema,
  predictionSkipMessages,
  predictionSkipSchema,
  rpcContract,
  type PredictionSkipReason,
  type PredictionState,
} from "./contract";

interface Prediction {
  state: PredictionState;
  sourceSeq: number | null;
  hostId: string | null;
  controller: AbortController | null;
  task: Promise<void> | null;
  requested: boolean;
  epoch: number;
  restored: boolean;
  checked: boolean;
  attempts: number;
  retryAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  activeRequest: {
    requestId: string;
    sourceSeq: number;
    startedAt: number;
    stage: "inference" | "validation";
  } | null;
}

type ThreadEvent = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["events"]["list"]>
>[number];

type ThreadWork = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["list"]>
>[number]["work"];

const TERMINAL_SKIPS: ReadonlySet<PredictionSkipReason> = new Set([
  "child",
  "no-completed-turn",
]);

const terminalSkipMessages: ReadonlySet<string> = new Set(
  [...TERMINAL_SKIPS].map((reason) => predictionSkipMessages[reason]),
);

const PREPARATION_FAILED_MESSAGE =
  "Could not prepare the prediction. Retry when Omnyo is available.";

const PREDICTION_TIMEOUT_MS = 4 * 60_000;

const RESTORE_CONCURRENCY = 4;

const FINAL_REPLY_EVENT_WINDOW = 50;

const FINAL_REPLY_FIRST_PAGE = 8;

const TAG_TIMEOUT_MS = 5_000;

const chatTagsSchema = z.object({
  tags: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        description: z.string(),
      }),
    )
    .refine((tags) => new Set(tags.map(({ id }) => id)).size === tags.length)
    .transform((tags) =>
      tags.slice(0, 24).map(({ id, description }) => ({
        id,
        description: description.slice(0, 240),
      })),
    ),
});

const SWEEP_INTERVAL_MS = 3 * 60_000;

const STATE_READ_WAIT_MS = 250;

const TIMED_OUT_MESSAGE = "Prediction timed out. Omnyo retries automatically.";

const MACHINE_UNAVAILABLE_MESSAGE = "The thread’s machine is unavailable.";

const ALLOWANCE_UNAVAILABLE = "Predictions need fresh included Codex allowance";

const NOT_READY_SENTENCE = /(?:^|[.!?:;]\s+)Not ready:\s*(.*)$/iu;

function reportedBlocker(reply: string): PredictionState["archiveReadiness"] {
  let fence: string | null = null;

  for (const line of reply.split("\n")) {
    const trimmed = line.trimStart();
    const marker = /^(`{3,}|~{3,})(.*)$/u.exec(trimmed);

    if (marker !== null) {
      const delimiter = marker[1];

      if (fence === null) fence = delimiter;
      else if (
        delimiter[0] === fence[0] &&
        delimiter.length >= fence.length &&
        marker[2].trim() === ""
      )
        fence = null;

      continue;
    }

    if (fence !== null || trimmed.startsWith(">") || /^(?: {4}|\t)/u.test(line))
      continue;

    const sentence = trimmed
      .replace(/^(?:[-+*]|\d+[.)])\s+/u, "")
      .replace(/^(?:\*{1,2})?TL;DR\*{0,2}:\*{0,2}\s*/iu, "")
      .replace(/(?:\*{1,2}|_{1,2})(Not ready)(:)?(?:\*{1,2}|_{1,2})/giu, "$1$2")
      .trim();

    const unfinished = NOT_READY_SENTENCE.exec(sentence);

    if (unfinished !== null) {
      const outcome = unfinished[1].trim();

      return outcome === ""
        ? null
        : {
            ready: false,
            reason: `Not ready: ${outcome.slice(0, 400)}`,
            recap: outcome.slice(0, 400),
            ask: null,
            waitingOn: null,
          };
    }
  }

  return null;
}

const FORCE_UNAVAILABLE_MESSAGE =
  "Update Account Pooler to suggest a reply on demand.";

type PredictionRun = "reuse" | "fresh" | "forced";

const RUN_STRENGTH: Record<PredictionRun, number> = {
  reuse: 0,
  fresh: 1,
  forced: 2,
};

function manualRun(fresh: boolean, force: boolean): PredictionRun {
  if (force) return "forced";

  return fresh ? "fresh" : "reuse";
}

function refusedForce(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("rpc input validation failed")
  );
}

const CLAUDE_INCOMPLETE_MESSAGE =
  "Claude could not finish the prediction. Omnyo retries automatically.";

const CLAUDE_ALLOWANCE_MESSAGE =
  "Predictions need available Claude subscription allowance.";

const CODEX_PLAN_UNAVAILABLE_MESSAGE =
  "OpenAI has not enabled predictions for the selected account.";

const CODEX_PLANS_UNAVAILABLE_MESSAGE =
  "OpenAI has not enabled predictions for any available account.";

const machineFailures = new Set([
  MACHINE_UNAVAILABLE_MESSAGE,
  "Reconnect the thread’s machine to generate a prediction.",
]);

const transientFailures = new Set([
  ...machineFailures,
  "Prediction failed. Check Account Pooler and retry.",
  PREPARATION_FAILED_MESSAGE,
  "Prediction readiness could not be checked. Retry when Omnyo is available.",
  TIMED_OUT_MESSAGE,
  CLAUDE_INCOMPLETE_MESSAGE,
]);

function retryDelay(message: string, attempt: number): number | null {
  const delays =
    message.startsWith(ALLOWANCE_UNAVAILABLE) ||
    message === CLAUDE_ALLOWANCE_MESSAGE
      ? [30 * 60_000, 90 * 60_000]
      : transientFailures.has(message) ||
          message.startsWith("Checking ") ||
          message.startsWith("Could not check ")
        ? [60_000, 5 * 60_000, 20 * 60_000]
        : [];

  return delays[Math.min(attempt, delays.length) - 1] ?? null;
}

function predictionFailureMessage(rawMessage: string): string {
  const message = rawMessage.replace(/^HTTP [45]\d{2}: /u, "");

  if (sdkTimeoutMs(message) !== null) return TIMED_OUT_MESSAGE;

  if (message.includes("require an account in Account Pooler"))
    return "Add a Claude or Codex account in Account Pooler to get predictions.";

  if (message.includes("finite prepaid credits"))
    return "Predictions need fresh included Codex allowance or available prepaid credits.";

  if (
    message.includes("fresh included Codex allowance") ||
    message.includes("Included Codex allowance")
  )
    return "Predictions need fresh included Codex allowance.";

  if (message.includes("included Claude subscription allowance"))
    return CLAUDE_ALLOWANCE_MESSAGE;

  if (message.includes("routing for Claude Code predictions"))
    return "Enable Claude Code routing in Account Pooler to use Claude predictions.";

  if (message.includes("Use a Claude Code executable"))
    return "Set the Claude Code executable in Composer Predictions settings.";

  if (message.startsWith("Claude did not complete the prediction"))
    return CLAUDE_INCOMPLETE_MESSAGE;

  if (message.includes("not enabled composer predictions for any available"))
    return CODEX_PLANS_UNAVAILABLE_MESSAGE;

  if (message.includes("not enabled composer predictions"))
    return CODEX_PLAN_UNAVAILABLE_MESSAGE;

  if (message.includes("Native Codex request failed (-32601)"))
    return "This Codex version cannot generate predictions. Update Codex on the thread’s machine.";

  if (
    message.startsWith("This Codex model does not support composer predictions")
  )
    return "This thread’s Codex model does not support predictions. Choose a supported model for your next turn.";

  if (message === "Account Pooler rejected the Codex prediction payload.")
    return "Codex sent an unsupported prediction request. Update Omnyo and retry.";

  const payloadFailure =
    /^Account Pooler rejected the Codex prediction payload \((request|model|tools|prompt)\)\.$/u.exec(
      message,
    );

  if (payloadFailure)
    return payloadFailure[1] === "model"
      ? "This thread’s Codex model does not support predictions. Choose a supported model for your next turn."
      : "Codex sent an unsupported prediction request. Update Omnyo and retry.";

  if (message.includes("parent proxy predictions are unavailable"))
    return "Predictions are unavailable through a parent Account Pooler.";

  if (message.includes("Remote predictions require"))
    return "Set Omnyo’s public server URL to use predictions on this machine.";

  if (message.includes("thread’s machine is unavailable"))
    return "Reconnect the thread’s machine to generate a prediction.";

  if (message.includes("conversation context is unavailable or too large"))
    return "The conversation is unavailable or too large to predict. No prediction was generated.";

  return "Prediction failed. Check Account Pooler and retry.";
}

function nativeFailure(
  error: unknown,
): z.infer<typeof nativeFailureSchema> | null {
  const match =
    /^Codex did not complete the prediction \(status=(\w+), code=(\w+)(?:, httpStatus=(\d{3}))?\)\.$/u.exec(
      error instanceof Error
        ? error.message.replace(/^HTTP [45]\d{2}: /u, "")
        : "",
    );

  if (!match) return null;

  const parsed = nativeFailureSchema.safeParse({
    status: match[1],
    code: match[2],
    httpStatus: match[3] === undefined ? null : Number(match[3]),
  });

  return parsed.success ? parsed.data : null;
}

function sdkTimeoutMs(message: string): number | null {
  const match =
    /^(?:Omnyo|BB) request timed out after (\d+(?:\.\d+)?) (ms|seconds?)\.$/u.exec(
      message,
    );

  if (!match) return null;

  const duration = Number(match[1]) * (match[2] === "ms" ? 1 : 1000);

  return Number.isFinite(duration) ? duration : null;
}

function failureCause(
  error: unknown,
): z.infer<typeof predictionFailureCauseSchema> {
  if (!(error instanceof Error)) return { kind: "unknown" };

  const message = error.message.replace(/^HTTP [45]\d{2}: /u, "");
  const timeoutMs = sdkTimeoutMs(message);

  if (timeoutMs !== null) return { kind: "timeout", timeoutMs };

  if (error.name === "TimeoutError")
    return { kind: "timeout", timeoutMs: null };

  if (nativeFailure(error) !== null) return { kind: "native" };

  const rpc = /^Native Codex request failed \((-?\d{1,5})\)$/u.exec(message);

  const rpcCause = predictionFailureCauseSchema.safeParse({
    kind: "native-rpc",
    code: rpc === null ? null : Number(rpc[1]),
  });

  if (rpcCause.success) return rpcCause.data;

  const nativeCode = new Map([
    ["Native Codex could not start", "start_failed"],
    ["Native Codex exited before prediction completed", "exited"],
    ["Native Codex connection closed", "connection_closed"],
    ["Native Codex session closed", "session_closed"],
    ["Native Codex returned an invalid message", "invalid_message"],
    ["Native Codex notification handler failed", "notification_failed"],
    ["Codex returned an invalid prediction.", "invalid_prediction"],
    ["Claude returned an invalid prediction.", "invalid_prediction"],
    ["Native Codex returned cyclic prediction lineage.", "invalid_lineage"],
    [
      "Native Codex changed the prediction source model.",
      "source_model_changed",
    ],
  ]).get(message);

  const nativeCause = predictionFailureCauseSchema.safeParse({
    kind: "native-process",
    code: nativeCode,
  });

  if (nativeCause.success) return nativeCause.data;

  for (const candidate of [error, error.cause]) {
    const parsed = z.object({ code: z.string() }).safeParse(candidate);

    const transport = predictionFailureCauseSchema.safeParse({
      kind: "transport",
      code: parsed.success ? parsed.data.code : null,
    });

    if (transport.success) return transport.data;
  }

  const http = /^HTTP ([45]\d{2}): /u.exec(error.message);

  return http === null
    ? { kind: "unknown" }
    : { kind: "http", status: Number(http[1]) };
}

const PREDICTION_BACKENDS = ["codex", "claude"] as const;

const PREDICTION_BACKEND_LABELS = {
  codex: "Codex",
  claude: "Claude (subscription)",
};

const predictionModelSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

interface PredictionBackendSelection {
  backend: "codex" | "claude";
  model: string;
}

interface PredictionBackendConfig {
  codexChats: string;
  claudeChats: string;
  otherChats: string;
  claudeModel: string;
  codexModel: string;
}

function backendSelection(
  backend: "codex" | "claude",
  config: PredictionBackendConfig,
): PredictionBackendSelection {
  return backend === "claude"
    ? { backend: "claude", model: config.claudeModel.trim() }
    : { backend: "codex", model: config.codexModel.trim() };
}

export function predictionBackend(
  providerId: string,
  config: PredictionBackendConfig,
): PredictionBackendSelection {
  const choice =
    providerId === "codex"
      ? config.codexChats
      : providerId === "claude-code"
        ? config.claudeChats
        : config.otherChats;

  return backendSelection(choice === "claude" ? "claude" : "codex", config);
}

export function alternateBackend(
  backend: "codex" | "claude",
  config: PredictionBackendConfig,
): PredictionBackendSelection {
  return backendSelection(backend === "claude" ? "codex" : "claude", config);
}

export function providerUnavailable(message: string): boolean {
  return (
    message.startsWith(ALLOWANCE_UNAVAILABLE) ||
    message === CLAUDE_ALLOWANCE_MESSAGE ||
    message === CODEX_PLAN_UNAVAILABLE_MESSAGE ||
    message === CODEX_PLANS_UNAVAILABLE_MESSAGE
  );
}

export default async function plugin(api: PluginApi) {
  const reports = registerCompletionReports(api);

  const settings = api.settings.define({
    enabled: { type: "boolean", label: "Composer predictions", default: true },
    codexChats: {
      type: "select",
      label: "Codex chats predict with",
      options: [...PREDICTION_BACKENDS],
      experimental_optionLabels: PREDICTION_BACKEND_LABELS,
      default: "codex",
    },
    claudeChats: {
      type: "select",
      label: "Claude Code chats predict with",
      options: [...PREDICTION_BACKENDS],
      experimental_optionLabels: PREDICTION_BACKEND_LABELS,
      default: "claude",
    },
    otherChats: {
      type: "select",
      label: "Other chats predict with",
      options: [...PREDICTION_BACKENDS],
      experimental_optionLabels: PREDICTION_BACKEND_LABELS,
      default: "codex",
    },
    claudeModel: {
      type: "string",
      label: "Claude prediction model",
      experimental_schema: predictionModelSchema,
      default: "claude-haiku-5-5",
    },
    codexModel: {
      type: "string",
      label: "Codex prediction model",
      description:
        "Used when Codex predicts from a chat transcript. Codex chats predicted by Codex keep their own model.",
      experimental_schema: predictionModelSchema,
      default: "gpt-6.1-sol",
    },
    cliPath: { type: "string", label: "Codex executable", default: "codex" },
    claudeCliPath: {
      type: "string",
      label: "Claude Code executable",
      default: "claude",
    },
  });

  let config = await settings.get();
  let disposed = false;
  const firstGeneration = Date.now();
  const predictions = new Map<string, Prediction>();

  const preparing = new Map<
    string,
    { run: PredictionRun; pending: Promise<PredictionState> }
  >();

  const restoring = new Map<string, Promise<void>>();
  let publishingWork = Promise.resolve();
  const closedThreads = new Set<string>();
  const recordedSkips = new Map<string, string>();
  let saving = Promise.resolve();

  const cacheSchema = z.object({
    sourceSeq: z.number().int().nullable(),
    state: predictionSchema,
  });

  function readSignal(): AbortSignal {
    return AbortSignal.timeout(READ_TIMEOUT_MS);
  }

  function cacheKey(threadId: string): string {
    return `prediction:v1:${threadId}`;
  }

  function failureKey(threadId: string): string {
    return `prediction-failure:v1:${threadId}`;
  }

  function skipKey(threadId: string): string {
    return `prediction-skip:v1:${threadId}`;
  }

  async function diagnostics(threadId: string) {
    await saving.catch(() => {});

    const [failure, skip] = await Promise.all([
      api.storage.kv.get(failureKey(threadId)),
      api.storage.kv.get(skipKey(threadId)),
    ]);

    const parsedFailure = predictionFailureSchema.safeParse(failure);

    const parsedSkip = predictionSkipSchema.safeParse(skip);

    return {
      threadId,
      lastFailure:
        parsedFailure.success && parsedFailure.data.threadId === threadId
          ? parsedFailure.data
          : null,
      lastSkip:
        parsedSkip.success && parsedSkip.data.threadId === threadId
          ? parsedSkip.data
          : null,
    };
  }

  function recordSkip(
    threadId: string,
    reason: PredictionSkipReason,
    sourceSeq: number | null,
  ): void {
    const recorded = `${reason}:${sourceSeq}`;

    if (recordedSkips.get(threadId) === recorded) return;
    recordedSkips.set(threadId, recorded);

    const skip: z.infer<typeof predictionSkipSchema> = {
      threadId,
      sourceSeq,
      skippedAt: Date.now(),
      reason,
      message: predictionSkipMessages[reason],
    };

    api.log.info(`Prediction skipped: ${JSON.stringify(skip)}`);

    const pending = saving
      .catch(() => {})
      .then(() => api.storage.kv.set(skipKey(threadId), skip));

    saving = pending;
    void pending.catch(() =>
      api.log.warn("Prediction skip diagnostics could not be saved."),
    );
  }

  function skip(
    entry: Prediction,
    reason: PredictionSkipReason,
    sourceSeq: number | null,
    work: ThreadWork = null,
  ): PredictionState {
    recordSkip(entry.state.threadId, reason, sourceSeq);
    const message = predictionSkipMessages[reason];
    const state = invalidate(entry, "idle", true, message);

    if (
      !disposed &&
      TERMINAL_SKIPS.has(reason) &&
      work !== null &&
      work.assessment.availability !== "available" &&
      (work.assessment.availability !== "skipped" ||
        work.assessment.reason !== message)
    )
      queueWorkPublication({ ...state, basis: work.basis }, sourceSeq);

    return state;
  }

  function heldOutcome(state: PredictionState): boolean {
    return (
      state.status === "ready" ||
      state.status === "none" ||
      (state.status === "idle" &&
        state.message !== null &&
        terminalSkipMessages.has(state.message))
    );
  }

  function publishedTerminalSkip(
    admission: Awaited<ReturnType<typeof predictionAdmission>> | null,
  ): boolean {
    const assessment = admission?.work?.assessment;

    return (
      assessment?.availability === "skipped" &&
      terminalSkipMessages.has(assessment.reason)
    );
  }

  function recordFailure(
    entry: Prediction,
    error?: unknown,
    timeoutMs: number | null = null,
  ): void {
    const active = entry.activeRequest;

    const failure: z.infer<typeof predictionFailureSchema> = {
      threadId: entry.state.threadId,
      generation: entry.state.generation,
      sourceSeq: active?.sourceSeq ?? entry.sourceSeq,
      hostId: entry.hostId,
      requestId: active?.requestId ?? null,
      stage: active?.stage ?? "preparation",
      failedAt: Date.now(),
      elapsedMs:
        active === null ? null : Math.max(0, Date.now() - active.startedAt),
      attempt: entry.attempts,
      retryAt: entry.retryAt,
      message: entry.state.message ?? "Prediction failed.",
      native: nativeFailure(error),
      cause:
        timeoutMs === null
          ? failureCause(error)
          : { kind: "timeout", timeoutMs },
    };

    api.log.warn(`Prediction failure: ${JSON.stringify(failure)}`);

    const pending = saving
      .catch(() => {})
      .then(() => api.storage.kv.set(failureKey(failure.threadId), failure));

    saving = pending;
    void pending.catch(() =>
      api.log.warn("Prediction failure diagnostics could not be saved."),
    );
  }

  function store(sourceSeq: number, state: PredictionState): Promise<void> {
    const pending = saving
      .catch(() => {})
      .then(() =>
        api.storage.kv.set(cacheKey(state.threadId), { sourceSeq, state }),
      );

    saving = pending;

    return pending;
  }

  async function storedResult(
    threadId: string,
  ): Promise<z.infer<typeof cacheSchema> | null> {
    await saving.catch(() => {});

    const cached = cacheSchema.safeParse(
      await api.storage.kv.get(cacheKey(threadId)),
    );

    return cached.success && cached.data.state.threadId === threadId
      ? cached.data
      : null;
  }

  async function persist(entry: Prediction): Promise<void> {
    const { sourceSeq, state } = entry;

    if (sourceSeq === null || !["ready", "none", "idle"].includes(state.status))
      return;

    if (state.status === "idle") {
      const stored = await storedResult(state.threadId);

      if (stored?.sourceSeq === sourceSeq && stored.state.status !== "idle")
        return;
    }

    await store(sourceSeq, state);
  }

  function forget(threadId: string): void {
    recordedSkips.delete(threadId);

    const pending = saving
      .catch(() => {})
      .then(async () => {
        await api.storage.kv.delete(cacheKey(threadId));
        await api.storage.kv.delete(failureKey(threadId));
        await api.storage.kv.delete(skipKey(threadId));
        await reports.forget(threadId);
      });

    saving = pending;
    void pending.catch(() =>
      api.log.warn("Prediction cache could not be removed."),
    );
  }

  function reusableResult(state: PredictionState, basis: string): boolean {
    if (state.status === "idle") return state.basis === basis;

    if (state.status !== "ready" && state.status !== "none") return false;

    return (
      state.assessmentVersion === ASSESSMENT_VERSION && state.basis === basis
    );
  }

  async function cachedFor(
    threadId: string,
    sourceSeq: number,
    basis: string,
  ): Promise<z.infer<typeof cacheSchema> | null> {
    const cached = await storedResult(threadId);

    return cached?.sourceSeq === sourceSeq &&
      reusableResult(cached.state, basis)
      ? cached
      : null;
  }

  async function finalReply(
    threadId: string,
    completed: {
      seq: number;
      scope: { kind: "thread" } | { kind: "turn"; turnId: string };
    },
  ): Promise<string | null> {
    if (completed.scope.kind !== "turn") return null;
    const turnId = completed.scope.turnId;
    let beforeSeq = completed.seq;

    for (const pageSize of [
      FINAL_REPLY_FIRST_PAGE,
      FINAL_REPLY_EVENT_WINDOW - FINAL_REPLY_FIRST_PAGE,
    ]) {
      const items = await api.sdk.threads.events.list({
        threadId,
        types: ["item/completed"],
        beforeSeq: String(beforeSeq),
        order: "desc",
        limit: String(pageSize),
        signal: readSignal(),
      });

      for (const event of items)
        if (
          event.type === "item/completed" &&
          event.scope.kind === "turn" &&
          event.scope.turnId === turnId &&
          event.data.item.type === "agentMessage" &&
          event.data.item.parentToolCallId === undefined &&
          event.data.item.text.trim() !== ""
        )
          return event.data.item.text;

      const oldest = items.at(-1);

      if (oldest === undefined || items.length < pageSize) return null;
      beforeSeq = oldest.seq;
    }

    return null;
  }

  async function settleWithoutAllowance(
    threadId: string,
    completed: Extract<ThreadEvent, { type: "turn/completed" }>,
    basis: string,
    message: string,
  ): Promise<PredictionState | null> {
    const kept = await cachedFor(threadId, completed.seq, basis);

    if (kept !== null && kept.state.status !== "idle")
      return { ...kept.state, basis };

    const report = await reports.readiness(threadId, completed, readSignal());

    const reply =
      report?.ready === false ? null : await finalReply(threadId, completed);

    const readiness =
      (reply === null ? null : reportedBlocker(reply)) ?? report;

    return readiness === null
      ? null
      : {
          threadId,
          generation: 0,
          basis,
          status: "ready",
          text: null,
          noSuggestionReason: message,
          message: null,
          archiveReadiness: readiness,
          assessmentVersion: ASSESSMENT_VERSION,
        };
  }

  function adopt(
    entry: Prediction,
    cached: z.infer<typeof cacheSchema>,
    basis: string,
    requested = false,
  ): void {
    entry.sourceSeq = cached.sourceSeq;
    entry.requested = requested;
    entry.checked = true;
    entry.restored = true;
    entry.attempts = 0;
    clearRetry(entry);
    entry.state = {
      ...cached.state,
      basis,
      generation: Math.max(cached.state.generation, entry.state.generation) + 1,
    };
    publish(entry);
  }

  async function latestMaintenanceRequestSeq(
    threadId: string,
  ): Promise<number | null> {
    const [request] = await api.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "desc",
      limit: "1",
      signal: readSignal(),
    });

    return request?.type === "client/turn/requested" &&
      request.data.maintenance !== undefined
      ? request.seq
      : null;
  }

  async function ownerCompletion(
    threadId: string,
    latest: ThreadEvent | undefined,
    knownSeq: number | null,
  ): Promise<ThreadEvent | undefined> {
    if (latest === undefined || latest.seq === knownSeq) return latest;

    const maintenanceSeq = await latestMaintenanceRequestSeq(threadId);

    if (maintenanceSeq === null || latest.seq < maintenanceSeq) return latest;

    const [earlier] = await api.sdk.threads.events.list({
      threadId,
      types: ["turn/completed"],
      beforeSeq: String(maintenanceSeq),
      order: "desc",
      limit: "1",
      signal: readSignal(),
    });

    return earlier;
  }

  async function latestOwnerCompletion(
    threadId: string,
    knownSeq: number,
  ): Promise<ThreadEvent | undefined> {
    const [latest] = await api.sdk.threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
      signal: readSignal(),
    });

    return ownerCompletion(threadId, latest, knownSeq);
  }

  async function readCache(entry: Prediction): Promise<void> {
    const threadId = entry.state.threadId;
    const cached = await storedResult(threadId);

    if (cached === null || cached.sourceSeq === null || entry.restored) return;

    const thread = await api.sdk.threads.get({
      threadId,
      signal: readSignal(),
    });

    const events = await api.sdk.threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
      signal: readSignal(),
    });

    if (
      entry.restored ||
      thread.status !== "idle" ||
      thread.queuedMessageCount > 0 ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.work === null ||
      !reusableResult(cached.state, thread.work.basis) ||
      omitsRequiredReply(cached.state, thread.work)
    )
      return;

    const basis = thread.work.basis;
    const source = await ownerCompletion(threadId, events[0], cached.sourceSeq);

    if (entry.restored || source?.seq !== cached.sourceSeq) return;
    adopt(entry, cached, basis);
  }

  async function restore(entry: Prediction): Promise<void> {
    if (entry.restored || !config.enabled) return;
    const threadId = entry.state.threadId;
    const existing = restoring.get(threadId);

    if (existing) return existing;

    const pending = readCache(entry).catch(() => {
      api.log.warn("Prediction cache could not be restored.");
    });

    restoring.set(threadId, pending);

    try {
      await pending;
    } finally {
      restoring.delete(threadId);
      entry.restored = true;
    }
  }

  function persistTransition(entry: Prediction): void {
    void persist(entry).catch(() =>
      api.log.warn("Prediction cache could not be saved."),
    );
  }

  const cancellations = new Set<Promise<void>>();
  const suggestions = new Set<Promise<void>>();
  const warmQueue = new Set<string>();
  const backlogQueue = new Set<string>();
  const urgentThreads = new Set<string>();
  let warming = false;
  let backlogWarming = false;
  let inferenceBusy = false;

  const inferenceWaiters: {
    threadId: string;
    urgent: boolean;
    grant: () => void;
  }[] = [];

  function releaseInference(): void {
    inferenceBusy = false;
    inferenceWaiters.shift()?.grant();
  }

  function queueInferenceWaiter(waiter: (typeof inferenceWaiters)[number]) {
    if (waiter.urgent) inferenceWaiters.unshift(waiter);
    else inferenceWaiters.push(waiter);
  }

  function acquireInference(threadId: string): Promise<() => void> {
    const urgent = urgentThreads.delete(threadId);

    return new Promise((resolve) => {
      const grant = () => {
        inferenceBusy = true;
        let released = false;

        resolve(() => {
          if (released) return;
          released = true;
          releaseInference();
        });
      };

      if (inferenceBusy) queueInferenceWaiter({ threadId, urgent, grant });
      else grant();
    });
  }

  function promoteInference(threadId: string): void {
    const index = inferenceWaiters.findIndex(
      (waiter) => waiter.threadId === threadId && !waiter.urgent,
    );

    if (index < 0) return;
    const [waiter] = inferenceWaiters.splice(index, 1);

    if (waiter) queueInferenceWaiter({ ...waiter, urgent: true });
  }

  let seeding: Promise<Set<string>> | null = null;
  let started = false;

  function cancelPool(threadId: string, requestId: string): void {
    const pending = api.sdk.plugins
      .callRpc({
        pluginId: "account-pool",
        method: "experimental_composer-predictions.v1.cancel",
        input: { threadId, requestId },
        outputSchema: z.object({ cancelled: z.boolean() }).strict(),
        signal: AbortSignal.timeout(5_000),
      })
      .then(() => {})
      .catch(() => {
        api.log.warn(
          "Account Pooler prediction cancellation could not be confirmed.",
        );
      })
      .finally(() => {
        cancellations.delete(pending);
      });

    cancellations.add(pending);
  }

  async function chatTags(): Promise<z.infer<typeof chatTagsSchema>["tags"]> {
    try {
      const signal = AbortSignal.timeout(TAG_TIMEOUT_MS);
      const { plugins } = await api.sdk.plugins.list({ signal });

      if (
        !plugins.some((plugin) => plugin.id === "chat-topics" && plugin.enabled)
      )
        return [];

      const { tags } = await api.sdk.plugins.callRpc({
        pluginId: "chat-topics",
        method: "tags.list",
        input: {},
        outputSchema: chatTagsSchema,
        signal,
      });

      return tags;
    } catch {
      api.log.warn("Chat tags could not be read. Predicting without a tag.");

      return [];
    }
  }

  function suggestTag(threadId: string, tagId: string): void {
    const pending = api.sdk.plugins
      .callRpc({
        pluginId: "chat-topics",
        method: "tag.suggest",
        input: { threadId, tagId },
        outputSchema: z.object({ applied: z.boolean() }),
        signal: AbortSignal.timeout(TAG_TIMEOUT_MS),
      })
      .then(() => {})
      .catch(() => {
        api.log.warn("The predicted chat tag could not be suggested.");
      })
      .finally(() => {
        suggestions.delete(pending);
      });

    suggestions.add(pending);
  }

  function prediction(threadId: string): Prediction {
    const existing = predictions.get(threadId);

    if (existing) return existing;

    const created: Prediction = {
      state: {
        threadId,
        generation: firstGeneration,
        basis: null,
        status: config.enabled ? "idle" : "disabled",
        text: null,
        noSuggestionReason: null,
        message: null,
        archiveReadiness: null,
      },
      sourceSeq: null,
      hostId: null,
      controller: null,
      task: null,
      requested: false,
      epoch: 0,
      restored: false,
      checked: false,
      attempts: 0,
      retryAt: null,
      retryTimer: null,
      activeRequest: null,
    };

    predictions.set(threadId, created);

    return created;
  }

  async function publishWork(
    state: PredictionState,
    sourceSeq: number | null,
  ): Promise<void> {
    const available = state.status === "ready" || state.status === "none";
    let basis = state.basis;

    if (basis === null) {
      if (state.status !== "disabled" && state.status !== "failed") return;

      const [thread] = await api.sdk.threads.list({
        threadIds: [state.threadId],
        includeHidden: true,
        signal: readSignal(),
      });

      basis = thread?.work?.basis ?? null;
    }

    if (basis === null) return;

    const availability = available
      ? "available"
      : state.status === "predicting"
        ? "checking"
        : state.status === "disabled"
          ? "disabled"
          : state.status === "failed"
            ? "failed"
            : "skipped";

    const reason = available
      ? (state.archiveReadiness?.reason ??
        state.noSuggestionReason ??
        state.message ??
        (state.text
          ? "A next message is suggested."
          : "No suggested reply was returned."))
      : (state.message ??
        (state.status === "predicting"
          ? "Assessing the completed chat."
          : state.status === "disabled"
            ? "Predictions are disabled."
            : "No completion assessment has been prepared."));

    try {
      await api.sdk.threads.experimental_publishWork({
        threadId: state.threadId,
        pluginId: api.pluginId,
        contribution: {
          kind: "assessment",
          assessment: {
            basis,
            contractVersion: 1,
            availability,
            reason,
            sourceSeq,
            text: available ? state.text : null,
            noSuggestionReason: available ? state.noSuggestionReason : null,
            waitingOn: available
              ? (state.archiveReadiness?.waitingOn ?? null)
              : null,
            ask: available ? (state.archiveReadiness?.ask ?? null) : null,
            recap: available ? (state.archiveReadiness?.recap ?? null) : null,
            archiveReady: available
              ? (state.archiveReadiness?.ready ?? null)
              : null,
          },
        },
        signal: readSignal(),
      });
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 409) {
        recordSkip(state.threadId, "changed", sourceSeq);
        api.log.info("A stale completion assessment was discarded.");

        return;
      }

      throw error;
    }
  }

  function queueWorkPublication(
    state: PredictionState,
    sourceSeq: number | null,
  ): void {
    const published = { ...state };
    publishingWork = publishingWork
      .catch(() => {})
      .then(() => publishWork(published, sourceSeq));
    void publishingWork.catch(() =>
      api.log.warn("The chat work assessment could not be published."),
    );
  }

  function publish(entry: Prediction): PredictionState {
    if (!disposed) {
      queueWorkPublication(entry.state, entry.sourceSeq);
      api.realtime.publish("predictions-changed", entry.state);
    }

    return entry.state;
  }

  function clearRetry(entry: Prediction): void {
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    entry.retryAt = null;
  }

  function scheduleRetry(entry: Prediction, message: string): void {
    clearRetry(entry);
    entry.attempts += 1;
    const delay = retryDelay(message, entry.attempts);

    if (delay === null || disposed) return;
    const threadId = entry.state.threadId;
    entry.retryAt = Date.now() + delay;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      warm(threadId);
    }, delay);
    entry.retryTimer.unref?.();
  }

  function invalidate(
    entry: Prediction,
    status: PredictionState["status"],
    clearSource: boolean,
    message: string | null = null,
    archiveReadiness: PredictionState["archiveReadiness"] = null,
  ): PredictionState {
    entry.epoch += 1;
    entry.restored = true;

    if (clearSource) {
      entry.attempts = 0;
      clearRetry(entry);
    }

    if (
      entry.controller === null &&
      entry.state.status === status &&
      entry.state.text === null &&
      entry.state.noSuggestionReason === null &&
      entry.state.message === message &&
      entry.state.archiveReadiness === archiveReadiness &&
      (!clearSource || entry.sourceSeq === null)
    )
      return entry.state;

    entry.controller?.abort();
    entry.controller = null;
    entry.task = null;
    entry.requested = false;

    entry.activeRequest = null;

    if (clearSource) entry.sourceSeq = null;
    entry.state = {
      ...entry.state,
      generation: entry.state.generation + 1,
      basis: clearSource ? null : entry.state.basis,
      status,
      text: null,
      noSuggestionReason: null,
      message,
      archiveReadiness,
    };

    persistTransition(entry);

    return publish(entry);
  }

  function fail(entry: Prediction, message: string): PredictionState {
    entry.epoch += 1;
    entry.restored = true;

    entry.controller?.abort();
    entry.controller = null;
    entry.task = null;
    entry.requested = false;
    entry.state = {
      ...entry.state,
      generation: entry.state.generation + 1,
      status: "failed",
      text: null,
      noSuggestionReason: null,
      message,
      archiveReadiness: null,
    };

    scheduleRetry(entry, message);
    recordFailure(entry);
    entry.activeRequest = null;
    persistTransition(entry);

    return publish(entry);
  }

  function heldForUser(entry: Prediction, sourceSeq: number | null): boolean {
    return (
      entry.requested &&
      sourceSeq !== null &&
      entry.sourceSeq === sourceSeq &&
      ["predicting", "ready", "none", "failed"].includes(entry.state.status)
    );
  }

  async function prepare(
    threadId: string,
    background: boolean,
    run: PredictionRun,
  ): Promise<PredictionState> {
    const reuse = run === "reuse";
    const entry = prediction(threadId);
    await restore(entry);

    if (!config.enabled)
      return entry.state.status === "disabled"
        ? entry.state
        : invalidate(entry, "disabled", true);
    const observedEpoch = entry.epoch;
    let admitted: Awaited<ReturnType<typeof predictionAdmission>> | null = null;

    try {
      const admission = await predictionAdmission(api, threadId, background);
      admitted = admission;

      const [thread, events] = await Promise.all([
        checkRead("the chat", (signal) =>
          api.sdk.threads.get({ threadId, include: "environment", signal }),
        ),
        checkRead("the chat’s turns", (signal) =>
          api.sdk.threads.events.list({
            threadId,
            types: ["turn/completed"],
            order: "desc",
            limit: "1",
            signal,
          }),
        ),
      ]);

      if (disposed || entry.epoch !== observedEpoch) return entry.state;
      entry.checked = true;

      if (thread.archivedAt !== null || thread.deletedAt !== null)
        closedThreads.add(threadId);
      else closedThreads.delete(threadId);

      const basis = admission.work?.basis ?? null;
      const closed = thread.archivedAt !== null || thread.deletedAt !== null;

      if (thread.status !== "idle" || thread.queuedMessageCount > 0 || closed) {
        if (background && thread.status !== "idle" && !closed) {
          const maintenanceSeq = await checkRead("the chat’s turns", () =>
            latestMaintenanceRequestSeq(threadId),
          );

          if (
            disposed ||
            entry.epoch !== observedEpoch ||
            maintenanceSeq !== null
          )
            return entry.state;
        }

        return background
          ? skip(
              entry,
              closed ? "closed" : thread.status !== "idle" ? "busy" : "queued",
              events[0]?.seq ?? null,
              admission.work,
            )
          : fail(
              entry,
              "Predictions require an idle thread with no queued messages.",
            );
      }

      const knownSeq = entry.sourceSeq;

      const source = await checkRead("the chat’s turns", () =>
        ownerCompletion(threadId, events[0], knownSeq),
      );

      if (disposed || entry.epoch !== observedEpoch) return entry.state;
      const sourceSeq = source?.seq ?? null;

      const environment = "environment" in thread ? thread.environment : null;

      if (!environment?.hostId || !environment.path)
        return background
          ? skip(entry, "no-environment", sourceSeq)
          : fail(entry, "The thread has no available environment.");

      if (admission.blocker !== null)
        return background &&
          admission.backgroundOnly &&
          heldForUser(entry, sourceSeq)
          ? entry.state
          : skip(entry, admission.blocker, sourceSeq, admission.work);

      if (
        !source ||
        source.type !== "turn/completed" ||
        source.data.status !== "completed" ||
        (thread.providerId === "codex" &&
          (!source.data.providerThreadId || !source.data.providerCheckpointId))
      ) {
        return background
          ? skip(entry, "no-completed-turn", sourceSeq, admission.work)
          : fail(entry, "Complete a turn before requesting a prediction.");
      }

      if (
        reuse &&
        basis !== null &&
        (entry.sourceSeq !== source.seq ||
          entry.state.status === "failed" ||
          entry.state.status === "idle")
      ) {
        const cached = await checkRead("the stored prediction", () =>
          cachedFor(threadId, source.seq, basis),
        );

        if (disposed || entry.epoch !== observedEpoch) return entry.state;

        if (
          cached &&
          (background || cached.state.status !== "idle") &&
          !omitsRequiredReply(cached.state, admission.work)
        ) {
          adopt(entry, cached, basis, !background);

          return entry.state;
        }
      }

      if (
        entry.sourceSeq === source.seq &&
        reuse &&
        (entry.state.basis === basis || entry.state.status === "failed")
      ) {
        const retryDue =
          entry.state.status === "failed" &&
          entry.retryAt !== null &&
          Date.now() >= entry.retryAt;

        if (
          background
            ? !retryDue
            : !["failed", "idle"].includes(entry.state.status)
        )
          return entry.state;
      } else if (entry.state.status !== "failed") entry.attempts = 0;

      if (basis === null)
        return fail(
          entry,
          "Work status is unavailable. Retry when Omnyo is available.",
        );
      entry.hostId = environment.hostId;

      const hostId = environment.hostId;

      const [machine, tags] = await Promise.all([
        checkRead("the chat’s machine", (signal) =>
          api.sdk.hosts.get({ hostId, signal }),
        ),
        chatTags(),
      ]);

      if (disposed || entry.epoch !== observedEpoch) return entry.state;

      if (
        machine.status !== "connected" ||
        machine.lifecycle.phase !== "active"
      ) {
        entry.sourceSeq = null;

        return fail(entry, MACHINE_UNAVAILABLE_MESSAGE);
      }

      entry.controller?.abort();
      clearRetry(entry);
      const controller = new AbortController();
      const deadline = new AbortController();
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let releaseSlot = () => {};

      const slot = background ? acquireInference(threadId) : null;

      entry.controller = controller;
      entry.requested = !background;
      entry.sourceSeq = source.seq;
      entry.restored = true;
      const generation = entry.state.generation + 1;
      entry.state = {
        threadId,
        generation,
        basis,
        status: "predicting",
        text: null,
        noSuggestionReason: null,
        message: null,
        archiveReadiness: null,
      };
      publish(entry);
      let requestId = randomUUID();

      let activeRequest = {
        requestId,
        sourceSeq: source.seq,
        startedAt: Date.now(),
        stage: "inference" as const,
      };

      entry.activeRequest = activeRequest;
      const onAbort = () => cancelPool(threadId, requestId);

      const replyRequired = run === "forced" || !ownsNextStep(admission.work);

      const requestPrediction = (selection: PredictionBackendSelection) =>
        api.sdk.plugins.callRpc({
          pluginId: "account-pool",
          method: "experimental_composer-predictions.v1.predict",
          input: {
            threadId,
            requestId,
            cliPath: config.cliPath,
            claudeCliPath: config.claudeCliPath,
            includedOnly: false,
            ...selection,
            ...(tags.length === 0 ? {} : { tags }),
            ...(replyRequired ? { force: true } : {}),
          },
          outputSchema: poolPredictionSchema,
          signal: AbortSignal.any([controller.signal, deadline.signal]),
        });

      const primary = predictionBackend(thread.providerId, config);

      const onPrediction = async (
        result: z.infer<typeof poolPredictionSchema>,
      ) => {
        if (
          disposed ||
          controller.signal.aborted ||
          entry.state.generation !== generation
        )
          return;
        entry.activeRequest = { ...activeRequest, stage: "validation" };
        const text = result.text?.trim() || null;
        let archiveReadiness = result.archiveReadiness;

        if (archiveReadiness?.ready === true) {
          const checkedReadiness = await Promise.all([
            reports.readiness(threadId, source, controller.signal),
            finalReply(threadId, source),
          ])
            .then(([report, reply]) =>
              report?.ready === false
                ? report
                : reply === null
                  ? null
                  : (reportedBlocker(reply) ?? archiveReadiness),
            )
            .catch(() => {
              api.log.warn(
                "Archive readiness withheld because the completion evidence could not be read.",
              );

              return null;
            });

          if (
            disposed ||
            controller.signal.aborted ||
            entry.state.generation !== generation
          )
            return;

          archiveReadiness = checkedReadiness;
        }

        const completed: PredictionState = {
          threadId,
          generation,
          basis,
          status:
            text === null &&
            archiveReadiness === null &&
            result.noSuggestionReason === null
              ? "none"
              : "ready",
          text,
          noSuggestionReason: text === null ? result.noSuggestionReason : null,
          message: null,
          archiveReadiness,
          assessmentVersion: ASSESSMENT_VERSION,
          ...(run === "forced" ? { forced: true } : {}),
        };

        await store(source.seq, completed);

        if (
          disposed ||
          controller.signal.aborted ||
          entry.state.generation !== generation
        )
          return;

        const current = await Promise.all([
          predictionAdmission(api, threadId, background),
          latestOwnerCompletion(threadId, source.seq),
        ]).catch(() => {
          api.log.warn(
            "A finished prediction could not be rechecked. Core rejects it if the chat changed.",
          );

          return null;
        });

        if (
          disposed ||
          controller.signal.aborted ||
          entry.state.generation !== generation
        )
          return;

        if (current !== null) {
          const [admission, currentSource] = current;

          if (
            admission.blocker !== null ||
            admission.work?.basis !== basis ||
            currentSource?.seq !== source.seq
          ) {
            skip(
              entry,
              admission.blocker ?? "changed",
              source.seq,
              admission.work,
            );

            return;
          }
        }

        entry.attempts = 0;
        entry.state = completed;
        publish(entry);

        const tag = tags.find(({ id }) => id === result.tag);

        if (tag) suggestTag(threadId, tag.id);
      };

      const infer = () => {
        if (
          disposed ||
          controller.signal.aborted ||
          entry.state.generation !== generation
        )
          return;
        activeRequest = { ...activeRequest, startedAt: Date.now() };
        entry.activeRequest = activeRequest;
        controller.signal.addEventListener("abort", onAbort, { once: true });
        deadline.signal.addEventListener("abort", onAbort, { once: true });
        deadlineTimer = setTimeout(
          () => deadline.abort(),
          PREDICTION_TIMEOUT_MS,
        );
        deadlineTimer.unref?.();

        return requestPrediction(primary).then(onPrediction, fallback);
      };

      const fallback = (error: unknown) => {
        const reported = predictionFailureMessage(
          error instanceof Error ? error.message : "",
        );

        if (
          disposed ||
          controller.signal.aborted ||
          deadline.signal.aborted ||
          entry.state.generation !== generation ||
          !providerUnavailable(reported)
        )
          throw error;
        const alternate = alternateBackend(primary.backend, config);
        api.log.warn(
          `${PREDICTION_BACKEND_LABELS[primary.backend]} cannot predict this chat (${reported}) Predicting with ${PREDICTION_BACKEND_LABELS[alternate.backend]} instead.`,
        );
        requestId = randomUUID();
        activeRequest = { ...activeRequest, requestId };
        entry.activeRequest = activeRequest;

        return requestPrediction(alternate).then(onPrediction);
      };

      entry.task = (
        slot === null
          ? Promise.resolve(infer())
          : slot.then((release) => {
              releaseSlot = release;

              return infer();
            })
      )
        .catch(async (error) => {
          const timedOut = deadline.signal.aborted;

          if (
            disposed ||
            controller.signal.aborted ||
            entry.state.generation !== generation
          )
            return;

          const reported = timedOut
            ? TIMED_OUT_MESSAGE
            : run === "forced" && refusedForce(error)
              ? FORCE_UNAVAILABLE_MESSAGE
              : predictionFailureMessage(
                  error instanceof Error ? error.message : "",
                );

          const message =
            retryDelay(reported, 1) === null ||
            (await machineAvailable(environment.hostId))
              ? reported
              : MACHINE_UNAVAILABLE_MESSAGE;

          if (
            disposed ||
            controller.signal.aborted ||
            entry.state.generation !== generation
          )
            return;

          const settled =
            run !== "forced" && message.startsWith(ALLOWANCE_UNAVAILABLE)
              ? await settleWithoutAllowance(
                  threadId,
                  source,
                  basis,
                  message,
                ).catch(() => null)
              : null;

          if (
            disposed ||
            controller.signal.aborted ||
            entry.state.generation !== generation
          )
            return;

          if (machineFailures.has(message)) entry.sourceSeq = null;
          entry.state = {
            threadId,
            generation,
            basis,
            status: "failed",
            text: null,
            noSuggestionReason: null,
            message,
            archiveReadiness: null,
            ...(run === "forced" ? { forced: true } : {}),
          };

          if (settled === null) scheduleRetry(entry, message);
          else clearRetry(entry);
          recordFailure(entry, error, timedOut ? PREDICTION_TIMEOUT_MS : null);

          if (settled !== null) {
            entry.attempts = 0;
            entry.state = { ...settled, generation };
          }

          persistTransition(entry);
          publish(entry);
        })
        .finally(() => {
          releaseSlot();
          clearTimeout(deadlineTimer);
          controller.signal.removeEventListener("abort", onAbort);
          deadline.signal.removeEventListener("abort", onAbort);

          if (entry.controller !== controller) return;
          entry.controller = null;
          entry.task = null;
          entry.activeRequest = null;
        });

      return entry.state;
    } catch (error) {
      if (disposed || entry.epoch !== observedEpoch) return entry.state;

      const message =
        error instanceof PredictionReadinessError
          ? error.message
          : PREPARATION_FAILED_MESSAGE;

      if (
        background &&
        (heldOutcome(entry.state) || publishedTerminalSkip(admitted))
      ) {
        api.log.warn(
          `A background recheck failed and the chat’s last outcome stays current. ${message}`,
        );

        return entry.state;
      }

      return fail(entry, message);
    }
  }

  async function machineAvailable(hostId: string): Promise<boolean> {
    try {
      const machine = await api.sdk.hosts.get({ hostId, signal: readSignal() });

      return (
        machine.status === "connected" && machine.lifecycle.phase === "active"
      );
    } catch {
      return true;
    }
  }

  async function request(
    threadId: string,
    background = false,
    run: PredictionRun = "reuse",
  ): Promise<PredictionState> {
    const existing = preparing.get(threadId);

    if (existing && RUN_STRENGTH[existing.run] >= RUN_STRENGTH[run])
      return existing.pending;

    const pending = existing
      ? existing.pending
          .catch(() => undefined)
          .then(() => prepare(threadId, background, run))
      : prepare(threadId, background, run);

    preparing.set(threadId, { run, pending });

    try {
      return await pending;
    } finally {
      if (preparing.get(threadId)?.pending === pending)
        preparing.delete(threadId);
    }
  }

  async function drainWarmQueue(): Promise<void> {
    if (warming) return;
    warming = true;

    try {
      for (const threadId of warmQueue) {
        warmQueue.delete(threadId);

        if (disposed || !config.enabled) break;

        if (closedThreads.has(threadId)) continue;

        try {
          await request(threadId, true);
        } catch (error) {
          if (disposed || !config.enabled) break;
          failReadiness(threadId, error);
        } finally {
          urgentThreads.delete(threadId);
        }
      }
    } finally {
      warming = false;
    }
  }

  async function drainBacklog(): Promise<void> {
    if (backlogWarming) return;
    backlogWarming = true;

    try {
      for (const threadId of backlogQueue) {
        backlogQueue.delete(threadId);

        if (disposed || !config.enabled) break;

        if (closedThreads.has(threadId)) continue;

        try {
          await request(threadId, true);
          await predictions.get(threadId)?.task;
        } catch (error) {
          if (disposed || !config.enabled) break;
          failReadiness(threadId, error);
        }
      }
    } finally {
      backlogWarming = false;
    }
  }

  function dequeue(threadId: string): void {
    warmQueue.delete(threadId);
    backlogQueue.delete(threadId);
    urgentThreads.delete(threadId);
  }

  function clearWarmQueues(): void {
    warmQueue.clear();
    backlogQueue.clear();
    urgentThreads.clear();
  }

  function failReadiness(threadId: string, error: unknown): void {
    fail(
      prediction(threadId),
      error instanceof PredictionReadinessError
        ? error.message
        : "Prediction readiness could not be checked. Retry when Omnyo is available.",
    );
  }

  function warm(threadId: string, prioritize = true): void {
    if (disposed || !config.enabled || closedThreads.has(threadId)) return;

    if (!prioritize) {
      if (warmQueue.has(threadId)) return;
      backlogQueue.add(threadId);
      void drainBacklog();

      return;
    }

    backlogQueue.delete(threadId);

    promoteInference(threadId);
    urgentThreads.add(threadId);
    const waiting = [...warmQueue];
    warmQueue.clear();
    warmQueue.add(threadId);

    for (const queued of waiting) warmQueue.add(queued);
    void drainWarmQueue();
  }

  async function restoreCached(threadIds: string[]): Promise<void> {
    const pending = [...threadIds];

    const worker = async () => {
      for (
        let threadId = pending.shift();
        threadId !== undefined && !disposed && config.enabled;
        threadId = pending.shift()
      )
        await restore(prediction(threadId));
    };

    await Promise.all(Array.from({ length: RESTORE_CONCURRENCY }, worker));
  }

  async function seedThreads(hostId?: string): Promise<Set<string>> {
    const seen = new Set<string>();

    const idle: {
      id: string;
      updatedAt: number;
      work: {
        basis: string;
        activity: readonly unknown[];
        waits: readonly unknown[];
        assessment: {
          availability: string;
          suggestion: string;
          noSuggestionReason: string | null;
        };
      } | null;
    }[] = [];

    for (let offset = 0; !disposed && config.enabled; offset += 100) {
      const threads = await api.sdk.threads.list({
        archived: false,
        hostId,
        hasParent: false,
        limit: 100,
        offset,
        signal: AbortSignal.timeout(15_000),
      });

      for (const thread of threads) {
        seen.add(thread.id);

        if (thread.status === "idle") idle.push(thread);
      }

      if (threads.length < 100) break;
    }

    const recent = idle.sort((left, right) => right.updatedAt - left.updatedAt);

    void restoreCached(recent.map((thread) => thread.id));

    for (const thread of recent) {
      const { work } = thread;
      const held = predictions.get(thread.id)?.state;

      if (
        work?.assessment.availability !== "available" ||
        (work.assessment.suggestion === "omitted" &&
          work.assessment.noSuggestionReason !== null &&
          !ownsNextStep(work) &&
          (held === undefined ||
            held.basis !== work.basis ||
            !heldOutcome(held)))
      )
        warm(thread.id, false);
    }

    for (let offset = 0; !disposed && config.enabled; offset += 100) {
      const children = await api.sdk.threads.list({
        archived: false,
        hostId,
        hasParent: true,
        limit: 100,
        offset,
        signal: AbortSignal.timeout(15_000),
      });

      for (const child of children) {
        seen.add(child.id);
        const assessment = child.work?.assessment;

        if (
          child.status === "idle" &&
          assessment !== undefined &&
          assessment.availability !== "available" &&
          (assessment.availability !== "skipped" ||
            assessment.reason !== predictionSkipMessages.child)
        )
          warm(child.id, false);
      }

      if (children.length < 100) break;
    }

    return seen;
  }

  function seed(hostId?: string): Promise<Set<string>> {
    if (hostId !== undefined) return seedThreads(hostId);

    if (seeding) return seeding;

    const pending = seedThreads().finally(() => {
      if (seeding === pending) seeding = null;
    });

    seeding = pending;

    return pending;
  }

  async function pruneCache(open: Set<string>): Promise<void> {
    for (const prefix of [cacheKey(""), failureKey(""), skipKey("")]) {
      const keys = await api.storage.kv.list(prefix);

      for (const key of keys) {
        if (disposed) return;
        const threadId = key.slice(prefix.length);

        if (open.has(threadId)) continue;

        try {
          const thread = await api.sdk.threads.get({
            threadId,
            signal: readSignal(),
          });

          if (thread.deletedAt !== null) forget(threadId);
        } catch (error) {
          if (
            error instanceof Error &&
            "status" in error &&
            error.status === 404
          )
            forget(threadId);
        }
      }
    }
  }

  api.background.service("prewarm", {
    async start(signal) {
      started = true;

      const unsubscribe = api.sdk.subscribe({
        event: "thread:changed",
        callback: ({ id, changes }) => {
          if (
            id !== undefined &&
            !closedThreads.has(id) &&
            changes.some(
              (change) =>
                change === "status-changed" ||
                change === "interactions-changed" ||
                change === "queue-changed" ||
                change === "parent-changed" ||
                change === "work-changed",
            )
          )
            warm(id);
        },
      });

      const unsubscribeHosts = api.sdk.subscribe({
        event: "host:changed",
        callback: ({ id, changes }) => {
          if (id !== undefined && changes.includes("host-disconnected"))
            for (const entry of predictions.values())
              if (entry.hostId === id && entry.state.status === "predicting") {
                entry.sourceSeq = null;
                fail(entry, MACHINE_UNAVAILABLE_MESSAGE);
              }

          if (id !== undefined && changes.includes("host-connected")) {
            for (const entry of predictions.values())
              if (
                entry.hostId === id &&
                entry.state.status === "failed" &&
                entry.state.message !== null &&
                machineFailures.has(entry.state.message)
              ) {
                entry.attempts = 0;
                entry.sourceSeq = null;
                clearRetry(entry);
              }

            void seed(id).catch(() =>
              api.log.warn(
                "Prediction prewarm could not inspect reconnected chats.",
              ),
            );
          }
        },
      });

      const sweep = setInterval(() => {
        void seed().catch(() =>
          api.log.warn("Prediction prewarm could not inspect idle chats."),
        );
      }, SWEEP_INTERVAL_MS);

      try {
        await seed()
          .then((open) => pruneCache(open))
          .catch(() =>
            api.log.warn("Prediction prewarm could not inspect idle chats."),
          );

        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
      } finally {
        clearInterval(sweep);
        unsubscribe();
        unsubscribeHosts();
        started = false;
      }
    },
  });

  function stop(
    threadId: string,
    generation: number,
    status: "idle" | "none",
  ): PredictionState {
    const entry = prediction(threadId);

    if (entry.state.generation !== generation) return entry.state;

    return invalidate(
      entry,
      status,
      false,
      status === "none"
        ? "The suggestion was dismissed."
        : "The prediction was cancelled.",
      status === "none" ? entry.state.archiveReadiness : null,
    );
  }

  api.rpc.register(rpcContract, {
    state: async ({ threadId }) => {
      const entry = prediction(threadId);
      let timer: ReturnType<typeof setTimeout> | undefined;

      await Promise.race([
        restore(entry),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STATE_READ_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);

      return entry.state;
    },
    request: ({ threadId, fresh, force }) =>
      request(threadId, false, manualRun(fresh, force)),
    diagnostics: ({ threadId }) => diagnostics(threadId),
    dismiss: ({ threadId, generation }) => stop(threadId, generation, "none"),
    cancel: ({ threadId, generation }) => stop(threadId, generation, "idle"),
  });

  settings.onChange((next) => {
    config = next;

    for (const entry of predictions.values())
      invalidate(entry, config.enabled ? "idle" : "disabled", true);

    clearWarmQueues();

    if (started && config.enabled)
      void seed().catch(() =>
        api.log.warn("Background prediction readiness could not be checked."),
      );
  });

  for (const event of [
    "thread.active",
    "thread.failed",
    "thread.archived",
    "thread.deleted",
  ] as const) {
    api.events.on(event, async ({ thread }) => {
      if (event === "thread.archived" || event === "thread.deleted")
        closedThreads.add(thread.id);

      if (event === "thread.deleted") forget(thread.id);
      const entry = predictions.get(thread.id);

      if (entry) invalidate(entry, config.enabled ? "idle" : "disabled", true);
    });
  }

  api.events.on("thread.idle", ({ thread }) => {
    if (thread.archivedAt === null && thread.deletedAt === null)
      warm(thread.id);
  });

  api.events.on("thread.unarchived", ({ thread }) => {
    closedThreads.delete(thread.id);
    warm(thread.id);
  });

  api.events.on(
    "experimental_thread.events",
    ({ thread }) => {
      if (thread.status === "idle" && thread.archivedAt === null)
        warm(thread.id);
    },
    {
      experimental_eventTypes: [
        "thread/started",
        "thread/identity",
        "turn/started",
        "turn/completed",
        "turn/input/accepted",
        "thread/name/updated",
        "thread/compacted",
        "thread/context/cleared",
        "thread/goal/updated",
        "thread/goal/cleared",
        "item/started",
        "item/completed",
        "item/mcpToolCall/progress",
        "item/toolCall/progress",
        "item/backgroundTask/progress",
        "item/backgroundTask/completed",
        "item/delegation/progress",
        "item/delegation/completed",
        "thread/tokenUsage/updated",
        "thread/contextWindowUsage/updated",
        "turn/plan/updated",
        "turn/diff/updated",
        "turn/mainRun/updated",
        "provider/error",
        "provider/rateLimits/updated",
        "provider.env-resolved",
        "thread/extensionState/updated",
        "provider/warning",
        "provider/modelFallback",
        "provider/unhandled",
        "client/thread/start",
        "client/turn/requested",
        "client/turn/rejected",
        "client/turn/start",
        "system/error",
        "system/manager/user_message",
        "system/thread/interrupted",
        "system/operation",
        "system/interaction/lifecycle",
        "system/permissionGrant/lifecycle",
        "system/userQuestion/lifecycle",
        "system/thread-provisioning",
        "system/git-activity",
        "system/provider-turn-watchdog",
      ],
    },
  );
  api.events.on("interaction.pending", ({ thread }) => {
    const entry = predictions.get(thread.id);

    if (entry) invalidate(entry, "idle", true);
    dequeue(thread.id);
  });

  for (const event of ["message.queued", "message.dispatched"] as const)
    api.events.on(event, ({ entry: message }) => {
      const entry = predictions.get(message.threadId);

      if (entry) invalidate(entry, "idle", true);
      dequeue(message.threadId);
    });

  api.events.on("message.cancelled", ({ entry }) => warm(entry.threadId));

  api.onDispose(async () => {
    disposed = true;
    clearWarmQueues();

    for (const entry of predictions.values()) {
      clearRetry(entry);
      entry.controller?.abort();
    }

    predictions.clear();
    preparing.clear();
    await Promise.all(cancellations);
    await Promise.all(suggestions);
    await publishingWork.catch(() => {});
    await saving.catch(() => {});
  });

  const usage =
    "Usage: omnyo composer-predictions <status|diagnostics> <thread-id> [--json]\n       omnyo composer-predictions request <thread-id> [--fresh | --force] [--json]";

  api.cli.register({
    name: "composer-predictions",
    summary: "Inspect next-message and archive-readiness predictions",
    commands: [
      {
        name: "status",
        summary:
          "Inspect cached next-message and archive-readiness predictions",
        usage: "omnyo composer-predictions status <thread-id> [--json]",
      },
      {
        name: "diagnostics",
        summary: "Inspect the retained safe failure record without inference",
        usage: "omnyo composer-predictions diagnostics <thread-id> [--json]",
      },
      {
        name: "request",
        summary: "Request and await a prediction using Codex allowance",
        usage:
          "omnyo composer-predictions request <thread-id> [--fresh | --force] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const fresh = argv.includes("--fresh");
      const force = argv.includes("--force");

      const args = argv.filter(
        (argument) => !["--json", "--fresh", "--force"].includes(argument),
      );

      const [command, threadId] = args;

      if (command === undefined || command === "help" || command === "--help")
        return { exitCode: 0, stdout: usage };

      if (
        !["status", "diagnostics", "request"].includes(command) ||
        !threadId ||
        args.length !== 2 ||
        (fresh && force) ||
        ((fresh || force) && command !== "request")
      )
        return { exitCode: 1, stderr: usage };

      if (command === "diagnostics") {
        const result = await diagnostics(threadId);

        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(result)
            : [
                result.lastFailure === null
                  ? "No recorded prediction failure."
                  : JSON.stringify(result.lastFailure, null, 2),
                result.lastSkip === null
                  ? "No recorded prediction skip."
                  : JSON.stringify(result.lastSkip, null, 2),
              ].join("\n"),
        };
      }

      await restore(prediction(threadId));
      let state = prediction(threadId).state;

      if (command === "request") {
        state = await request(threadId, false, manualRun(fresh, force));
        const task = prediction(threadId).task;

        if (task) await task;
        state = prediction(threadId).state;
      }

      const archive = state.archiveReadiness;

      const archiveSummary =
        archive === null
          ? ""
          : `\n${archiveVerdictLabel(archive)}: ${archive.reason}`;

      const stdout = json
        ? JSON.stringify(state)
        : `${state.status}${state.status === "ready" && state.text === null ? `: No suggested reply. ${state.noSuggestionReason ?? "This prediction did not record why it omitted a reply."}` : ""}${state.text ? `: ${state.text}` : state.message ? `: ${state.message}` : ""}${archiveSummary}`;

      return { exitCode: state.status === "failed" ? 1 : 0, stdout };
    },
  });
}
