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

const snapshotListeners = new Set<() => void>();

interface NewChatWaiter {
  pendingChatId: string;
  reject: (error: Error) => void;
  resolve: (accepted: { threadId: string }) => void;
}

const newChatWaiters = new Map<string, NewChatWaiter>();

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
  const entries = await store.list();

  await settleNewChatWaiters(store, entries);

  snapshot =
    storeId === null
      ? EMPTY_ENTRIES
      : entries.filter((entry) => entry.storeId === storeId);

  for (const listener of snapshotListeners) listener();
}

function ensureRuntime(): SendOutboxRuntime {
  if (runtime !== null) {
    return runtime;
  }

  const store = createIndexedDbSendOutboxStore();

  const drainer = createSendOutboxDrainer({
    classify: classifyOutboxFailure,
    onDelivered: () => undefined,
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

export async function startSendOutbox(): Promise<void> {
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

  await store.stage({
    submissionId: createSubmissionId(),
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
  await ensureRuntime().store.discard(submissionId);
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
