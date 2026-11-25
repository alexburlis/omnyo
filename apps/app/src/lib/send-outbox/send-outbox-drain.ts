import type { PromptInput } from "@omnyo/domain";
import {
  SUBMISSION_CONTRACT_VERSION,
  type SubmissionReceipt,
  type SubmitRequest,
} from "@omnyo/server-contract";
import { outboxConversationKey, type OutboxEntry } from "./send-outbox-entry";
import type { SendOutboxStore } from "./send-outbox-store";

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export interface SendOutboxTransport {
  readStoreId(): Promise<string | null>;
  submit(request: SubmitRequest): Promise<SubmissionReceipt>;
  upload(args: {
    blob: Blob;
    mimeType: string | undefined;
    name: string;
    projectId: string;
  }): Promise<string>;
}

export type OutboxDeliveryFailure =
  | { kind: "retry" }
  | { kind: "terminal"; code: string; message: string };

export interface DeliveredOutboxEntry {
  entry: OutboxEntry;
  receipt: SubmissionReceipt;
}

export interface SendOutboxDrainResult {
  delivered: DeliveredOutboxEntry[];
  outcome: "idle" | "retry" | "unsupported";
}

interface SendOutboxDrainDeps {
  classify: (error: unknown) => OutboxDeliveryFailure;
  onDelivered?: (delivered: DeliveredOutboxEntry) => void;
  store: SendOutboxStore;
  transport: SendOutboxTransport;
}

function withUploadedPaths(
  input: PromptInput[],
  pathByToken: ReadonlyMap<string, string>,
): PromptInput[] {
  return input.map((item) => {
    if (item.type !== "localFile" && item.type !== "localImage") {
      return item;
    }

    const path = pathByToken.get(item.path);

    return path === undefined ? item : { ...item, path };
  });
}

async function uploadMissingAttachments(
  deps: SendOutboxDrainDeps,
  entry: OutboxEntry,
): Promise<Map<string, string>> {
  const pathByToken = new Map<string, string>();

  const projectId =
    entry.action.kind === "new-thread"
      ? entry.action.thread.projectId
      : entry.action.projectId;

  for (const attachment of entry.attachments) {
    if (attachment.uploadedPath !== null) {
      pathByToken.set(attachment.token, attachment.uploadedPath);
      continue;
    }

    const path = await deps.transport.upload({
      blob: attachment.blob,
      mimeType: attachment.mimeType,
      name: attachment.name,
      projectId,
    });

    await deps.store.recordUpload({
      path,
      submissionId: entry.submissionId,
      token: attachment.token,
    });
    pathByToken.set(attachment.token, path);
  }

  return pathByToken;
}

async function deliverEntry(
  deps: SendOutboxDrainDeps,
  args: { entry: OutboxEntry; storeId: string; threadId: string | null },
): Promise<SubmissionReceipt> {
  const { entry } = args;
  const pathByToken = await uploadMissingAttachments(deps, entry);

  const attachments = entry.attachments.flatMap((attachment) => {
    const path = pathByToken.get(attachment.token);

    return path === undefined
      ? []
      : [{ path, sha256: attachment.sha256, sizeBytes: attachment.sizeBytes }];
  });

  if (entry.action.kind === "new-thread") {
    return deps.transport.submit({
      version: SUBMISSION_CONTRACT_VERSION,
      submissionId: entry.submissionId,
      storeId: args.storeId,
      action: {
        kind: "new-thread",
        thread: {
          ...entry.action.thread,
          input: withUploadedPaths(entry.action.thread.input, pathByToken),
        },
      },
      attachments,
    });
  }

  if (args.threadId === null) {
    throw new Error("A waiting message has no chat to go to");
  }

  return deps.transport.submit({
    version: SUBMISSION_CONTRACT_VERSION,
    submissionId: entry.submissionId,
    storeId: args.storeId,
    action: {
      kind: "thread-message",
      threadId: args.threadId,
      message: {
        ...entry.action.message,
        input: withUploadedPaths(entry.action.message.input, pathByToken),
      },
    },
    attachments,
  });
}

export async function drainSendOutbox(
  deps: SendOutboxDrainDeps,
): Promise<SendOutboxDrainResult> {
  let storeId: string | null;

  try {
    storeId = await deps.transport.readStoreId();
  } catch {
    return { delivered: [], outcome: "retry" };
  }

  if (storeId === null) {
    return { delivered: [], outcome: "unsupported" };
  }

  if ((await deps.store.readKnownStoreId()) !== storeId) {
    await deps.store.rememberStoreId(storeId);
  }

  const entries = (await deps.store.list()).filter(
    (entry) => entry.storeId === storeId,
  );

  const pendingCreations = new Set(
    entries.flatMap((entry) =>
      entry.action.kind === "new-thread" ? [entry.action.pendingChatId] : [],
    ),
  );

  const blocked = new Set<string>();
  const delivered: DeliveredOutboxEntry[] = [];

  for (const entry of entries) {
    const conversation = outboxConversationKey(entry.action);

    if (blocked.has(conversation)) {
      continue;
    }

    if (entry.state.kind === "paused") {
      blocked.add(conversation);
      continue;
    }

    let threadId: string | null = null;

    if (entry.action.kind === "thread-message") {
      if ("threadId" in entry.action.target) {
        threadId = entry.action.target.threadId;
      } else {
        threadId = await deps.store.readAlias(
          entry.action.target.pendingChatId,
        );

        if (threadId === null) {
          blocked.add(conversation);

          if (!pendingCreations.has(entry.action.target.pendingChatId)) {
            await deps.store.setState(entry.submissionId, {
              kind: "paused",
              code: "chat_not_created",
              message: "The chat this message was written for was not created.",
            });
          }

          continue;
        }
      }
    }

    try {
      const receipt = await deliverEntry(deps, { entry, storeId, threadId });

      const delivery = { entry, receipt };
      deps.onDelivered?.(delivery);

      await deps.store.settle({
        alias:
          entry.action.kind === "new-thread"
            ? {
                pendingChatId: entry.action.pendingChatId,
                threadId: receipt.threadId,
              }
            : null,
        submissionId: entry.submissionId,
      });
      pendingCreations.delete(conversation);
      delivered.push(delivery);
    } catch (error) {
      const failure = deps.classify(error);

      if (failure.kind === "retry") {
        return { delivered, outcome: "retry" };
      }

      await deps.store.setState(entry.submissionId, {
        kind: "paused",
        code: failure.code,
        message: failure.message,
      });
      blocked.add(conversation);
    }
  }

  return { delivered, outcome: "idle" };
}

export interface SendOutboxDrainer {
  dispose(): void;
  wake(): void;
}

interface SendOutboxDrainerDeps extends SendOutboxDrainDeps {
  onDelivered: (delivered: DeliveredOutboxEntry) => void;
  withDrainLock: <TResult>(
    work: () => Promise<TResult>,
  ) => Promise<TResult | null>;
}

export function createSendOutboxDrainer(
  deps: SendOutboxDrainerDeps,
): SendOutboxDrainer {
  let disposed = false;
  let running = false;
  let wakeRequested = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const run = async (): Promise<void> => {
    if (disposed || running) {
      wakeRequested = !disposed;

      return;
    }

    running = true;
    wakeRequested = false;

    try {
      const result = await deps.withDrainLock(() => drainSendOutbox(deps));

      if (result?.outcome === "retry") {
        const delay = RETRY_DELAYS_MS[retryAttempt];

        if (delay !== undefined && !disposed) {
          retryAttempt += 1;
          clearRetry();
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void run();
          }, delay);
        }
      } else {
        retryAttempt = 0;
      }
    } finally {
      running = false;
    }

    if (wakeRequested) {
      await run();
    }
  };

  return {
    dispose() {
      disposed = true;
      clearRetry();
    },
    wake() {
      retryAttempt = 0;
      clearRetry();
      void run();
    },
  };
}
