import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";
import type { ExperimentalComposerSuggestion } from "@omnyo/plugin-sdk";
import { createKeyedListeners } from "./keyed-listeners";

const callbackSchema = z.custom<() => void>(
  (value) => typeof value === "function",
);

const composerSuggestionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    text: z.string().refine((text) => text.trim() !== ""),
    onDismiss: callbackSchema,
    onRegenerate: callbackSchema.optional(),
  }),
  z.object({ status: z.literal("loading"), onDismiss: callbackSchema }),
  z.object({
    status: z.literal("failed"),
    message: z.string(),
    onRetry: callbackSchema,
    onDismiss: callbackSchema,
  }),
  z.object({
    status: z.literal("none"),
    reason: z.string().refine((reason) => reason.trim() !== ""),
    onRequest: callbackSchema,
    onDismiss: callbackSchema,
  }),
]);

type ComposerSuggestionOwner = string | symbol;

interface ComposerSuggestionEntry {
  pluginId: string;
  suggestion: ExperimentalComposerSuggestion;
  order: number;
}

const entriesByStorageKey = new Map<
  string,
  Map<ComposerSuggestionOwner, ComposerSuggestionEntry>
>();

const shownByStorageKey = new Map<string, ExperimentalComposerSuggestion>();

const suggestionListeners = createKeyedListeners<string>();

export function parseComposerSuggestion(
  value: unknown,
): ExperimentalComposerSuggestion {
  const parsed = composerSuggestionSchema.safeParse(value);

  if (!parsed.success) {
    throw new TypeError(
      'A composer suggestion needs status "ready" with text, "loading", "failed" with a message and onRetry, or "none" with a reason and onRequest, plus onDismiss.',
    );
  }

  return parsed.data;
}

export function getComposerSuggestion(
  storageKey: string | null,
): ExperimentalComposerSuggestion | null {
  if (storageKey === null) return null;

  return shownByStorageKey.get(storageKey) ?? null;
}

export function setComposerSuggestion(
  storageKey: string | null,
  pluginId: string,
  suggestion: ExperimentalComposerSuggestion | null,
  owner: ComposerSuggestionOwner,
  ownerOrder: number,
): void {
  if (storageKey === null) return;
  let entries = entriesByStorageKey.get(storageKey);

  if (suggestion === null) {
    if (entries?.delete(owner) !== true) return;

    if (entries.size === 0) entriesByStorageKey.delete(storageKey);
  } else {
    if (!entries) {
      entries = new Map();
      entriesByStorageKey.set(storageKey, entries);
    }

    const previous = entries.get(owner);

    if (previous?.suggestion === suggestion) return;
    entries.set(owner, {
      pluginId,
      suggestion,
      order: previous?.order ?? ownerOrder,
    });
  }

  const shown = [...(entriesByStorageKey.get(storageKey)?.values() ?? [])].sort(
    (a, b) => a.pluginId.localeCompare(b.pluginId) || a.order - b.order,
  )[0]?.suggestion;

  if (shownByStorageKey.get(storageKey) === shown) return;

  if (shown === undefined) shownByStorageKey.delete(storageKey);
  else shownByStorageKey.set(storageKey, shown);
  suggestionListeners.notify(storageKey);
}

export function useComposerSuggestion(
  storageKey: string | null,
): ExperimentalComposerSuggestion | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      storageKey === null
        ? () => {}
        : suggestionListeners.subscribe(storageKey, listener),
    [storageKey],
  );

  const getSnapshot = useCallback(
    () => getComposerSuggestion(storageKey),
    [storageKey],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
