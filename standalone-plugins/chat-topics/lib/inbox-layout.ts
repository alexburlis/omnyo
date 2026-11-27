import { z } from "zod";
import { readStored, writeStored } from "./storage.ts";
import type { InboxEntry } from "./inbox.ts";

export type InboxFocus = { kind: "card"; threadId: string } | { kind: "below" } | null;

export interface InboxLayout {
  order: readonly string[];
  above: ReadonlySet<string>;
}

export interface ArrangeInput {
  focus: InboxFocus;
  scrolledPast: boolean;
}

export interface Revealed {
  layout: InboxLayout;
  first: string | null;
}

export interface ShownCard {
  entry: InboxEntry;
}

export const CHANGE_GUARD_MS = 1000;

const NONE: ReadonlySet<string> = new Set();

function isQuestion(entry: InboxEntry | undefined): boolean {
  return entry?.card?.kind === "question";
}

function markOf(focus: InboxFocus, order: readonly string[]): number {
  if (focus === null) return -1;

  return focus.kind === "below" ? order.length : order.indexOf(focus.threadId);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function fresh(live: readonly InboxEntry[]): InboxLayout {
  return {
    order: live.map((entry) => entry.threadId),
    above: NONE,
  };
}

export function arrangeInbox(
  previous: InboxLayout | null,
  live: readonly InboxEntry[],
  input: ArrangeInput,
): InboxLayout {
  if (previous === null) return fresh(live);
  const byId = new Map(live.map((entry) => [entry.threadId, entry]));

  const order = live.map((entry) => entry.threadId);
  const known = new Set(previous.order);
  const position = new Map(order.map((id, index) => [id, index]));
  const mark = markOf(input.focus, order);

  const isAbove = (id: string) =>
    input.scrolledPast && mark >= 0 && (position.get(id) ?? Number.POSITIVE_INFINITY) < mark;

  const above = new Set([...previous.above].filter((id) => byId.has(id) && isAbove(id)));

  for (const entry of live)
    if (!known.has(entry.threadId) && isQuestion(entry) && isAbove(entry.threadId))
      above.add(entry.threadId);

  const next: InboxLayout = {
    order: sameList(order, previous.order) ? previous.order : order,
    above: sameSet(above, previous.above) ? previous.above : above,
  };

  const unchanged = next.order === previous.order && next.above === previous.above;

  return unchanged ? previous : next;
}

export function shownCards(layout: InboxLayout, live: readonly InboxEntry[]): ShownCard[] {
  const byId = new Map(live.map((entry) => [entry.threadId, entry]));

  return layout.order.flatMap((id) => {
    const entry = byId.get(id);

    return entry === undefined ? [] : [{ entry }];
  });
}

export function cardChanges(
  previous: ReadonlyMap<string, string> | null,
  live: readonly InboxEntry[],
): string[] {
  if (previous === null) return [];

  return live.flatMap((entry) => {
    const before = previous.get(entry.threadId);

    return before === undefined || before === entry.latch ? [] : [entry.threadId];
  });
}

export function recentlyChanged(
  changes: ReadonlyMap<string, number>,
  threadId: string,
  now: number,
): boolean {
  const at = changes.get(threadId);

  return at !== undefined && now - at < CHANGE_GUARD_MS;
}

export function revealAbove(layout: InboxLayout): Revealed {
  const first = layout.order.find((id) => layout.above.has(id)) ?? null;

  return { layout: { ...layout, above: NONE }, first };
}

const STATUS_ORDER_KEY = "chat-topics:inbox-status-order";

const statusOrderSchema = z.array(z.tuple([z.string(), z.array(z.string())]));

export function readInboxStatusOrder(): ReadonlyMap<string, readonly string[]> {
  return new Map(readStored(STATUS_ORDER_KEY, statusOrderSchema, []));
}

export function writeInboxStatusOrder(order: ReadonlyMap<string, readonly string[]>) {
  writeStored(STATUS_ORDER_KEY, Array.from(order));
}

export function orderInboxStatusRows(
  previous: ReadonlyMap<string, readonly string[]> | null,
  rows: readonly { id: string; group: string; at: number }[],
): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, string[]>();

  for (const { id, group } of [...rows].sort((a, b) => b.at - a.at)) {
    const ids = groups.get(group) ?? [];
    ids.push(id);
    groups.set(group, ids);
  }

  for (const [group, ids] of groups) {
    const prior = previous?.get(group);

    if (prior === undefined) continue;
    const old = new Set(prior);
    const present = new Set(ids);
    groups.set(group, [
      ...ids.filter((id) => !old.has(id)),
      ...prior.filter((id) => present.has(id)),
    ]);
  }

  return previous !== null &&
    previous.size === groups.size &&
    [...groups].every(([group, ids]) => sameList(previous.get(group) ?? [], ids))
    ? previous
    : groups;
}
