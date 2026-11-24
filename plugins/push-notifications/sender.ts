import { randomUUID } from "node:crypto";
import type { PluginApi, PluginThreadEventPayloads } from "@omnyo/plugin-sdk";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";
import { z } from "zod";
import type { ClientNotification, PushSubscription } from "./contract.js";
import { openNativeQuestion } from "./native-question.js";
import { notificationPreviewText, truncate } from "./notification-text.js";
import { DEFAULT_PRESENCE_STALE_MS, type Presence } from "./presence.js";
import {
  NOTIFICATION_KINDS_BY_LEVEL,
  pushNotificationKindSchema,
  type NotificationLevel,
  type PushNotificationKind,
} from "./preferences.js";
import type { PushSubscriptionStore } from "./subscriptions.js";

type PushErrorDiagnostic = NonNullable<
  Parameters<
    PluginApi["experimental_reportError"]
  >[1]["experimental_diagnostic"]
>;

const transportCodeSchema = z.enum([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
] satisfies NonNullable<PushErrorDiagnostic["transportCode"]>[]);

type ThreadResponse = PluginThreadEventPayloads["thread.idle"]["thread"];

type ThreadListEntry = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["list"]>
>[number];

type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

const EXPO_PUSH_BATCH_SIZE = 100;

const QUESTION_FRESH_MS = 60_000;

const DEFAULT_COALESCE_MS = 2_000;

const DEFAULT_ASSESSMENT_WAIT_MS = 30_000;

const DEFAULT_ASSESSMENT_START_GRACE_MS = 5_000;

const DEFAULT_ASSESSMENT_POLL_MS = 1_000;

const THREAD_ACTIVITY_PAGE_SIZE = 100;

const PUSH_TITLE_MAX_LENGTH = 80;

const PUSH_BODY_MAX_LENGTH = 180;

const NETWORK_WARNING_INTERVAL_MS = 60 * 60 * 1_000;

const DEFAULT_RECEIPT_DELAY_MS = 15 * 60 * 1_000;

const EXPO_RECEIPT_BATCH_SIZE = 1_000;

const EXPO_RECEIPT_MAX_ATTEMPTS = 3;

const ERROR_REPORT_INTERVAL_MS = 60 * 60 * 1_000;

const ERROR_REPORT_KEYS_MAX = 32;

const ERROR_CAUSE_DEPTH_MAX = 4;

const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

const LAST_OUTCOME_KEY = "last-send-outcome";

const HELD_PUSH_KEY_PREFIX = "held-push:";

const heldPushSchema = z
  .object({
    kinds: z.array(pushNotificationKindSchema),
    bodies: z.array(z.tuple([pushNotificationKindSchema, z.string()])),
    questionIds: z.array(z.string()).optional(),
  })
  .strict();

const FALLBACK_BODIES: Record<PushNotificationKind, string> = {
  "pending-interaction": "Waiting for your input",
  "thread-error": "The thread hit an error",
  "turn-finished": "Finished and waiting for you",
};

const PUSH_KIND_PRIORITY: readonly PushNotificationKind[] = [
  "pending-interaction",
  "thread-error",
  "turn-finished",
];

const expoPushTicketSchema = z.union([
  z.object({ status: z.literal("ok"), id: z.string().optional() }),
  z.object({
    status: z.literal("error"),
    message: z.string().optional(),
    details: z
      .object({ error: z.string().optional() })
      .passthrough()
      .optional(),
  }),
]);

const expoRequestErrorsSchema = z
  .array(
    z.object({ code: z.string().optional(), message: z.string().optional() }),
  )
  .optional();

const expoPushResponseSchema = z.object({
  data: z.array(expoPushTicketSchema).optional(),
  errors: expoRequestErrorsSchema,
});

const expoPushReceiptSchema = z.union([
  z.object({ status: z.literal("ok") }),
  z.object({
    status: z.literal("error"),
    details: z
      .object({ error: z.string().optional() })
      .passthrough()
      .optional(),
  }),
]);

const expoReceiptsResponseSchema = z.object({
  data: z.record(z.string(), expoPushReceiptSchema).optional(),
  errors: expoRequestErrorsSchema,
});

export const lastSendOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("never") }).strict(),
  z
    .object({
      status: z.literal("sent"),
      at: z.number().int().nonnegative(),
      sentCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      at: z.number().int().nonnegative(),
      reason: z.string().min(1),
    })
    .strict(),
]);

export type LastSendOutcome = z.infer<typeof lastSendOutcomeSchema>;

interface PushNotificationData {
  kind: PushNotificationKind;
  projectId: string;
  serverUrl?: string;
  threadId: string;
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: PushNotificationData;
  sound: "default";
  channelId: "threads";
  priority: "high";
}

export type PushSenderFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    dispatcher: Dispatcher;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface ThreadPush {
  bodies: Map<PushNotificationKind, string>;
  kinds: Set<PushNotificationKind>;
  questionIds: Set<string>;
}

interface PendingThreadPush extends ThreadPush {
  eventAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface PreparedPush {
  body: string;
  kind: PushNotificationKind;
  thread: ThreadResponse;
  title: string;
}

interface Delivery {
  message: ExpoPushMessage;
  subscription: PushSubscription;
}

interface PendingReceipt {
  ticketId: string;
  subscriptionId: string;
}

interface ReceiptReadFailure {
  code: string;
  category:
    | "network"
    | "http"
    | "invalid_response"
    | "provider"
    | "receipt_unavailable";
  retryable: boolean;
  status?: number;
}

type ReceiptReadResult =
  | {
      ok: true;
      receipts: Record<string, z.infer<typeof expoPushReceiptSchema>>;
    }
  | { ok: false; failure: ReceiptReadFailure };

interface BatchResult {
  sentCount: number;
  failure: string | null;
  receipts: PendingReceipt[];
}

export interface PushSender {
  getHeldCount(): number;
  getLastOutcome(): LastSendOutcome;
  onAttentionChanged(threadId: string): void;
  onInteractionPending(
    payload: PluginThreadEventPayloads["interaction.pending"],
  ): void;
  onThreadFailed(payload: PluginThreadEventPayloads["thread.failed"]): void;
  onThreadIdle(payload: PluginThreadEventPayloads["thread.idle"]): void;
  onPresenceReported(): void;
  settle(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreatePushSenderArgs {
  api: PluginApi;
  subscriptions: PushSubscriptionStore;
  queueClientNotification(message: ClientNotification): Promise<void>;
  getExpoPushUrl(): Promise<string>;
  getNotificationLevel(thread: {
    id: string;
    parentThreadId: string | null;
  }): Promise<NotificationLevel>;
  getDeliverySettings(): Promise<{
    mobileEnabled: boolean;
    mobileOnlyWhenAway: boolean;
    webEnabled: boolean;
    desktopEnabled: boolean;
  }>;
  presence: Pick<Presence, "activeUntil">;
  restoredHoldMs?: number;
  fetch?: PushSenderFetch;
  coalesceMs?: number;
  assessmentWaitMs?: number;
  assessmentStartGraceMs?: number;
  assessmentPollMs?: number;
  receiptDelayMs?: number;
  now?: () => number;
}

function errorCode(value: unknown): string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value)
    ? value
    : "unknown";
}

function networkErrorCode(error: unknown): string {
  let current: unknown = error;

  for (let depth = 0; depth < ERROR_CAUSE_DEPTH_MAX; depth += 1) {
    if (typeof current !== "object" || current === null) break;

    if ("code" in current && typeof current.code === "string") {
      return errorCode(current.code);
    }

    current = "cause" in current ? current.cause : null;
  }

  return "network";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed.length > 0) return trimmed;
  }

  return "";
}

function threadDisplayTitle(thread: ThreadResponse): string {
  const title = thread.title?.trim();

  if (title) return title;
  const fallback = thread.titleFallback?.trim();

  if (fallback) return fallback;

  return `Thread ${thread.id.slice(0, 8)}`;
}

function describePendingInteraction(interaction: PendingInteraction): string {
  const payload = interaction.payload;

  if (payload.kind === "user_question") {
    const prompt = firstLine(payload.questions[0]?.prompt ?? "");

    return prompt || "The agent has a question for you";
  }

  if (payload.kind === "approval") {
    const subject = payload.subject;

    if (subject.kind === "command") {
      return `Approve command: ${firstLine(subject.command)}`;
    }

    if (subject.kind === "file_change") return "Approve file changes";

    if (subject.kind === "permission_grant") {
      return subject.toolName
        ? `Grant permissions to ${subject.toolName}`
        : "Grant additional permissions";
    }

    return "Review the plan before the agent continues";
  }

  if ("title" in payload) return payload.title;

  return "Waiting for your input";
}

function pickKind(
  kinds: ReadonlySet<PushNotificationKind>,
): PushNotificationKind | null {
  for (const kind of PUSH_KIND_PRIORITY) {
    if (kinds.has(kind)) return kind;
  }

  return null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function hasOpenWork(thread: ThreadListEntry): boolean {
  return (
    thread.status !== "idle" ||
    thread.runtime.displayStatus !== "idle" ||
    thread.hasPendingInteraction ||
    thread.queuedWork !== "none" ||
    thread.attention?.kind === "callback-waiting" ||
    thread.activity.activeWorkflowCount > 0 ||
    thread.activity.activeBackgroundAgentCount > 0 ||
    thread.activity.activeBackgroundCommandCount > 0 ||
    thread.activity.activeGoalCount > 0 ||
    thread.activity.activePlanModeCount > 0
  );
}

function predictionPending(
  thread: ThreadResponse,
  heldMs: number,
  limits: { waitMs: number; startGraceMs: number },
): boolean {
  const availability = thread.work?.assessment.availability;

  if (availability === "checking") return heldMs < limits.waitMs;

  if (availability === "missing" || availability === "stale")
    return heldMs < limits.startGraceMs;

  return false;
}

export function createPushSender(args: CreatePushSenderArgs): PushSender {
  const {
    api,
    subscriptions,
    coalesceMs = DEFAULT_COALESCE_MS,
    assessmentWaitMs = DEFAULT_ASSESSMENT_WAIT_MS,
    assessmentStartGraceMs = DEFAULT_ASSESSMENT_START_GRACE_MS,
    assessmentPollMs = DEFAULT_ASSESSMENT_POLL_MS,
    receiptDelayMs = DEFAULT_RECEIPT_DELAY_MS,
    restoredHoldMs = DEFAULT_PRESENCE_STALE_MS,
    now = Date.now,
  } = args;

  const fetchImpl = args.fetch ?? undiciFetch;
  const pending = new Map<string, PendingThreadPush>();
  const openQuestions = new Map<string, ReadonlySet<string>>();
  const scanningQuestions = new Set<string>();
  const rescanQuestions = new Set<string>();
  const held = new Map<string, ThreadPush>();
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  let heldTimerAt: number | null = null;
  let restoredUntil = 0;
  const inFlight = new Set<Promise<void>>();
  const receiptTimers = new Set<ReturnType<typeof setTimeout>>();
  const lastErrorReportAt = new Map<string, number>();
  let dispatcher: EnvHttpProxyAgent | null = null;
  let lastNetworkWarningAt = Number.NEGATIVE_INFINITY;
  let lastOutcome: LastSendOutcome = { status: "never" };
  let running = false;

  async function setLastOutcome(outcome: LastSendOutcome): Promise<void> {
    lastOutcome = outcome;
    await api.storage.kv.set(LAST_OUTCOME_KEY, outcome);
  }

  function reportFailure(
    operation: string,
    code: string,
    diagnostic?: PushErrorDiagnostic,
  ): void {
    const key = `${operation}:${code}`;
    const at = now();

    if (
      at - (lastErrorReportAt.get(key) ?? Number.NEGATIVE_INFINITY) <
      ERROR_REPORT_INTERVAL_MS
    ) {
      return;
    }

    if (lastErrorReportAt.size >= ERROR_REPORT_KEYS_MAX)
      lastErrorReportAt.clear();
    lastErrorReportAt.set(key, at);
    api.experimental_reportError(
      new Error(`Expo push ${operation} failed: ${code}`),
      {
        operation: `expo.${operation}`,
        code,
        ...(diagnostic === undefined
          ? {}
          : { experimental_diagnostic: diagnostic }),
      },
    );
  }

  function track(work: Promise<void>, label: string): void {
    const tracked = work.catch((error: unknown) => {
      api.log.error(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
  }

  function cancel(threadId: string): void {
    const entry = pending.get(threadId);

    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(threadId);
  }

  function schedule(
    threadId: string,
    kind: PushNotificationKind,
    body: string,
    questionIds: readonly string[] = [],
  ): void {
    if (!running) return;
    const eventAt = now();
    const existing = pending.get(threadId);

    if (existing) {
      existing.kinds.add(kind);
      existing.bodies.set(kind, body);
      existing.eventAt = Math.max(existing.eventAt, eventAt);

      for (const id of questionIds) existing.questionIds.add(id);

      return;
    }

    const entry: PendingThreadPush = {
      bodies: new Map([[kind, body]]),
      eventAt,
      kinds: new Set([kind]),
      questionIds: new Set(questionIds),
      timer: undefined,
    };

    pending.set(threadId, entry);
    arm(threadId, entry, coalesceMs);
  }

  function arm(
    threadId: string,
    entry: PendingThreadPush,
    delayMs: number,
  ): void {
    entry.timer = setTimeout(() => {
      if (pending.get(threadId) !== entry) return;
      pending.delete(threadId);

      if (!running) return;

      track(
        flushThread(threadId, entry),
        `Push notification flush failed for thread ${threadId}`,
      );
    }, delayMs);

    entry.timer.unref?.();
  }

  async function scanQuestions(threadId: string): Promise<void> {
    if (scanningQuestions.has(threadId)) {
      rescanQuestions.add(threadId);

      return;
    }

    scanningQuestions.add(threadId);

    try {
      do {
        rescanQuestions.delete(threadId);

        const { questions } = await api.sdk.experimental_attention.history({
          threadId,
        });

        if (!running) return;
        const seen = openQuestions.get(threadId);
        const open = new Set<string>();

        for (const question of questions) {
          if (question.state !== "open" || open.has(question.id)) continue;
          open.add(question.id);

          if (
            seen?.has(question.id) !== true &&
            now() - question.createdAt <= QUESTION_FRESH_MS
          )
            schedule(
              threadId,
              "pending-interaction",
              firstLine(question.question.prompt),
              [question.id],
            );
        }

        if (open.size > 0) openQuestions.set(threadId, open);
        else openQuestions.delete(threadId);
      } while (running && rescanQuestions.has(threadId));
    } finally {
      scanningQuestions.delete(threadId);
    }
  }

  function awaitPrediction(threadId: string, entry: PendingThreadPush): void {
    if (!running) return;
    const newer = pending.get(threadId);

    if (newer === undefined) {
      pending.set(threadId, entry);
      arm(threadId, entry, assessmentPollMs);

      return;
    }

    const merged = mergePush(entry, newer);
    newer.bodies = merged.bodies;
    newer.kinds = merged.kinds;
    newer.questionIds = merged.questionIds;
    newer.eventAt = Math.max(newer.eventAt, entry.eventAt);
  }

  async function isWorkFinished(thread: ThreadResponse): Promise<boolean> {
    let found = false;

    for (let offset = 0; !found; offset += THREAD_ACTIVITY_PAGE_SIZE) {
      const query: Parameters<PluginApi["sdk"]["threads"]["list"]>[0] = {
        projectId: thread.projectId,
        includeHidden: true,
        limit: THREAD_ACTIVITY_PAGE_SIZE,
        offset,
      };

      if (thread.environmentId !== null)
        query.environmentId = thread.environmentId;

      if (thread.parentThreadId === null) query.hasParent = false;
      else query.parentThreadId = thread.parentThreadId;
      const threads = await api.sdk.threads.list(query);
      const current = threads.find((candidate) => candidate.id === thread.id);

      if (current !== undefined) {
        if (hasOpenWork(current)) return false;
        found = true;
      } else if (threads.length < THREAD_ACTIVITY_PAGE_SIZE) {
        api.log.warn(`Completion activity unavailable for thread ${thread.id}`);

        return false;
      }
    }

    const parents = new Set([thread.id]);

    for (const parentThreadId of parents) {
      for (let offset = 0; ; offset += THREAD_ACTIVITY_PAGE_SIZE) {
        const children = await api.sdk.threads.list({
          parentThreadId,
          includeHidden: true,
          limit: THREAD_ACTIVITY_PAGE_SIZE,
          offset,
        });

        for (const child of children) {
          if (child.archivedAt !== null || child.deletedAt !== null) continue;

          if (hasOpenWork(child)) return false;
          parents.add(child.id);
        }

        if (children.length < THREAD_ACTIVITY_PAGE_SIZE) break;
      }
    }

    return true;
  }

  async function resolvePush(
    thread: ThreadResponse,
    entry: ThreadPush,
    allowedKinds: ReadonlySet<PushNotificationKind>,
  ): Promise<{ kind: PushNotificationKind; body: string } | null> {
    const kinds = new Set(
      [...entry.kinds].filter((kind) => allowedKinds.has(kind)),
    );

    if (kinds.size === 0) return null;
    let waitingFor: string | null = null;

    if (kinds.has("pending-interaction")) {
      const interactions = await api.sdk.threads.interactions.list({
        threadId: thread.id,
      });

      const interaction =
        interactions.find((candidate) => candidate.status === "pending") ??
        null;

      if (interaction) waitingFor = describePendingInteraction(interaction);
      else if (entry.questionIds.size > 0) {
        const { questions } = await api.sdk.experimental_attention.history({
          threadId: thread.id,
        });

        const question = openNativeQuestion(
          questions.filter((candidate) => entry.questionIds.has(candidate.id)),
        );

        if (question)
          waitingFor =
            firstLine(question.question.prompt) ||
            "The agent has a question for you";
      }

      if (waitingFor === null) kinds.delete("pending-interaction");
    }

    if (kinds.has("turn-finished") && thread.status !== "idle") {
      kinds.delete("turn-finished");
    }

    if (kinds.has("thread-error") && thread.status !== "error") {
      kinds.delete("thread-error");
    }

    const kind = pickKind(kinds);

    if (kind === null) return null;

    if (kind === "pending-interaction") return { kind, body: waitingFor ?? "" };

    if (kind === "turn-finished" && !(await isWorkFinished(thread)))
      return null;

    return { kind, body: entry.bodies.get(kind) ?? "" };
  }

  async function referencedThreadTitle(
    threadId: string,
  ): Promise<string | null> {
    try {
      return threadDisplayTitle(await api.sdk.threads.get({ threadId }));
    } catch {
      return null;
    }
  }

  async function preparePush(
    threadId: string,
    entry: ThreadPush,
  ): Promise<PreparedPush | null> {
    let thread: ThreadResponse;

    try {
      thread = await api.sdk.threads.get({ threadId });
    } catch {
      return null;
    }

    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.visibility !== "visible" ||
      thread.pluginHome
    ) {
      return null;
    }

    const lastReadAt = thread.lastReadAt ?? 0;

    if (lastReadAt >= thread.latestAttentionAt) {
      for (const kind of entry.kinds)
        if (kind !== "pending-interaction") entry.kinds.delete(kind);

      if (entry.kinds.size === 0) return null;
    }

    const level = await args.getNotificationLevel(thread);

    const resolved = await resolvePush(
      thread,
      entry,
      NOTIFICATION_KINDS_BY_LEVEL[level],
    );

    if (resolved === null) return null;

    const preview = await notificationPreviewText(
      resolved.body,
      referencedThreadTitle,
    );

    const title = truncate(threadDisplayTitle(thread), PUSH_TITLE_MAX_LENGTH);

    const body = truncate(
      preview || FALLBACK_BODIES[resolved.kind],
      PUSH_BODY_MAX_LENGTH,
    );

    return { body, kind: resolved.kind, thread, title };
  }

  function clearHeldTimer(): void {
    if (heldTimer !== null) clearTimeout(heldTimer);
    heldTimer = null;
    heldTimerAt = null;
  }

  function scheduleHeldCheck(): void {
    if (held.size === 0) {
      clearHeldTimer();

      return;
    }

    const until = Math.max(args.presence.activeUntil() ?? 0, restoredUntil);

    if (until <= now()) {
      clearHeldTimer();
      releaseHeld();

      return;
    }

    if (until === heldTimerAt) return;
    clearHeldTimer();
    heldTimerAt = until;
    heldTimer = setTimeout(
      () => {
        heldTimer = null;
        heldTimerAt = null;

        if (running) scheduleHeldCheck();
      },
      Math.max(0, until - now()),
    );
    heldTimer.unref?.();
  }

  function mergePush(earlier: ThreadPush | undefined, entry: ThreadPush) {
    return {
      bodies: new Map([...(earlier?.bodies ?? []), ...entry.bodies]),
      kinds: new Set([...(earlier?.kinds ?? []), ...entry.kinds]),
      questionIds: new Set([
        ...(earlier?.questionIds ?? []),
        ...entry.questionIds,
      ]),
    };
  }

  async function hold(threadId: string, entry: ThreadPush): Promise<void> {
    const merged = mergePush(held.get(threadId), entry);
    held.set(threadId, merged);
    await api.storage.kv.set(`${HELD_PUSH_KEY_PREFIX}${threadId}`, {
      kinds: [...merged.kinds],
      bodies: [...merged.bodies],
      questionIds: [...merged.questionIds],
    } satisfies z.infer<typeof heldPushSchema>);
    scheduleHeldCheck();
  }

  async function releaseThread(
    threadId: string,
    entry: ThreadPush,
  ): Promise<void> {
    const prepared = (await args.getDeliverySettings()).mobileEnabled
      ? await preparePush(threadId, entry)
      : null;

    if (!running) return;

    if (prepared !== null) await sendMobile(prepared);

    if (!held.has(threadId))
      await api.storage.kv.delete(`${HELD_PUSH_KEY_PREFIX}${threadId}`);
  }

  async function restoreHeld(): Promise<void> {
    for (const key of await api.storage.kv.list(HELD_PUSH_KEY_PREFIX)) {
      const parsed = heldPushSchema.safeParse(
        await api.storage.kv.get<unknown>(key),
      );

      if (!parsed.success) {
        api.log.warn(`Dropped an unreadable held phone notification ${key}`);
        await api.storage.kv.delete(key);
        continue;
      }

      held.set(key.slice(HELD_PUSH_KEY_PREFIX.length), {
        kinds: new Set(parsed.data.kinds),
        bodies: new Map(parsed.data.bodies),
        questionIds: new Set(parsed.data.questionIds ?? []),
      });
    }

    if (held.size === 0) return;
    api.log.info(
      `Holding ${held.size} restored phone notifications until computer activity is known`,
    );
    restoredUntil = now() + restoredHoldMs;
    scheduleHeldCheck();
  }

  function releaseHeld(): void {
    const entries = [...held];
    held.clear();

    for (const [threadId, entry] of entries)
      track(
        releaseThread(threadId, entry),
        `Held push notification release failed for thread ${threadId}`,
      );
  }

  async function flushThread(
    threadId: string,
    entry: PendingThreadPush,
  ): Promise<void> {
    const prepared = await preparePush(threadId, entry);

    if (prepared === null) return;

    if (
      prepared.kind === "turn-finished" &&
      predictionPending(prepared.thread, now() - entry.eventAt, {
        waitMs: assessmentWaitMs,
        startGraceMs: assessmentStartGraceMs,
      })
    ) {
      awaitPrediction(threadId, entry);

      return;
    }

    const { body, kind, thread, title } = prepared;
    const config = await args.getDeliverySettings();
    const channels: ClientNotification["channels"] = [];

    if (config.webEnabled) channels.push("web");

    if (config.desktopEnabled) channels.push("desktop");

    if (channels.length > 0) {
      await args.queueClientNotification({
        id: randomUUID(),
        title,
        body,
        threadId: thread.id,
        kind,
        channels,
      });
    }

    if (!config.mobileEnabled) return;

    if (
      config.mobileOnlyWhenAway &&
      config.desktopEnabled &&
      args.presence.activeUntil() !== null
    ) {
      await hold(threadId, entry);

      return;
    }

    const earlier = held.get(threadId);

    if (earlier === undefined) {
      await sendMobile(prepared);

      return;
    }

    held.delete(threadId);
    await releaseThread(threadId, mergePush(earlier, entry));
  }

  async function sendMobile({
    body,
    kind,
    thread,
    title,
  }: PreparedPush): Promise<void> {
    const rows = await subscriptions.list();

    if (rows.length === 0) return;
    const serverUrl = api.server.experimental_appUrl;

    const deliveries: Delivery[] = rows.map((subscription) => ({
      subscription,
      message: {
        to: subscription.expoPushToken,
        title,
        body,
        data: {
          kind,
          projectId: thread.projectId,
          ...(serverUrl === null ? {} : { serverUrl }),
          threadId: thread.id,
        },
        sound: "default",
        channelId: "threads",
        priority: "high",
      },
    }));

    let sentCount = 0;
    let failure: string | null = null;
    const receipts: PendingReceipt[] = [];

    for (const batch of chunks(deliveries, EXPO_PUSH_BATCH_SIZE)) {
      const result = await sendBatch(batch);
      sentCount += result.sentCount;
      failure ??= result.failure;
      receipts.push(...result.receipts);
    }

    await setLastOutcome(
      failure === null
        ? { status: "sent", at: now(), sentCount }
        : { status: "failed", at: now(), reason: failure },
    );
    scheduleReceiptCheck(receipts);
  }

  function scheduleReceiptCheck(
    receipts: readonly PendingReceipt[],
    attempt = 1,
  ): void {
    if (!running || receipts.length === 0) return;

    const timer = setTimeout(
      () => {
        receiptTimers.delete(timer);

        if (!running) return;
        track(checkReceipts(receipts, attempt), "Push receipt check failed");
      },
      receiptDelayMs * 2 ** Math.max(0, attempt - 2),
    );

    timer.unref?.();
    receiptTimers.add(timer);
  }

  async function fetchReceipts(
    batch: readonly PendingReceipt[],
  ): Promise<ReceiptReadResult> {
    const activeDispatcher = dispatcher;

    if (activeDispatcher === null)
      return {
        ok: false,
        failure: {
          code: "sender_stopped",
          category: "network",
          retryable: false,
        },
      };
    let responseText: string;
    let status: number;

    try {
      const url = new URL("getReceipts", await args.getExpoPushUrl());

      const response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ids: batch.map((receipt) => receipt.ticketId) }),
        dispatcher: activeDispatcher,
      });

      status = response.status;
      responseText = await response.text();
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: networkErrorCode(error),
          category: "network",
          retryable: true,
        },
      };
    }

    if (status < 200 || status >= 300) {
      return {
        ok: false,
        failure: {
          code: `http_${status}`,
          category: "http",
          retryable: status === 429 || status >= 500,
          status,
        },
      };
    }

    const parsed = expoReceiptsResponseSchema.safeParse(
      parseJson(responseText),
    );

    if (
      !parsed.success ||
      parsed.data.data === undefined ||
      parsed.data.errors?.length
    ) {
      return {
        ok: false,
        failure: {
          code: parsed.success
            ? errorCode(parsed.data.errors?.[0]?.code)
            : "invalid_response",
          category: parsed.success ? "provider" : "invalid_response",
          retryable: false,
          status,
        },
      };
    }

    return { ok: true, receipts: parsed.data.data };
  }

  function handleReceiptReadFailure(
    batch: readonly PendingReceipt[],
    attempt: number,
    failure: ReceiptReadFailure,
  ): void {
    if (!running) return;

    if (failure.retryable && attempt < EXPO_RECEIPT_MAX_ATTEMPTS) {
      api.log.warn(
        `Expo push receipt read will retry: ${failure.code}, attempt ${attempt}, tickets ${batch.length}`,
      );
      scheduleReceiptCheck(batch, attempt + 1);

      return;
    }

    const detail = ` (${failure.category}, attempts ${attempt}, tickets ${batch.length}${failure.status === undefined ? "" : `, status ${failure.status}`})`;
    api.log.warn(
      `Expo push receipt confirmation unavailable: ${failure.code}${detail}`,
    );
    const transportCode = transportCodeSchema.safeParse(failure.code);
    reportFailure("receipts", failure.code, {
      ...(failure.category === "network" && transportCode.success
        ? { transportCode: transportCode.data }
        : {}),
      stage: failure.category === "invalid_response" ? "decode" : "receive",
      failureClass:
        failure.category === "network"
          ? "connection"
          : failure.category === "invalid_response"
            ? "invalid-response"
            : failure.category === "provider" || !failure.retryable
              ? "upstream-rejected"
              : "upstream-unavailable",
      outcome: "terminal",
      retryable: failure.retryable,
      attempt,
      itemCount: batch.length,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    });
  }

  async function checkReceipts(
    receipts: readonly PendingReceipt[],
    attempt: number,
  ): Promise<void> {
    let failure: string | null = null;

    for (const batch of chunks(receipts, EXPO_RECEIPT_BATCH_SIZE)) {
      const result = await fetchReceipts(batch);

      if (!result.ok) {
        handleReceiptReadFailure(batch, attempt, result.failure);
        continue;
      }

      const missing: PendingReceipt[] = [];

      for (const pendingReceipt of batch) {
        const { ticketId, subscriptionId } = pendingReceipt;
        const receipt = result.receipts[ticketId];

        if (receipt === undefined) {
          missing.push(pendingReceipt);
          continue;
        }

        if (receipt.status === "ok") continue;
        const code = errorCode(receipt.details?.error);

        if (code === "DeviceNotRegistered") {
          await subscriptions.remove(subscriptionId);
          api.log.info(
            `Removed push subscription row ${subscriptionId}: device is not registered`,
          );
          continue;
        }

        failure ??= code;
        api.log.warn(
          `Expo push receipt reported ${code} for subscription row ${subscriptionId}`,
        );
        reportFailure("receipt", code);
      }

      if (missing.length > 0) {
        handleReceiptReadFailure(missing, attempt, {
          code: "receipt_unavailable",
          category: "receipt_unavailable",
          retryable: true,
        });
      }
    }

    if (failure !== null) {
      await setLastOutcome({
        status: "failed",
        at: now(),
        reason: `delivery failed: ${failure}`,
      });
    }
  }

  async function sendBatch(batch: readonly Delivery[]): Promise<BatchResult> {
    const activeDispatcher = dispatcher;

    if (activeDispatcher === null) {
      return { sentCount: 0, failure: "sender is stopped", receipts: [] };
    }

    let responseText: string;
    let status: number;

    try {
      const response = await fetchImpl(await args.getExpoPushUrl(), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(batch.map((delivery) => delivery.message)),
        dispatcher: activeDispatcher,
      });

      status = response.status;
      responseText = await response.text();
    } catch (error) {
      const warningAt = now();

      if (warningAt - lastNetworkWarningAt >= NETWORK_WARNING_INTERVAL_MS) {
        lastNetworkWarningAt = warningAt;
        api.log.warn(
          `Expo push request failed for subscription rows ${batch.map((delivery) => delivery.subscription.id).join(", ")}`,
        );
      }

      reportFailure("send", networkErrorCode(error));

      return { sentCount: 0, failure: "network request failed", receipts: [] };
    }

    const parsed = expoPushResponseSchema.safeParse(parseJson(responseText));

    if (!parsed.success) {
      api.log.warn(
        `Expo push response was not understood for ${batch.length} subscription rows with status ${status}`,
      );
      reportFailure("send", `http_${status}`);

      return {
        sentCount: 0,
        failure: "relay returned an invalid response",
        receipts: [],
      };
    }

    if (parsed.data.errors && parsed.data.errors.length > 0) {
      const codes = parsed.data.errors.map((error) => errorCode(error.code));
      api.log.warn(
        `Expo push request was rejected with codes ${codes.join(", ")}`,
      );
      reportFailure("send", codes[0] ?? "unknown");

      return {
        sentCount: 0,
        failure: "relay rejected the request",
        receipts: [],
      };
    }

    if (parsed.data.data === undefined) {
      api.log.warn(
        `Expo push response returned no tickets with status ${status}`,
      );
      reportFailure("send", "no_tickets");

      return {
        sentCount: 0,
        failure: "relay returned no tickets",
        receipts: [],
      };
    }

    let sentCount = 0;
    let ticketFailure = false;
    const receipts: PendingReceipt[] = [];

    for (const [index, ticket] of parsed.data.data.entries()) {
      const delivery = batch[index];

      if (!delivery) continue;

      if (ticket.status === "ok") {
        sentCount += 1;

        if (ticket.id !== undefined) {
          receipts.push({
            ticketId: ticket.id,
            subscriptionId: delivery.subscription.id,
          });
        }

        continue;
      }

      const code = errorCode(ticket.details?.error);

      if (code === "DeviceNotRegistered") {
        await subscriptions.remove(delivery.subscription.id);
        api.log.info(
          `Removed push subscription row ${delivery.subscription.id}: device is not registered`,
        );
        continue;
      }

      ticketFailure = true;
      api.log.warn(
        `Expo push ticket reported ${code} for subscription row ${delivery.subscription.id}`,
      );
      reportFailure("ticket", code);
    }

    return {
      sentCount,
      failure: ticketFailure ? "relay rejected one or more tickets" : null,
      receipts,
    };
  }

  async function settle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  return {
    getHeldCount: () => held.size,
    getLastOutcome: () => lastOutcome,
    onAttentionChanged(threadId) {
      if (!running) return;
      track(
        scanQuestions(threadId),
        `Question notification scan failed for thread ${threadId}`,
      );
    },
    onInteractionPending(payload) {
      schedule(
        payload.thread.id,
        "pending-interaction",
        describePendingInteraction(payload.interaction),
      );
    },
    onThreadFailed({ thread, error }) {
      schedule(thread.id, "thread-error", firstLine(error ?? ""));
    },
    onThreadIdle({ thread, lastAssistantText }) {
      if (thread.visibility !== "visible") return;
      schedule(thread.id, "turn-finished", lastAssistantText ?? "");
    },
    onPresenceReported() {
      if (running) scheduleHeldCheck();
    },
    settle,
    async start() {
      if (running) return;

      const stored = lastSendOutcomeSchema.safeParse(
        await api.storage.kv.get<unknown>(LAST_OUTCOME_KEY),
      );

      if (stored.success) lastOutcome = stored.data;
      dispatcher = new EnvHttpProxyAgent();
      running = true;
      await restoreHeld();
    },
    async stop() {
      if (!running) return;
      running = false;

      for (const threadId of [...pending.keys()]) cancel(threadId);
      openQuestions.clear();

      clearHeldTimer();
      held.clear();
      restoredUntil = 0;

      for (const timer of receiptTimers) clearTimeout(timer);
      receiptTimers.clear();
      await settle();
      const activeDispatcher = dispatcher;
      dispatcher = null;
      await activeDispatcher?.close();
    },
  };
}
