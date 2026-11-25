import type { QueryClient } from "@tanstack/react-query";
import { beginOutboxThreadMessageTransaction } from "@/hooks/cache-owners/outbox-thread-state-cache-owner";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import type { PromptInput } from "@omnyo/domain";
import type {
  CreateQueuedMessageRequest,
  CreateThreadRequest,
} from "@omnyo/server-contract";
import { wsManager } from "../ws";
import { indexedDbSendOutboxProbe } from "./send-outbox-database";
import {
  createSendOutboxDrainer,
  type SendOutboxDrainer,
} from "./send-outbox-drain";
import {
  createOutboxAttachment,
  createSubmissionId,
  outboxConversationKey,
  type OutboxAttachment,
  type OutboxEntry,
} from "./send-outbox-entry";
import {
  classifyOutboxFailure,
  sdkSendOutboxTransport,
} from "./send-outbox-failure";
import {
  createIndexedDbSendOutboxStore,
  type SendOutboxStore,
} from "./send-outbox-store";

const DRAIN_LOCK = "omnyo-send-outbox-drain-v1";

const EMPTY_ENTRIES: readonly OutboxEntry[] = [];

interface SendOutboxRuntime {
  drainer: SendOutboxDrainer;
  store: SendOutboxStore;
}

let runtime: SendOutboxRuntime | null = null;

let storeId: string | null = null;

let snapshot: readonly OutboxEntry[] = EMPTY_ENTRIES;

let snapshotRevision = 0;

const snapshotListeners = new Set<() => void>();

interface NewChatWaiter {
  pendingChatId: string;
  reject: (error: Error) => void;
  resolve: (accepted: { threadId: string }) => void;
}

const newChatWaiters = new Map<string, NewChatWaiter>();

let outboxQueryClient: QueryClient | null = null;

const threadMessagePredictions = new Map<
  string,
  {
    persisted: boolean;
    settle: () => void;
    discard: () => void;
  }
>();

export function trackOutboxThreadMessage(args: {
  queryClient: QueryClient;
  threadId: string;
  submissionId: string;
}): { discard: () => void } {
  const prediction = {
    ...beginOutboxThreadMessageTransaction({
      ...args,
      connected: wsManager.getConnectionState() === "connected",
    }),
    persisted: false,
  };

  threadMessagePredictions.set(args.submissionId, prediction);

  return {
    discard() {
      if (threadMessagePredictions.get(args.submissionId) !== prediction)
        return;
      threadMessagePredictions.delete(args.submissionId);
      prediction.discard();
    },
  };
}

function reconcileThreadMessagePredictions(
  entries: readonly OutboxEntry[],
): void {
  const byId = new Map(entries.map((entry) => [entry.submissionId, entry]));

  for (const [id, prediction] of threadMessagePredictions) {
    const entry = byId.get(id);

    if (entry?.state.kind === "paused") {
      threadMessagePredictions.delete(id);
      prediction.discard();
    } else if (entry === undefined && prediction.persisted) {
      threadMessagePredictions.delete(id);
      prediction.discard();
    }
  }

  const queryClient = outboxQueryClient;

  if (queryClient === null) return;

  for (const entry of entries) {
    if (
      entry.state.kind !== "waiting" ||
      entry.action.kind !== "thread-message" ||
      !("threadId" in entry.action.target) ||
      threadMessagePredictions.has(entry.submissionId)
    )
      continue;
    trackOutboxThreadMessage({
      queryClient,
      submissionId: entry.submissionId,
      threadId: entry.action.target.threadId,
    });
    const prediction = threadMessagePredictions.get(entry.submissionId);

    if (prediction) prediction.persisted = true;
  }
}

async function withDrainLock<TResult>(
  work: () => Promise<TResult>,
): Promise<TResult | null> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    return work();
  }

  return navigator.locks.request(
    DRAIN_LOCK,
    { ifAvailable: true },
    async (lock) => (lock === null ? null : work()),
  );
}

async function settleNewChatWaiters(
  store: SendOutboxStore,
  entries: readonly OutboxEntry[],
): Promise<void> {
  for (const [submissionId, waiter] of newChatWaiters) {
    const entry = entries.find((item) => item.submissionId === submissionId);

    if (entry === undefined) {
      const threadId = await store.readAlias(waiter.pendingChatId);

      newChatWaiters.delete(submissionId);

      if (threadId === null) {
        waiter.reject(
          new Error("The new chat was discarded before it was sent."),
        );
      } else {
        waiter.resolve({ threadId });
      }

      continue;
    }

    if (entry.state.kind === "paused") {
      newChatWaiters.delete(submissionId);
      await store.discard(submissionId);
      waiter.reject(new Error(entry.state.message));
    }
  }
}

async function refreshSnapshot(store: SendOutboxStore): Promise<void> {
  const revision = ++snapshotRevision;
  const entries = await store.list();

  await settleNewChatWaiters(store, entries);

  if (revision !== snapshotRevision) return;

  snapshot =
    storeId === null
      ? EMPTY_ENTRIES
      : entries.filter((entry) => entry.storeId === storeId);

  reconcileThreadMessagePredictions(snapshot);

  for (const listener of snapshotListeners) listener();
}

function ensureRuntime(): SendOutboxRuntime {
  if (runtime !== null) {
    return runtime;
  }

  const store = createIndexedDbSendOutboxStore();

  const drainer = createSendOutboxDrainer({
    classify: classifyOutboxFailure,
    onDelivered: ({ entry }) => {
      const prediction = threadMessagePredictions.get(entry.submissionId);
      threadMessagePredictions.delete(entry.submissionId);
      prediction?.settle();
    },
    store,
    transport: sdkSendOutboxTransport,
    withDrainLock,
  });

  store.subscribe(() => {
    void refreshSnapshot(store);
    drainer.wake();
  });
  wsManager.onConnected(() => drainer.wake());
  wsManager.onResumed(() => drainer.wake());
  runtime = { drainer, store };

  return runtime;
}

async function resolveStoreId(): Promise<string | null> {
  if (storeId !== null) {
    return storeId;
  }

  if (typeof indexedDB === "undefined") {
    return null;
  }

  try {
    storeId = await sdkSendOutboxTransport.readStoreId();

    return storeId;
  } catch {
    if (!(await indexedDbSendOutboxProbe.exists())) {
      return null;
    }

    storeId = await ensureRuntime().store.readKnownStoreId();

    return storeId;
  }
}

export async function isSendOutboxAvailable(): Promise<boolean> {
  return (await resolveStoreId()) !== null;
}

export async function startSendOutbox(queryClient: QueryClient): Promise<void> {
  outboxQueryClient = queryClient;

  if ((await resolveStoreId()) === null) {
    return;
  }

  const { drainer, store } = ensureRuntime();

  await refreshSnapshot(store);
  drainer.wake();
}

export async function buildOutboxMessageInput(args: {
  attachments: readonly PromptDraftAttachment[];
  input: PromptInput[];
  sourceOf: (attachment: PromptDraftAttachment) => File | null;
}): Promise<{ attachments: OutboxAttachment[]; input: PromptInput[] }> {
  const staged = new Map<string, OutboxAttachment>();

  for (const attachment of args.attachments) {
    const source = args.sourceOf(attachment);

    if (source === null || staged.has(attachment.path)) {
      continue;
    }

    staged.set(
      attachment.path,
      await createOutboxAttachment({
        blob: source,
        ...(source.type.length > 0 ? { mimeType: source.type } : {}),
        name: attachment.name,
        uploadedPath: attachment.path,
      }),
    );
  }

  return {
    attachments: [...staged.values()],
    input: args.input.map((item) => {
      if (item.type !== "localFile" && item.type !== "localImage") {
        return item;
      }

      const attachment = staged.get(item.path);

      return attachment === undefined
        ? item
        : { ...item, path: attachment.token };
    }),
  };
}

export async function stageThreadMessageInOutbox(args: {
  submissionId: string;
  attachments: OutboxAttachment[];
  message: CreateQueuedMessageRequest;
  projectId: string;
  threadId: string;
}): Promise<"staged" | "unavailable"> {
  const resolvedStoreId = await resolveStoreId();

  if (resolvedStoreId === null) {
    return "unavailable";
  }

  const { drainer, store } = ensureRuntime();

  const staged = await store.stage({
    submissionId: args.submissionId,
    storeId: resolvedStoreId,
    createdAt: Date.now(),
    action: {
      kind: "thread-message",
      projectId: args.projectId,
      target: { threadId: args.threadId },
      message: args.message,
    },
    attachments: args.attachments,
  });

  const prediction = threadMessagePredictions.get(staged.submissionId);

  if (prediction) prediction.persisted = true;

  snapshot = [
    ...snapshot.filter((entry) => entry.submissionId !== staged.submissionId),
    staged,
  ];

  for (const listener of snapshotListeners) listener();
  drainer.wake();

  return "staged";
}

export interface NewChatOutboxContext {
  onStaged: (() => void) | undefined;
  pendingChatId: string;
}

export async function createThreadThroughOutbox(args: {
  onStaged: (() => void) | undefined;
  pendingChatId: string;
  thread: CreateThreadRequest;
}): Promise<{ threadId: string } | null> {
  const resolvedStoreId = await resolveStoreId();

  if (resolvedStoreId === null) {
    return null;
  }

  const { drainer, store } = ensureRuntime();
  const submissionId = createSubmissionId();

  await store.stage({
    submissionId,
    storeId: resolvedStoreId,
    createdAt: Date.now(),
    action: {
      kind: "new-thread",
      pendingChatId: args.pendingChatId,
      thread: args.thread,
    },
    attachments: [],
  });

  const accepted = new Promise<{ threadId: string }>((resolve, reject) => {
    newChatWaiters.set(submissionId, {
      pendingChatId: args.pendingChatId,
      reject,
      resolve,
    });
  });

  args.onStaged?.();
  drainer.wake();

  return accepted;
}

export async function readOutboxChatAlias(
  pendingChatId: string,
): Promise<string | null> {
  if ((await resolveStoreId()) === null) {
    return null;
  }

  return ensureRuntime().store.readAlias(pendingChatId);
}

export async function retryOutboxEntry(submissionId: string): Promise<void> {
  const { drainer, store } = ensureRuntime();

  await store.reset(submissionId);
  drainer.wake();
}

export async function discardOutboxEntry(submissionId: string): Promise<void> {
  const prediction = threadMessagePredictions.get(submissionId);
  threadMessagePredictions.delete(submissionId);

  try {
    await ensureRuntime().store.discard(submissionId);
    prediction?.discard();
  } catch (error) {
    if (prediction) threadMessagePredictions.set(submissionId, prediction);
    throw error;
  }
}

export function subscribeSendOutbox(listener: () => void): () => void {
  snapshotListeners.add(listener);

  return () => {
    snapshotListeners.delete(listener);
  };
}

export function readSendOutboxSnapshot(): readonly OutboxEntry[] {
  return snapshot;
}

export function outboxEntriesForConversation(
  entries: readonly OutboxEntry[],
  conversationKey: string,
): OutboxEntry[] {
  return entries.filter(
    (entry) => outboxConversationKey(entry.action) === conversationKey,
  );
}
