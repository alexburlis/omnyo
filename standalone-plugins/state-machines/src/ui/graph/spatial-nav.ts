import { center, type Rect } from "./geometry.js";

export type Direction = "up" | "down" | "left" | "right";

export function nearestInDirection(
  fromId: string,
  direction: Direction,
  rects: ReadonlyMap<string, Rect>,
): string | null {
  const origin = rects.get(fromId);

  if (origin === undefined) return null;

  const from = center(origin);
  let best: { id: string; score: number } | null = null;

  for (const [id, rect] of rects) {
    if (id === fromId) continue;

    const to = center(rect);
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    const primary =
      direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;

    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);

    if (primary <= 0) continue;

    const score = primary + secondary * 2 + (secondary > primary * 2 ? 100_000 : 0);

    if (best === null || score < best.score) best = { id, score };
  }

  return best?.id ?? null;
}

export function outlineOrder(
  initialStateId: string | null,
  stateIds: readonly string[],
  edges: readonly { from: string; to: string | null; priority: number }[],
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  const known = new Set(stateIds);

  if (initialStateId !== null && known.has(initialStateId)) queue.push(initialStateId);

  const outgoing = (id: string) =>
    edges
      .filter((edge) => edge.from === id && edge.to !== null)
      .sort((a, b) => a.priority - b.priority)
      .flatMap((edge) => (edge.to === null ? [] : [edge.to]));

  const drain = () => {
    while (queue.length > 0) {
      const id = queue.shift();

      if (id === undefined || seen.has(id) || !known.has(id)) continue;

      seen.add(id);
      order.push(id);
      queue.push(...outgoing(id));
    }
  };

  drain();

  for (const id of stateIds) {
    if (!seen.has(id)) {
      queue.push(id);
      drain();
    }
  }

  return order;
}
