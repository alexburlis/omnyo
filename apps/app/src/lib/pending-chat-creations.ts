import { useSyncExternalStore, type ComponentType } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import {
  pendingChatDescriptorsSchema as descriptorsSchema,
  assertBrowserStorageMigrationV1,
} from "./legacy-browser-storage-v1";
import {
  projectInboxFamily,
  type InboxEntry,
  type InboxFamilyFacts,
  type InboxSnapshot,
  type PromptInput,
  type ThreadQueuedMessage,
} from "@omnyo/domain";
import type {
  CreateThreadRequest,
  ThreadResponse,
} from "@omnyo/server-contract";
import type { PromptDraftScope } from "@/hooks/usePromptDraftStorage";
import type { NewThreadComposerSubmission } from "@/components/promptbox/NewThreadComposer";
import type { SendThreadMessageMutationRequest } from "@/hooks/mutations/mutation-request-types";
import {
  aliasComposerSendThread,
  reserveComposerSend,
  type ComposerSendSlot,
} from "./composer-send-queue";

import { pendingThreadDraftDestinationV1 } from "./prompt-draft-recovery-v1";
import {
  predictInboxSnapshot,
  type InboxPrediction,
} from "@/hooks/cache-owners/inbox-snapshot-cache-owner";
import { withInboxEntry, type InboxPredict } from "./inbox-predictions";
import { getCachedSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";

const STORAGE_KEY = "omnyo.pending-chats.v1";

const preservingDescriptorsSchema = descriptorsSchema.element
  .passthrough()
  .array();

const storedDescriptors = new Map<
  string,
  z.infer<typeof preservingDescriptorsSchema>[number]
>();

export interface PendingChatMessage {
  id: string;
  input: readonly PromptInput[];
  hasAttachments: boolean;
  status: "waiting" | "accepted" | "failed";
}

export type PendingChatRequest = NewThreadComposerSubmission &
  Pick<CreateThreadRequest, "sectionId" | "pinned"> &
  Partial<Pick<CreateThreadRequest, "originKind" | "sourceThreadId">>;

interface PendingChatHandoff {
  sourceThreadId: string;
  previousHandoffIds: ReadonlySet<string>;
}

export interface PendingChatSnapshot {
  id: string;
  projectId: string;
  realThreadId: string | null;
  request: PendingChatRequest | null;
  createdAt: number | null;
  handoff: PendingChatHandoff | null;
  status:
    | "creating"
    | "opening"
    | "open-failed"
    | "ready"
    | "failed"
    | "interrupted";
  messages: readonly PendingChatMessage[];
}

interface PendingChatEntry {
  snapshot: PendingChatSnapshot;
  creation: Promise<ThreadResponse> | null;
  send:
    | ((request: SendThreadMessageMutationRequest) => Promise<unknown>)
    | null;
  renderer: ComponentType<{ pendingId: string }> | null;
  prepare: ((threadId: string) => Promise<void>) | null;
  queueOwner: object | null;
  handoffPending: boolean;
  retirement: PendingChatRetirement | null;
}

interface PendingChatRetirement {
  at: number;
  composerHeight: number | null;
}

const RECENT_HANDOFF_WINDOW_MS = 1_000;

const PENDING_CHAT_TITLE_LENGTH = 200;

export function pendingChatPreview(
  request: Pick<PendingChatRequest, "input">,
): string | null {
  const text = request.input
    .flatMap((input) => (input.type === "text" ? [input.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PENDING_CHAT_TITLE_LENGTH);

  return text.length === 0 ? null : text;
}

export type PendingChatHeldMessage = Pick<
  ThreadQueuedMessage,
  "id" | "sendAt" | "waitingOn"
>;

export function pendingChatHeldMessage(
  id: string,
  request: Pick<PendingChatRequest, "expectedPluginWait" | "sendAt">,
  now = Date.now(),
): PendingChatHeldMessage | null {
  if (request.expectedPluginWait !== undefined)
    return {
      id: `${id}:initial`,
      sendAt: null,
      waitingOn: request.expectedPluginWait,
    };

  if (request.sendAt !== undefined && request.sendAt > now)
    return {
      id: `${id}:initial`,
      sendAt: request.sendAt,
      waitingOn: { kind: "time" },
    };

  return null;
}

const UNASSESSED: InboxFamilyFacts["assessment"] = {
  ask: null,
  recap: null,
  fresh: false,
  availability: "missing",
  reason: "",
  suggestion: false,
  archiveReady: false,
  archiveEligible: false,
};

function pendingChatInboxEntry(
  threadId: string,
  projectId: string,
  request: PendingChatRequest,
  createdAt: number,
): InboxEntry | null {
  const held = pendingChatHeldMessage(threadId, request, createdAt);

  if (held?.waitingOn?.kind === "plugin") return null;
  const title = pendingChatPreview(request) ?? "New chat";
  const sendAt = held?.sendAt ?? null;

  return projectInboxFamily({
    rootId: threadId,
    projectId,
    title,
    createdAt,
    archivedAt: null,
    shelvedAt: null,
    automationId: null,
    chats: [
      {
        threadId,
        title,
        isRoot: true,
        running: sendAt === null,
        working: sendAt === null,
        runningLabel: "Starting",
        runningProgress: null,
        waitingLabel: null,
        queuedOwnerWork: false,
        checkingWaitId: null,
        requiredQuestions: [],
        optionalQuestions: [],
        failure: null,
        hostEpisode: null,
        coverageGap: null,
      },
    ],
    receipts: [],
    waits:
      sendAt === null
        ? []
        : [
            {
              id: `${threadId}:send-later`,
              threadId,
              kind: "send-later",
              status: "live",
              forText: "Your message sends",
              createdBy: "owner",
              ownerAccepted: true,
              deadline: sendAt,
              nextCheckAt: null,
              checkCount: 0,
              reminderAt: null,
              readiness: "all",
              conditions: [],
              proposalKind: null,
              proposalReceiptId: null,
              questionId: null,
              behindTitle: null,
            },
          ],
    waiters: [],
    assessment: UNASSESSED,
  });
}

function hasInboxThread(snapshot: InboxSnapshot, threadId: string): boolean {
  return [
    snapshot.inbox,
    snapshot.waiting,
    snapshot.running,
    snapshot.shelf,
  ].some((list) => list.some((entry) => entry.threadId === threadId));
}

function showPendingChatInInbox(entry: InboxEntry): InboxPredict {
  return (snapshot) =>
    hasInboxThread(snapshot, entry.threadId)
      ? snapshot
      : withInboxEntry(snapshot, entry.threadId, entry);
}

function predictPendingChatInbox(
  queueOwner: object,
  id: string,
  request: PendingChatRequest,
  createdAt: number,
): {
  created: (threadId: string) => void;
  failed: () => void;
} {
  const entry = pendingChatInboxEntry(
    id,
    request.projectId,
    request,
    createdAt,
  );

  const prediction: InboxPrediction | null =
    entry === null || !(queueOwner instanceof QueryClient)
      ? null
      : predictInboxSnapshot(queueOwner, showPendingChatInInbox(entry));

  return {
    created(threadId) {
      const real = pendingChatInboxEntry(
        threadId,
        request.projectId,
        request,
        createdAt,
      );

      if (prediction === null || real === null) return;
      prediction.replace(showPendingChatInInbox(real));
      prediction.settle();
    },
    failed() {
      prediction?.discard();
    },
  };
}

const entries = new Map<string, PendingChatEntry>();

const reservedMessages = new WeakMap<
  ComposerSendSlot,
  { id: string; submitted: boolean }
>();

const listeners = new Set<() => void>();

let snapshots: readonly PendingChatSnapshot[] = [];

let restored = false;

function restoreDescriptors(): void {
  if (restored || typeof window === "undefined") return;
  assertBrowserStorageMigrationV1();

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);

    const descriptors =
      raw === null ? [] : preservingDescriptorsSchema.parse(JSON.parse(raw));

    for (const descriptor of descriptors) {
      storedDescriptors.set(descriptor.id, descriptor);
      entries.set(descriptor.id, {
        snapshot: {
          ...descriptor,
          request: null,
          createdAt: null,
          handoff: null,
          messages: [],
          status: descriptor.realThreadId === null ? "interrupted" : "ready",
        },
        creation: null,
        send: null,
        renderer: null,
        prepare: null,
        queueOwner: null,
        handoffPending: false,
        retirement: null,
      });
    }

    snapshots = [...entries.values()].map((entry) => entry.snapshot);
    restored = true;
  } catch {
    throw new Error(
      "Saved pending chat destinations contain unsupported data. Their original bytes were preserved.",
    );
  }
}

function publish(): void {
  snapshots = [...entries.values()].map((entry) => entry.snapshot);

  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        snapshots.map(({ id, projectId, realThreadId }) => ({
          ...storedDescriptors.get(id),
          id,
          projectId,
          realThreadId,
        })),
      ),
    );
  } catch (error) {
    console.warn(
      "Pending chat destinations are retained in memory only",
      error,
    );
  }

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function isPendingChatId(threadId: string): boolean {
  return threadId.startsWith("pending_");
}

export function getPendingChatSnapshot(id: string): PendingChatSnapshot | null {
  restoreDescriptors();

  return entries.get(id)?.snapshot ?? null;
}

export function getPendingChatRenderer(
  id: string,
): ComponentType<{ pendingId: string }> | null {
  restoreDescriptors();

  return entries.get(id)?.renderer ?? null;
}

export function usePendingChat(id: string): PendingChatSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => getPendingChatSnapshot(id),
    () => null,
  );
}

export function usePendingChats(): readonly PendingChatSnapshot[] {
  restoreDescriptors();

  return useSyncExternalStore(
    subscribe,
    () => snapshots,
    () => snapshots,
  );
}

export function resolvePendingThreadDraftScope(
  scope: PromptDraftScope,
): PromptDraftScope {
  return pendingThreadDraftDestinationV1(
    scope,
    scope.kind === "thread" && isPendingChatId(scope.threadId)
      ? getPendingChatSnapshot(scope.threadId)
      : null,
  );
}

export function getPendingThreadDraftTransfers(): {
  from: PromptDraftScope;
  to: PromptDraftScope;
}[] {
  restoreDescriptors();

  return snapshots.map(({ id, projectId }) => {
    const from: PromptDraftScope = { kind: "thread", projectId, threadId: id };

    return { from, to: resolvePendingThreadDraftScope(from) };
  });
}

function capturePendingChatHandoff(
  request: PendingChatRequest,
  queueOwner: object,
): PendingChatHandoff | null {
  if (request.originKind !== "handoff" || !request.sourceThreadId) return null;

  const previous =
    queueOwner instanceof QueryClient
      ? getCachedSidebarNavigationThreads(queueOwner)
      : [];

  return {
    sourceThreadId: request.sourceThreadId,
    previousHandoffIds: new Set(
      previous
        .filter(
          (thread) =>
            thread.projectId === request.projectId &&
            thread.originKind === "handoff" &&
            thread.sourceThreadId === request.sourceThreadId,
        )
        .map((thread) => thread.id),
    ),
  };
}

export function createPendingChat({
  request,
  create,
  send,
  renderer,
  prepare,
  queueOwner,
  onDurablyStaged,
}: {
  onDurablyStaged?: () => void;
  request: PendingChatRequest;
  create: (
    request: Omit<
      PendingChatRequest,
      | "capturedUploads"
      | "prepareInput"
      | "sendReservation"
      | "expectedPluginWait"
    >,
    context: { onStaged: (() => void) | undefined; pendingChatId: string },
  ) => Promise<ThreadResponse>;
  send: (request: SendThreadMessageMutationRequest) => Promise<unknown>;
  renderer: ComponentType<{ pendingId: string }>;
  prepare: (threadId: string) => Promise<void>;
  queueOwner: object;
}): { id: string; completion: Promise<ThreadResponse> } {
  restoreDescriptors();
  const id = `pending_${crypto.randomUUID()}`;

  const {
    capturedUploads: _uploads,
    prepareInput,
    sendReservation: _reservation,
    ...requestFields
  } = request;

  const captured = structuredClone(requestFields);
  const { expectedPluginWait: _expectedWait, ...createFields } = captured;
  const createdAt = Date.now();

  const inbox = predictPendingChatInbox(queueOwner, id, captured, createdAt);

  const entry: PendingChatEntry = {
    snapshot: {
      id,
      projectId: captured.projectId,
      realThreadId: null,
      request: captured,
      createdAt,
      handoff: capturePendingChatHandoff(captured, queueOwner),
      status: "creating",
      messages: [
        {
          id: `${id}:initial`,
          input: captured.input,
          hasAttachments:
            (_uploads?.files.length ?? 0) > 0 ||
            captured.input.some((input) => input.type !== "text"),
          status: "waiting",
        },
      ],
    },
    creation: null,
    send,
    renderer,
    prepare,
    queueOwner,
    handoffPending: false,
    retirement: null,
  };

  entries.set(id, entry);
  publish();

  const completion = Promise.resolve()
    .then(async () => {
      const input =
        prepareInput === undefined ? captured.input : await prepareInput();

      entry.snapshot = {
        ...entry.snapshot,
        messages: entry.snapshot.messages.map((message) =>
          message.id === `${id}:initial` ? { ...message, input } : message,
        ),
      };
      publish();

      return create(
        { ...createFields, input },
        { onStaged: onDurablyStaged, pendingChatId: id },
      );
    })
    .then(
      (thread) => {
        aliasComposerSendThread(queueOwner, id, thread.id);
        inbox.created(thread.id);
        entry.snapshot = {
          ...entry.snapshot,
          status: "opening",
          realThreadId: thread.id,
          messages: entry.snapshot.messages.map((message) =>
            message.id === `${id}:initial`
              ? { ...message, status: "accepted" }
              : message,
          ),
        };
        publish();
        void preparePendingChatRoute(id).catch(() => {});

        return thread;
      },
      (error: unknown) => {
        inbox.failed();
        entry.snapshot = {
          ...entry.snapshot,
          status: "failed",
          messages: entry.snapshot.messages.map((message) => ({
            ...message,
            status: "failed",
          })),
        };
        publish();
        throw error;
      },
    );

  entry.creation = completion;

  return { id, completion };
}

export async function preparePendingChatRoute(id: string): Promise<void> {
  const entry = entries.get(id);
  const realThreadId = entry?.snapshot.realThreadId;

  if (!entry || !realThreadId || entry.prepare === null) return;
  entry.snapshot = { ...entry.snapshot, status: "opening" };
  publish();

  try {
    await entry.prepare(realThreadId);
    entry.snapshot = { ...entry.snapshot, status: "ready" };
    publish();
  } catch (error) {
    entry.snapshot = { ...entry.snapshot, status: "open-failed" };
    publish();
    throw error;
  }
}

export function retirePendingChatSurface(
  id: string,
  { composerHeight = null }: { composerHeight?: number | null } = {},
): void {
  const entry = entries.get(id);

  if (!entry || entry.snapshot.realThreadId === null) return;
  entry.snapshot = {
    ...entry.snapshot,
    request: null,
    handoff: null,
    messages: [],
  };

  if (entry.renderer !== null)
    entry.retirement = { at: performance.now(), composerHeight };
  entry.renderer = null;
  entry.handoffPending = true;
  publish();
}

function findRecentPendingChatRetirement(
  threadId: string,
  now: number,
): PendingChatRetirement | null {
  for (const entry of entries.values()) {
    if (
      entry.retirement !== null &&
      entry.snapshot.realThreadId === threadId &&
      now - entry.retirement.at < RECENT_HANDOFF_WINDOW_MS
    )
      return entry.retirement;
  }

  return null;
}

export function isRecentPendingChatHandoff(
  threadId: string,
  now = performance.now(),
): boolean {
  return findRecentPendingChatRetirement(threadId, now) !== null;
}

export function pendingChatHandoffComposerHeight(
  threadId: string,
  now = performance.now(),
): number | null {
  return findRecentPendingChatRetirement(threadId, now)?.composerHeight ?? null;
}

export function takePendingChatHandoff(threadId: string): boolean {
  for (const entry of entries.values()) {
    if (!entry.handoffPending || entry.snapshot.realThreadId !== threadId)
      continue;
    entry.handoffPending = false;

    return true;
  }

  return false;
}

export function reservePendingChatSubmission(id: string): ComposerSendSlot {
  const entry = entries.get(id);

  if (entry?.queueOwner === undefined || entry.queueOwner === null)
    throw new Error(
      "This chat was interrupted. Review its recovered messages before sending.",
    );

  const slot = reserveComposerSend(
    entry.queueOwner,
    entry.snapshot.realThreadId ?? id,
  );

  const message = { id: crypto.randomUUID(), submitted: false };

  const reservation: ComposerSendSlot = {
    run: slot.run,
    cancel() {
      slot.cancel();

      if (message.submitted) return;
      entry.snapshot = {
        ...entry.snapshot,
        messages: entry.snapshot.messages.filter(
          (row) => row.id !== message.id,
        ),
      };
      publish();
    },
  };

  reservedMessages.set(reservation, message);

  if (entry.renderer !== null) {
    entry.snapshot = {
      ...entry.snapshot,
      messages: [
        ...entry.snapshot.messages,
        {
          id: message.id,
          input: [{ type: "text", text: "Preparing message…", mentions: [] }],
          hasAttachments: false,
          status: "waiting",
        },
      ],
    };
    publish();
  }

  return reservation;
}

export function submitPendingChatMessage(
  id: string,
  request: NewThreadComposerSubmission,
): Promise<void> {
  const entry = entries.get(id);

  if (!entry?.creation || entry.send === null || entry.queueOwner === null) {
    request.sendReservation?.cancel();

    return Promise.reject(
      new Error(
        "This chat was interrupted. Review the recovered messages in New chat.",
      ),
    );
  }

  const {
    capturedUploads: _uploads,
    prepareInput,
    sendReservation,
    ...requestFields
  } = request;

  const reservation =
    sendReservation ??
    reserveComposerSend(entry.queueOwner, entry.snapshot.realThreadId ?? id);

  const reservedMessage = reservedMessages.get(reservation);

  if (reservedMessage) reservedMessage.submitted = true;
  const messageId = reservedMessage?.id ?? crypto.randomUUID();
  const captured = structuredClone(requestFields);

  const message: PendingChatMessage = {
    id: messageId,
    input: captured.input,
    hasAttachments:
      (_uploads?.files.length ?? 0) > 0 ||
      captured.input.some((input) => input.type !== "text"),
    status: "waiting",
  };

  entry.snapshot = {
    ...entry.snapshot,
    messages:
      entry.renderer === null
        ? entry.snapshot.messages
        : reservedMessage === undefined
          ? [...entry.snapshot.messages, message]
          : entry.snapshot.messages.map((row) =>
              row.id === messageId ? message : row,
            ),
  };
  publish();
  const send = entry.send;

  const { providerId: _providerId, ...executionInputSources } =
    captured.executionInputSources;

  return entry.creation
    .then(async (thread) => {
      await send({
        id: thread.id,
        sendReservation: reservation,
        input: captured.input,
        ...(prepareInput === undefined
          ? {}
          : {
              prepareInput: async () => {
                const input = await prepareInput();
                entry.snapshot = {
                  ...entry.snapshot,
                  messages: entry.snapshot.messages.map((message) =>
                    message.id === messageId ? { ...message, input } : message,
                  ),
                };
                publish();

                return input;
              },
            }),
        model: captured.model,
        reasoningLevel: captured.reasoningLevel,
        permissionMode: captured.permissionMode,
        ...(captured.serviceTier === undefined
          ? {}
          : { serviceTier: captured.serviceTier }),
        ...(captured.sendAt === undefined ? {} : { sendAt: captured.sendAt }),
        ...(captured.pluginSubmission === undefined
          ? {}
          : { pluginSubmission: captured.pluginSubmission }),
        ...(captured.expectedPluginWait === undefined
          ? {}
          : { expectedPluginWait: captured.expectedPluginWait }),
        executionInputSources,
        mode: "auto",
      });
      entry.snapshot = {
        ...entry.snapshot,
        messages: entry.snapshot.messages.map((message) =>
          message.id === messageId
            ? { ...message, status: "accepted" }
            : message,
        ),
      };
      publish();
    })
    .catch((error: unknown) => {
      reservation.cancel();
      entry.snapshot = {
        ...entry.snapshot,
        messages: entry.snapshot.messages.map((message) =>
          message.id === messageId ? { ...message, status: "failed" } : message,
        ),
      };
      publish();
      throw error;
    });
}
