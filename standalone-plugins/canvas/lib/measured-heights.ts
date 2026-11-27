import { z } from "zod";

export interface MeasuredHeight {
  height: number;
  key: string;
}

export type MeasuredHeights = ReadonlyMap<string, MeasuredHeight>;

const storagePrefix = "canvas.heights.v1.";

const storedHeights = z.record(
  z.string(),
  z.tuple([z.number().finite().nonnegative(), z.string().max(400)]),
);

const boards = new Map<string, MeasuredHeights>();

const unsaved = new Set<string>();

let saveTimer: ReturnType<typeof setTimeout> | undefined;

let listening = false;

function read(boardId: string): MeasuredHeights {
  try {
    const parsed = storedHeights.safeParse(
      JSON.parse(localStorage.getItem(storagePrefix + boardId) ?? "null"),
    );

    if (parsed.success)
      return new Map(
        Object.entries(parsed.data).map(([id, [height, key]]) => [id, { height, key }]),
      );
  } catch {}

  return new Map();
}

export function rememberedHeights(boardId: string): MeasuredHeights {
  const known = boards.get(boardId);

  if (known !== undefined) return known;

  const stored = read(boardId);

  boards.set(boardId, stored);

  return stored;
}

export function flushRememberedHeights(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;

  for (const boardId of unsaved) {
    const heights = boards.get(boardId);

    if (heights === undefined) continue;

    try {
      localStorage.setItem(
        storagePrefix + boardId,
        JSON.stringify(
          Object.fromEntries([...heights].map(([id, entry]) => [id, [entry.height, entry.key]])),
        ),
      );
    } catch {}
  }

  unsaved.clear();
}

export function rememberHeights(boardId: string, heights: MeasuredHeights): void {
  if (boards.get(boardId) === heights) return;
  boards.set(boardId, heights);
  unsaved.add(boardId);

  if (!listening && typeof window !== "undefined") {
    window.addEventListener("pagehide", flushRememberedHeights);
    listening = true;
  }

  if (saveTimer === undefined) saveTimer = setTimeout(flushRememberedHeights, 500);
}
