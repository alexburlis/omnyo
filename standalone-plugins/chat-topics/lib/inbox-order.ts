import { useSyncExternalStore } from "react";
import { z } from "zod";
import { readStored, removeStored, writeStored } from "./storage.ts";

export const INBOX_SECTION_KEYS = [
  "need",
  "failed",
  "finished",
  "ready",
  "run",
  "waiting",
  "shelf",
] as const;

export type InboxSectionKey = (typeof INBOX_SECTION_KEYS)[number];

export type DropPlace = "before" | "after";

export const INBOX_SECTION_LABEL: Readonly<Record<InboxSectionKey, string>> = {
  need: "Needs you",
  failed: "Failed",
  finished: "Finished",
  ready: "Ready to archive",
  run: "Running",
  waiting: "Waiting",
  shelf: "Shelf",
};

export const ALWAYS_SHOWN_SECTION: InboxSectionKey = "need";

export const DEFAULT_SHOW_EMPTY = false;

export interface InboxSections {
  order: readonly InboxSectionKey[];
  hidden: ReadonlySet<InboxSectionKey>;
  showEmpty: boolean;
}

const ORDER_KEY = "chat-topics:inbox-order";

const HIDDEN_KEY = "chat-topics:inbox-hidden";

const SHOW_EMPTY_KEY = "chat-topics:inbox-empty-sections";

const STORED_KEYS: ReadonlySet<string> = new Set([ORDER_KEY, HIDDEN_KEY, SHOW_EMPTY_KEY]);

const keysSchema = z.array(z.string());

const SECTION_KEYS: ReadonlySet<string> = new Set(INBOX_SECTION_KEYS);

export function isInboxSectionKey(value: string): value is InboxSectionKey {
  return SECTION_KEYS.has(value);
}

export function normalizeOrder(stored: readonly string[]): InboxSectionKey[] {
  const order = [...new Set(stored)].filter(isInboxSectionKey);

  if (order.length === 0) return [...INBOX_SECTION_KEYS];

  if (!order.includes("finished"))
    order.splice(Math.max(0, order.indexOf("need") + 1), 0, "finished");

  if (!order.includes("failed")) order.splice(Math.max(0, order.indexOf("need") + 1), 0, "failed");

  for (const key of INBOX_SECTION_KEYS) if (!order.includes(key)) order.push(key);

  return order;
}

export function normalizeHidden(stored: readonly string[]): Set<InboxSectionKey> {
  return new Set(stored.filter(isInboxSectionKey).filter((key) => key !== ALWAYS_SHOWN_SECTION));
}

export function moveSection(
  order: readonly InboxSectionKey[],
  moved: InboxSectionKey,
  target: InboxSectionKey,
  place: DropPlace,
): InboxSectionKey[] {
  if (moved === target) return [...order];
  const next = order.filter((key) => key !== moved);
  const at = next.indexOf(target);

  if (at < 0) return [...order];
  next.splice(place === "before" ? at : at + 1, 0, moved);

  return next;
}

export function stepSection(
  order: readonly InboxSectionKey[],
  key: InboxSectionKey,
  step: -1 | 1,
): InboxSectionKey[] {
  const at = order.indexOf(key);
  const target = at < 0 ? undefined : order[at + step];

  if (target === undefined) return [...order];

  return moveSection(order, key, target, step < 0 ? "before" : "after");
}

export function shownSections(sections: InboxSections): InboxSectionKey[] {
  return sections.order.filter((key) => !sections.hidden.has(key));
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export function isDefaultSections(sections: InboxSections): boolean {
  return (
    sameOrder(sections.order, INBOX_SECTION_KEYS) &&
    sections.hidden.size === 0 &&
    sections.showEmpty === DEFAULT_SHOW_EMPTY
  );
}

let current: InboxSections | null = null;

const listeners = new Set<() => void>();

function readSections(): InboxSections {
  return {
    order: normalizeOrder(readStored(ORDER_KEY, keysSchema, [])),
    hidden: normalizeHidden(readStored(HIDDEN_KEY, keysSchema, [])),
    showEmpty: readStored(SHOW_EMPTY_KEY, z.boolean(), DEFAULT_SHOW_EMPTY),
  };
}

function snapshot(): InboxSections {
  current ??= readSections();

  return current;
}

function emit() {
  for (const listener of listeners) listener();
}

function publish(next: InboxSections) {
  current = next;
  emit();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && !STORED_KEYS.has(event.key)) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function reorder(order: InboxSectionKey[]) {
  const sections = snapshot();

  if (sameOrder(order, sections.order)) return;
  writeStored(ORDER_KEY, order);
  publish({ ...sections, order });
}

export function moveInboxSection(
  moved: InboxSectionKey,
  target: InboxSectionKey,
  place: DropPlace,
) {
  reorder(moveSection(snapshot().order, moved, target, place));
}

export function stepInboxSection(key: InboxSectionKey, step: -1 | 1) {
  reorder(stepSection(snapshot().order, key, step));
}

export function setInboxSectionShown(key: InboxSectionKey, shown: boolean) {
  const sections = snapshot();

  if (key === ALWAYS_SHOWN_SECTION || sections.hidden.has(key) !== shown) return;
  const hidden = new Set(sections.hidden);

  if (shown) hidden.delete(key);
  else hidden.add(key);
  writeStored(HIDDEN_KEY, [...hidden]);
  publish({ ...sections, hidden });
}

export function setInboxShowEmpty(showEmpty: boolean) {
  const sections = snapshot();

  if (sections.showEmpty === showEmpty) return;
  writeStored(SHOW_EMPTY_KEY, showEmpty);
  publish({ ...sections, showEmpty });
}

export function resetInboxSections() {
  for (const key of STORED_KEYS) removeStored(key);
  publish({ order: [...INBOX_SECTION_KEYS], hidden: new Set(), showEmpty: DEFAULT_SHOW_EMPTY });
}

export function useInboxSections(): InboxSections {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
