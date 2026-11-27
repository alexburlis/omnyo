import { compareShelved, type ChatNode, type ChatTree, type GroupThread } from "./grouping.ts";
import type { DropPlace } from "./inbox-order.ts";

export interface ShelfSlot {
  id: string;
  keyed: boolean;
}

export interface ShelfMove {
  threadId: string;
  previousThreadId: string | null;
  nextThreadId: string | null;
  order: string[];
}

export interface ShelfHold {
  order: readonly string[];
  settled: readonly string[] | null;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function keyedNeighbor(
  order: readonly string[],
  keyed: ReadonlySet<string>,
  from: number,
  step: -1 | 1,
): string | null {
  for (let at = from + step; at >= 0 && at < order.length; at += step)
    if (keyed.has(order[at])) return order[at];

  return null;
}

export function shelfMove(
  slots: readonly ShelfSlot[],
  movedId: string,
  targetId: string,
  place: DropPlace,
): ShelfMove | null {
  const ids = slots.map((slot) => slot.id);

  if (movedId === targetId || !ids.includes(movedId)) return null;
  const order = ids.filter((id) => id !== movedId);
  const at = order.indexOf(targetId);

  if (at < 0) return null;
  order.splice(place === "before" ? at : at + 1, 0, movedId);

  if (sameList(order, ids)) return null;
  const keyed = new Set(slots.flatMap((slot) => (slot.keyed ? [slot.id] : [])));
  const moved = order.indexOf(movedId);

  return {
    threadId: movedId,
    previousThreadId: keyedNeighbor(order, keyed, moved, -1),
    nextThreadId: keyedNeighbor(order, keyed, moved, 1),
    order,
  };
}

export function liveShelfOrder(
  threads: readonly GroupThread[],
  ids: readonly string[],
): readonly string[] {
  const wanted = new Set(ids);

  return threads
    .filter((thread) => wanted.has(thread.id) && thread.shelvedAt !== null)
    .sort(compareShelved)
    .map((thread) => thread.id);
}

export function heldShelfOrder(
  hold: ShelfHold | null,
  live: readonly string[],
): readonly string[] | null {
  if (hold === null) return null;

  if (hold.settled === null) return hold.order;
  const wanted = new Set(live);
  const held = hold.order.filter((id) => wanted.has(id));

  return sameList(live, hold.settled) && !sameList(live, held) ? hold.order : null;
}

export function inHeldOrder(
  shelf: readonly ChatNode[],
  order: readonly string[] | null,
): readonly ChatNode[] {
  if (order === null) return shelf;
  const rank = new Map(order.map((id, index) => [id, index]));
  const held = shelf.filter((node) => rank.has(node.thread.id));

  if (held.length < 2) return shelf;
  held.sort((a, b) => (rank.get(a.thread.id) ?? 0) - (rank.get(b.thread.id) ?? 0));
  let next = 0;

  return shelf.map((node) => (rank.has(node.thread.id) ? held[next++] : node));
}

export function withHeldShelf(tree: ChatTree, order: readonly string[] | null): ChatTree {
  const shelf = inHeldOrder(tree.shelf, order);

  return shelf === tree.shelf ? tree : { ...tree, shelf: [...shelf] };
}

export function inShelfOrder<Entry>(
  entries: readonly Entry[],
  shelf: readonly ChatNode[],
  threadIdOf: (entry: Entry) => string,
): Entry[] {
  const rank = new Map<string, number>();

  for (const [index, root] of shelf.entries())
    for (const member of root.family) rank.set(member.id, index);

  const at = (entry: Entry) => rank.get(threadIdOf(entry)) ?? Number.POSITIVE_INFINITY;

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => at(a.entry) - at(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}
