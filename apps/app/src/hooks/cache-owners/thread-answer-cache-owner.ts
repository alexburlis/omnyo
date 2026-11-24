import {
  hashKey,
  matchQuery,
  type Query,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from "@tanstack/react-query";
import type { PendingInteractionStatus, ThreadListEntry } from "@omnyo/domain";
import type {
  ThreadPendingInteractionsResponse,
  ThreadResponse,
} from "@omnyo/server-contract";
import { answerInboxQuestions } from "@/lib/inbox-predictions";
import {
  sidebarNavigationQueryKey,
  threadPendingInteractionsQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";
import {
  applyToCachedThreadListsAndSidebarNavigation,
  getCachedSidebarNavigationThreads,
} from "./query-cache";
import { predictInboxSnapshot } from "./inbox-snapshot-cache-owner";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import { withLocalThreadWork } from "./local-thread-work";

export type ThreadQuestionResolution = "answered" | "skipped";

export interface ResolvedThreadQuestion {
  threadId: string;
  questionId: string;
  resolution: ThreadQuestionResolution;
}

export interface ResolvedThreadQuestions {
  threadId: string;
  questionIds: readonly string[];
  resolution: ThreadQuestionResolution;
}

export interface ThreadListHold {
  release: () => void;
  rollback: () => void;
}

type ThreadAttention = NonNullable<ThreadListEntry["attention"]>;

type ThreadWork = NonNullable<ThreadListEntry["work"]>;

const RESOLVED_PRIMARY: Record<
  ThreadQuestionResolution,
  ThreadWork["primary"]
> = {
  answered: {
    label: "working",
    reason: {
      code: "answer-sent",
      text: "Your answer was sent; the agent is continuing.",
    },
  },
  skipped: {
    label: "open",
    reason: { code: "question-skipped", text: "You skipped the question." },
  },
};

function withoutResolvedInput(
  work: ThreadWork,
  questionId: string,
  resolution: ThreadQuestionResolution,
): ThreadWork {
  const requiredInput = work.requiredInput.filter(
    (input) => input.id !== questionId,
  );

  const optionalInput = work.optionalInput.filter(
    (input) => input.id !== questionId,
  );

  if (
    requiredInput.length === work.requiredInput.length &&
    optionalInput.length === work.optionalInput.length
  )
    return work;

  return {
    ...work,
    requiredInput,
    optionalInput,
    primary:
      work.primary.label === "needs-you" && requiredInput.length === 0
        ? RESOLVED_PRIMARY[resolution]
        : work.primary,
  };
}

function withoutResolvedAttention(
  attention: ThreadAttention,
  work: ThreadWork,
): ThreadAttention {
  const requiredCount = work.requiredInput.length;
  const optionalCount = work.optionalInput.length;

  const kind =
    attention.kind === "required-answer" || attention.kind === "optional-input"
      ? requiredCount > 0
        ? "required-answer"
        : optionalCount > 0
          ? "optional-input"
          : "none"
      : attention.kind;

  return { ...attention, kind, requiredCount, optionalCount };
}

export function withResolvedThreadQuestion(
  thread: ThreadListEntry,
  { questionId, resolution }: Omit<ResolvedThreadQuestion, "threadId">,
): ThreadListEntry {
  if (thread.work === null) return thread;

  const work = withoutResolvedInput(
    thread.work,
    questionId,
    thread.status === "active" || thread.status === "starting"
      ? "answered"
      : resolution,
  );

  if (work === thread.work) return thread;

  return {
    ...thread,
    work,
    ...(thread.attention === undefined
      ? {}
      : { attention: withoutResolvedAttention(thread.attention, work) }),
  };
}

export function withResolvedThreadInteraction(
  thread: ThreadListEntry,
  {
    interactionId,
    lastInteraction,
  }: { interactionId: string; lastInteraction: boolean },
): ThreadListEntry {
  const resolvedIds = new Set([interactionId]);

  if (lastInteraction) resolvedIds.add(`interaction:${thread.id}`);
  const work = thread.work;

  const requiredInput =
    work?.requiredInput.filter((input) => !resolvedIds.has(input.id)) ?? [];

  const inputChanged =
    work !== null && requiredInput.length !== work.requiredInput.length;

  const clearsFlag =
    lastInteraction &&
    thread.hasPendingInteraction &&
    !requiredInput.some((input) => input.kind === "permission");

  if (!inputChanged && !clearsFlag) return thread;

  const next = clearsFlag
    ? { ...thread, hasPendingInteraction: false }
    : thread;

  if (work === null || !inputChanged) return next;

  return requiredInput.length > 0
    ? { ...next, work: { ...work, requiredInput } }
    : withLocalThreadWork({ ...next, work: { ...work, requiredInput } });
}

function isFetchedThreadListData(event: QueryCacheNotifyEvent): boolean {
  if (
    event.type !== "updated" ||
    event.action.type !== "success" ||
    event.action.manual
  )
    return false;
  const query: Query = event.query;

  return (
    matchQuery({ queryKey: threadsQueryKey() }, query) ||
    matchQuery({ queryKey: sidebarNavigationQueryKey(), exact: true }, query)
  );
}

function cachedThreadEntries(
  queryClient: QueryClient,
  threadId: string,
): Map<string, ThreadListEntry> {
  const entries = new Map<string, ThreadListEntry>();

  for (const { queryKey, data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  }))
    for (const thread of iterateThreadListCacheEntries(data))
      if (thread.id === threadId) entries.set(hashKey(queryKey), thread);

  const sidebar = getCachedSidebarNavigationThreads(queryClient).find(
    (thread) => thread.id === threadId,
  );

  if (sidebar !== undefined)
    entries.set(hashKey(sidebarNavigationQueryKey()), sidebar);

  return entries;
}

export function projectCachedThreadListEntries(
  queryClient: QueryClient,
  threadId: string,
  project: (thread: ThreadListEntry) => ThreadListEntry,
  originals: Map<ThreadListEntry, ThreadListEntry> = new Map(),
): Map<ThreadListEntry, ThreadListEntry> {
  const before = cachedThreadEntries(queryClient, threadId);

  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) => {
    let changed = false;

    const next = list.map((thread) => {
      if (thread.id !== threadId) return thread;
      const projected = project(thread);
      changed ||= projected !== thread;

      return projected;
    });

    return changed ? next : list;
  });

  for (const [key, stored] of cachedThreadEntries(queryClient, threadId)) {
    const previous = before.get(key);

    if (previous !== undefined && previous !== stored)
      originals.set(stored, originals.get(previous) ?? previous);
  }

  return originals;
}

export function restoreCachedThreadListEntries(
  queryClient: QueryClient,
  originals: ReadonlyMap<ThreadListEntry, ThreadListEntry>,
): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) => {
    let changed = false;

    const next = list.map((thread) => {
      const original = originals.get(thread);

      if (original === undefined) return thread;
      changed = true;

      return original;
    });

    return changed ? next : list;
  });
}

function holdThreadListProjection(
  queryClient: QueryClient,
  threadId: string,
  project: (thread: ThreadListEntry) => ThreadListEntry,
): ThreadListHold {
  const originals = projectCachedThreadListEntries(
    queryClient,
    threadId,
    project,
  );

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (isFetchedThreadListData(event))
      projectCachedThreadListEntries(queryClient, threadId, project, originals);
  });

  let held = true;

  const release = () => {
    if (!held) return;
    held = false;
    unsubscribe();
  };

  return {
    release,
    rollback() {
      if (!held) return;
      release();
      restoreCachedThreadListEntries(queryClient, originals);
      originals.clear();
    },
  };
}

async function cancelThreadListReads(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
    queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() }),
  ]);
}

export async function beginResolvedThreadQuestionTransaction(
  queryClient: QueryClient,
  { threadId, questionIds, resolution }: ResolvedThreadQuestions,
): Promise<ThreadListHold> {
  await cancelThreadListReads(queryClient);

  return holdThreadListProjection(queryClient, threadId, (thread) =>
    questionIds.reduce(
      (current, questionId) =>
        withResolvedThreadQuestion(current, { questionId, resolution }),
      thread,
    ),
  );
}

export function isCachedThreadRunning(
  queryClient: QueryClient,
  threadId: string,
): boolean {
  const status =
    queryClient.getQueryData<ThreadResponse>(threadQueryKey(threadId))
      ?.status ??
    getCachedSidebarNavigationThreads(queryClient).find(
      (thread) => thread.id === threadId,
    )?.status;

  return status === "active" || status === "starting";
}

export interface ResolvedThreadInteractionTransaction {
  settle: (status: PendingInteractionStatus) => void;
  rollback: () => void;
}

const LIVE_INTERACTION_STATUSES: ReadonlySet<PendingInteractionStatus> =
  new Set(["pending", "resolving"]);

export async function beginResolvedThreadInteractionTransaction(
  queryClient: QueryClient,
  { threadId, interactionId }: { threadId: string; interactionId: string },
): Promise<ResolvedThreadInteractionTransaction> {
  const queryKey = threadPendingInteractionsQueryKey(threadId);
  const queryHash = hashKey(queryKey);

  await Promise.all([
    queryClient.cancelQueries({ queryKey, exact: true }),
    cancelThreadListReads(queryClient),
  ]);

  const previous =
    queryClient.getQueryData<ThreadPendingInteractionsResponse>(queryKey);

  const resolved = previous?.find((entry) => entry.id === interactionId);

  const lastInteraction =
    previous !== undefined &&
    previous.every((entry) => entry.id === interactionId);

  const hide = (
    current: ThreadPendingInteractionsResponse | undefined,
  ): ThreadPendingInteractionsResponse | undefined =>
    current?.some((entry) => entry.id === interactionId)
      ? current.filter((entry) => entry.id !== interactionId)
      : current;

  queryClient.setQueryData<ThreadPendingInteractionsResponse>(queryKey, hide);

  const hiddenUpdateCount =
    queryClient.getQueryState(queryKey)?.dataUpdateCount ?? null;

  const lists = holdThreadListProjection(queryClient, threadId, (thread) =>
    withResolvedThreadInteraction(thread, { interactionId, lastInteraction }),
  );

  const resumes = isCachedThreadRunning(queryClient, threadId);

  const answeredIds = lastInteraction
    ? [interactionId, `interaction:${threadId}`]
    : [interactionId];

  const inbox = predictInboxSnapshot(queryClient, (snapshot) =>
    answerInboxQuestions(snapshot, threadId, answeredIds, resumes),
  );

  let accepted = false;
  let held = true;
  let watching = true;

  const finish = (outcome: "settled" | "failed") => {
    if (!held) return;
    held = false;
    stopWatching();

    if (outcome === "settled") {
      inbox.settle();
      lists.release();
    } else {
      inbox.discard();
      lists.rollback();
    }
  };

  const onQueryEvent = (event: QueryCacheNotifyEvent) => {
    if (event.query.queryHash !== queryHash) return;

    if (event.type === "removed") {
      stopWatching();

      if (accepted) finish("settled");

      return;
    }

    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      event.action.manual
    )
      return;

    const fetched = queryClient
      .getQueryData<ThreadPendingInteractionsResponse>(queryKey)
      ?.find((entry) => entry.id === interactionId);

    if (
      accepted &&
      (fetched === undefined || !LIVE_INTERACTION_STATUSES.has(fetched.status))
    ) {
      finish("settled");

      return;
    }

    if (fetched !== undefined)
      queryClient.setQueryData<ThreadPendingInteractionsResponse>(
        queryKey,
        hide,
      );
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(onQueryEvent);

  function stopWatching(): void {
    if (!watching) return;
    watching = false;
    unsubscribe();
  }

  return {
    settle(status) {
      if (!held) return;
      accepted = true;

      if (!watching || !LIVE_INTERACTION_STATUSES.has(status))
        finish("settled");
    },
    rollback() {
      if (!held) return;
      finish("failed");

      if (resolved === undefined) return;

      if (
        hiddenUpdateCount !== null &&
        queryClient.getQueryState(queryKey)?.dataUpdateCount ===
          hiddenUpdateCount
      ) {
        queryClient.setQueryData<ThreadPendingInteractionsResponse>(
          queryKey,
          previous,
        );

        return;
      }

      queryClient.setQueryData<ThreadPendingInteractionsResponse>(
        queryKey,
        (current) =>
          current === undefined ||
          current.some((entry) => entry.id === interactionId)
            ? current
            : [...current, resolved],
      );
    },
  };
}
