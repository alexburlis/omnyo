import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PromptTextMention } from "@omnyo/domain";
import type {
  PromptDraftAttachment,
  PromptDraftState,
} from "@omnyo/client-core";
import {
  arePromptDraftStatesEqual,
  emptyPromptDraftState,
  isPromptDraftEmpty,
  withPromptImageAliasHighWater,
  parsePromptDraftStorage,
  parseRecoverablePromptDraftStorage,
  promptDraftToInput,
} from "@omnyo/client-core";

import { assertBrowserStorageMigrationV1 } from "@/lib/legacy-browser-storage-v1";

import {
  mergeRecoveredPromptDraftV1,
  promptDraftStorageKeyV1,
  serializePersistedPromptDraftV1,
  type PromptDraftScope,
} from "@/lib/prompt-draft-recovery-v1";

export type { PromptDraftScope } from "@/lib/prompt-draft-recovery-v1";

const PROMPT_DRAFT_PERSIST_DEBOUNCE_MS = 250;

interface PromptDraftCacheEntry {
  rawValue: string | null;
  draft: PromptDraftState;
}

type PromptDraftListener = () => void;

interface PromptDraftWriteOptions {
  persist: "immediate" | "deferred";
  imageAliases?: "keep" | "reset";
}

const EMPTY_PROMPT_DRAFT = emptyPromptDraftState();

const promptDraftCache = new Map<string, PromptDraftCacheEntry>();

const promptDraftSubscribers = new Map<string, Set<PromptDraftListener>>();

const pendingPromptDraftStorageKeys = new Set<string>();

const promptDraftPersistTimers = new Map<string, number>();

let promptDraftStorageObserverInitialized = false;

function readPromptDraft(storageKey: string | null): PromptDraftState {
  if (!storageKey || typeof window === "undefined") {
    return EMPTY_PROMPT_DRAFT;
  }

  if (pendingPromptDraftStorageKeys.has(storageKey)) {
    return promptDraftCache.get(storageKey)?.draft ?? EMPTY_PROMPT_DRAFT;
  }

  const rawValue = window.localStorage.getItem(storageKey);
  const cachedEntry = promptDraftCache.get(storageKey);

  if (cachedEntry && cachedEntry.rawValue === rawValue) {
    return cachedEntry.draft;
  }

  const draft = parsePromptDraftStorage(rawValue);
  promptDraftCache.set(storageKey, {
    rawValue,
    draft,
  });

  return draft;
}

function emitPromptDraftChange(storageKey: string): void {
  const listeners = promptDraftSubscribers.get(storageKey);

  if (!listeners || listeners.size === 0) return;

  for (const listener of listeners) {
    listener();
  }
}

function clearPromptDraftPersistTimer(storageKey: string): void {
  const timerId = promptDraftPersistTimers.get(storageKey);

  if (timerId === undefined || typeof window === "undefined") return;

  window.clearTimeout(timerId);
  promptDraftPersistTimers.delete(storageKey);
}

function persistPromptDraftCache(storageKey: string): void {
  if (typeof window === "undefined") return;

  clearPromptDraftPersistTimer(storageKey);
  pendingPromptDraftStorageKeys.delete(storageKey);

  const cachedEntry = promptDraftCache.get(storageKey);

  if (!cachedEntry) {
    window.localStorage.removeItem(storageKey);

    return;
  }

  const { draft } = cachedEntry;

  const serialized = serializePersistedPromptDraftV1(draft);

  cachedEntry.rawValue = serialized;

  if (serialized === null) {
    window.localStorage.removeItem(storageKey);

    return;
  }

  try {
    window.localStorage.setItem(storageKey, serialized);
  } catch (error) {
    cachedEntry.rawValue = readStoredPromptDraftValue(storageKey);
    console.warn(
      `[prompt-draft] could not persist draft for ${storageKey}; keeping it in memory only`,
      error,
    );
  }
}

function readStoredPromptDraftValue(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function schedulePromptDraftPersist(storageKey: string): void {
  if (typeof window === "undefined") return;

  clearPromptDraftPersistTimer(storageKey);
  pendingPromptDraftStorageKeys.add(storageKey);

  const timerId = window.setTimeout(() => {
    persistPromptDraftCache(storageKey);
  }, PROMPT_DRAFT_PERSIST_DEBOUNCE_MS);

  promptDraftPersistTimers.set(storageKey, timerId);
}

function flushPendingPromptDraftPersists(): void {
  for (const storageKey of Array.from(pendingPromptDraftStorageKeys)) {
    persistPromptDraftCache(storageKey);
  }
}

function ensurePromptDraftStorageObserver(): void {
  if (promptDraftStorageObserverInitialized || typeof window === "undefined") {
    return;
  }

  promptDraftStorageObserverInitialized = true;
  window.addEventListener("storage", (event) => {
    if (!event.key) return;

    if (pendingPromptDraftStorageKeys.has(event.key)) return;
    promptDraftCache.delete(event.key);
    emitPromptDraftChange(event.key);
  });
  window.addEventListener("pagehide", flushPendingPromptDraftPersists);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushPendingPromptDraftPersists();
    }
  });
}

function subscribePromptDraft(
  storageKey: string | null,
  listener: PromptDraftListener,
): () => void {
  if (!storageKey) {
    return () => {};
  }

  ensurePromptDraftStorageObserver();

  let listeners = promptDraftSubscribers.get(storageKey);

  if (!listeners) {
    listeners = new Set();
    promptDraftSubscribers.set(storageKey, listeners);
  }

  listeners.add(listener);

  return () => {
    const existingListeners = promptDraftSubscribers.get(storageKey);

    if (!existingListeners) return;

    existingListeners.delete(listener);

    if (existingListeners.size === 0) {
      promptDraftSubscribers.delete(storageKey);
    }
  };
}

function writePromptDraft(
  storageKey: string | null,
  value: PromptDraftState,
  options: PromptDraftWriteOptions = { persist: "immediate" },
): void {
  if (!storageKey || typeof window === "undefined") return;

  const draft =
    options.imageAliases === "reset"
      ? value
      : withPromptImageAliasHighWater(
          promptDraftCache.get(storageKey)?.draft ?? null,
          value,
        );

  promptDraftCache.set(storageKey, {
    rawValue: null,
    draft:
      isPromptDraftEmpty(draft) && draft.imageAliasHighWater === undefined
        ? EMPTY_PROMPT_DRAFT
        : draft,
  });

  if (options.persist === "deferred") {
    schedulePromptDraftPersist(storageKey);
  } else {
    persistPromptDraftCache(storageKey);
  }

  emitPromptDraftChange(storageKey);
}

function restorePromptDraftIfEmpty(
  storageKey: string | null,
  value: PromptDraftState,
): boolean {
  if (
    !storageKey ||
    typeof window === "undefined" ||
    isPromptDraftEmpty(value)
  ) {
    return false;
  }

  if (!isPromptDraftEmpty(readPromptDraft(storageKey))) {
    return false;
  }

  writePromptDraft(storageKey, value);

  return true;
}

function restoreFailedDraft(storageKey: string, draft: PromptDraftState): void {
  if (isPromptDraftEmpty(draft)) return;

  if (typeof window !== "undefined")
    parseRecoverablePromptDraftStorage(window.localStorage.getItem(storageKey));
  writePromptDraft(
    storageKey,
    mergeRecoveredPromptDraftV1(readPromptDraft(storageKey), draft),
  );
}

export function restoreFailedPromptDraft(
  scope: PromptDraftScope,
  draft: PromptDraftState,
  options: { requirePersistence?: true } = {},
): void {
  const storageKey = getPromptDraftStorageKey(scope);

  if (options.requirePersistence) readPromptDraft(storageKey);
  const previous = promptDraftCache.get(storageKey);
  restoreFailedDraft(storageKey, draft);

  if (!options.requirePersistence) return;

  try {
    const expected = promptDraftCache.get(storageKey)?.draft;

    const persisted = parseRecoverablePromptDraftStorage(
      window.localStorage.getItem(storageKey),
    );

    if (
      expected === undefined ||
      !arePromptDraftStatesEqual(expected, persisted)
    )
      throw new Error("Draft persistence was not confirmed");
  } catch {
    if (previous) promptDraftCache.set(storageKey, previous);
    else promptDraftCache.delete(storageKey);
    emitPromptDraftChange(storageKey);
    throw new Error(
      "Could not persist the recovered draft. Its recovery journal was retained.",
    );
  }
}

export function movePromptDraft(
  sourceScope: PromptDraftScope,
  targetScope: PromptDraftScope,
): void {
  const sourceKey = getPromptDraftStorageKey(sourceScope);
  const targetKey = getPromptDraftStorageKey(targetScope);

  if (sourceKey === targetKey) return;

  if (typeof window !== "undefined") {
    parseRecoverablePromptDraftStorage(window.localStorage.getItem(sourceKey));
    parseRecoverablePromptDraftStorage(window.localStorage.getItem(targetKey));
  }

  const source = createPromptDraftController(sourceKey);
  const draft = source.getCurrent();

  if (isPromptDraftEmpty(draft)) return;
  restoreFailedDraft(targetKey, draft);
  source.clearIfCurrentMatches(draft);
}

function getPromptDraftStorageKey(scope: PromptDraftScope): string {
  assertBrowserStorageMigrationV1();

  return promptDraftStorageKeyV1(scope);
}

export interface PromptDraftController {
  storageKey: string;
  getCurrent: () => PromptDraftState;
  subscribe: (listener: () => void) => () => void;
  setDraft: (draft: PromptDraftState) => void;
  setTextAndMentions: (
    nextText: string,
    nextMentions: PromptTextMention[],
  ) => void;
  setAttachments: (attachments: PromptDraftAttachment[]) => void;
  addAttachment: (attachment: PromptDraftAttachment) => void;
  updateAttachments: (
    update: (attachments: PromptDraftAttachment[]) => PromptDraftAttachment[],
  ) => void;
  clear: () => void;
  clearIfCurrentMatches: (expectedDraft: PromptDraftState) => boolean;
  restoreIfEmpty: (nextDraft: PromptDraftState) => void;
  restoreFailedDraft: (nextDraft: PromptDraftState) => void;
}

function createPromptDraftController(
  storageKey: string,
): PromptDraftController {
  return {
    storageKey,
    getCurrent: () => readPromptDraft(storageKey),
    subscribe: (listener) => subscribePromptDraft(storageKey, listener),
    setDraft: (draft) => writePromptDraft(storageKey, draft),
    setTextAndMentions: (nextText, nextMentions) => {
      writePromptDraft(
        storageKey,
        {
          ...readPromptDraft(storageKey),
          text: nextText,
          mentions: nextMentions,
        },
        { persist: "deferred" },
      );
    },
    setAttachments: (attachments) => {
      writePromptDraft(storageKey, {
        ...readPromptDraft(storageKey),
        attachments,
      });
    },
    addAttachment: (attachment) => {
      const currentDraft = readPromptDraft(storageKey);

      const alreadyExists = currentDraft.attachments.some(
        (existingAttachment) => existingAttachment.path === attachment.path,
      );

      if (alreadyExists) return;

      writePromptDraft(storageKey, {
        ...currentDraft,
        attachments: [...currentDraft.attachments, attachment],
      });
    },
    updateAttachments: (update) => {
      const currentDraft = readPromptDraft(storageKey);
      writePromptDraft(storageKey, {
        ...currentDraft,
        attachments: update(currentDraft.attachments),
      });
    },
    clear: () =>
      writePromptDraft(storageKey, EMPTY_PROMPT_DRAFT, {
        persist: "immediate",
        imageAliases: "reset",
      }),
    clearIfCurrentMatches: (expectedDraft) => {
      if (
        !arePromptDraftStatesEqual(readPromptDraft(storageKey), expectedDraft)
      ) {
        return false;
      }

      writePromptDraft(storageKey, EMPTY_PROMPT_DRAFT, {
        persist: "immediate",
        imageAliases: "reset",
      });

      return true;
    },
    restoreIfEmpty: (nextDraft) => {
      restorePromptDraftIfEmpty(storageKey, nextDraft);
    },
    restoreFailedDraft: (nextDraft) =>
      restoreFailedDraft(storageKey, nextDraft),
  };
}

export function getPromptDraftAccessor(
  scope: PromptDraftScope,
): PromptDraftController {
  return createPromptDraftController(getPromptDraftStorageKey(scope));
}

export function usePromptDraftController(
  scope: PromptDraftScope,
): PromptDraftController {
  const storageKey = getPromptDraftStorageKey(scope);

  return useMemo(() => createPromptDraftController(storageKey), [storageKey]);
}

type PromptDraftSource = Pick<
  PromptDraftController,
  "getCurrent" | "subscribe"
>;

export function usePromptDraftSnapshot(
  source: PromptDraftSource,
): PromptDraftState {
  return useSyncExternalStore(
    source.subscribe,
    source.getCurrent,
    () => EMPTY_PROMPT_DRAFT,
  );
}

export function usePromptDraftInputEmpty(source: PromptDraftSource): boolean {
  return useSyncExternalStore(
    source.subscribe,
    () => promptDraftToInput(source.getCurrent()).length === 0,
    () => true,
  );
}

export function usePromptDraftStorage(scope: PromptDraftScope) {
  const controller = usePromptDraftController(scope);
  const draft = usePromptDraftSnapshot(controller);

  return useMemo(
    () => ({
      ...controller,
      draft,
      value: draft.text,
      text: draft.text,
      mentions: draft.mentions,
      attachments: draft.attachments,
    }),
    [controller, draft],
  );
}

export function usePromptDraftHasInput(scope: PromptDraftScope): boolean {
  const storageKey = getPromptDraftStorageKey(scope);

  return useSyncExternalStore(
    useCallback(
      (listener) => subscribePromptDraft(storageKey, listener),
      [storageKey],
    ),
    useCallback(
      () => !isPromptDraftEmpty(readPromptDraft(storageKey)),
      [storageKey],
    ),
    () => false,
  );
}

interface PromptDraftThreadRef {
  id: string;
  projectId: string;
}

interface PromptDraftThreadSubscription {
  storageKey: string;
  threadId: string;
}

function getEmptyPresenceSnapshot(): string {
  return "";
}

function readPromptDraftPresenceBit(storageKey: string): "0" | "1" {
  return isPromptDraftEmpty(readPromptDraft(storageKey)) ? "0" : "1";
}

function createPromptDraftPresenceStore(
  subscriptions: readonly PromptDraftThreadSubscription[],
): {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => string;
} {
  let bits: ("0" | "1")[] | null = null;
  let snapshot: string | null = null;

  const refresh = (): string => {
    bits = subscriptions.map(({ storageKey }) =>
      readPromptDraftPresenceBit(storageKey),
    );
    snapshot = bits.join("");

    return snapshot;
  };

  return {
    getSnapshot: () => snapshot ?? refresh(),
    subscribe: (listener) => {
      snapshot = null;
      bits = null;

      const unsubscribe = subscriptions.map(({ storageKey }, index) =>
        subscribePromptDraft(storageKey, () => {
          const bit = readPromptDraftPresenceBit(storageKey);

          if (bits !== null && bits[index] === bit) return;

          if (bits === null) {
            refresh();
          } else {
            bits[index] = bit;
            snapshot = bits.join("");
          }

          listener();
        }),
      );

      return () => {
        for (const stopListening of unsubscribe) {
          stopListening();
        }
      };
    },
  };
}

export function usePromptDraftInputThreadIds(
  threads: readonly PromptDraftThreadRef[],
): ReadonlySet<string> {
  const subscriptions = useMemo<PromptDraftThreadSubscription[]>(() => {
    const seenStorageKeys = new Set<string>();
    const next: PromptDraftThreadSubscription[] = [];

    for (const thread of threads) {
      const storageKey = getPromptDraftStorageKey({
        kind: "thread",
        projectId: thread.projectId,
        threadId: thread.id,
      });

      if (!storageKey || seenStorageKeys.has(storageKey)) continue;

      seenStorageKeys.add(storageKey);
      next.push({ storageKey, threadId: thread.id });
    }

    return next;
  }, [threads]);

  const presenceStore = useMemo(
    () => createPromptDraftPresenceStore(subscriptions),
    [subscriptions],
  );

  const presenceSnapshot = useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
    getEmptyPresenceSnapshot,
  );

  return useMemo(() => {
    const threadIds = new Set<string>();
    subscriptions.forEach(({ threadId }, index) => {
      if (presenceSnapshot[index] === "1") {
        threadIds.add(threadId);
      }
    });

    return threadIds;
  }, [presenceSnapshot, subscriptions]);
}
