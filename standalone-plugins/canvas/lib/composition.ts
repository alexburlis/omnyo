import type { JsonValue } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  bentoColumns,
  compositionSchema,
  flowLeaves,
  isIsland,
  islandSchema,
  type Composition,
  type FlowGroup,
  type FlowItem,
  type FlowLeaf,
  type Island,
  type IslandGroup,
} from "../contract.ts";

export const islandGap = 56;

export const bentoGap = 20;

export const bentoTrack = 200;

export function islandGroups(root: FlowItem): IslandGroup[] {
  if ("node" in root) return [];

  return isIsland(root) ? [root] : root.children.flatMap(islandGroups);
}

export function containsIsland(item: FlowItem): boolean {
  return "flow" in item && (isIsland(item) || item.children.some(containsIsland));
}

export function lastLeaf(item: FlowItem): FlowLeaf | undefined {
  return "node" in item ? item : item.children.map(lastLeaf).findLast(Boolean);
}

export function defaultGap(group: FlowGroup): number {
  if (group.children.some(containsIsland)) return islandGap;

  return group.flow === "bento" ? bentoGap : 24;
}

export function bentoTracks(width: number, group: FlowGroup): number {
  const gap = group.gap ?? defaultGap(group);
  const fit = Math.floor((width + gap) / ((group.minWidth ?? bentoTrack) + gap));

  return Math.max(1, Math.min(group.columns ?? bentoColumns, fit));
}

export interface BentoSlot {
  index: number;
  track: number;
  span: number;
}

export interface BentoRow {
  slots: BentoSlot[];
  used: number;
}

export function packBento(spans: readonly number[], tracks: number): BentoRow[] {
  const rows: BentoRow[] = [];
  let current: BentoRow = { slots: [], used: 0 };

  function close() {
    const last = current.slots.at(-1);

    if (last === undefined) return;
    rows.push({
      slots: [...current.slots.slice(0, -1), { ...last, span: last.span + tracks - current.used }],
      used: current.used,
    });
  }

  for (const [index, requested] of spans.entries()) {
    const span = Math.max(1, Math.min(tracks, requested));

    if (current.used + span > tracks) {
      close();
      current = { slots: [], used: 0 };
    }

    current.slots.push({ index, track: current.used, span });
    current.used += span;
  }

  close();

  return rows;
}

const placeholderSchema = z.object({ island: z.string() }).strict();

const looseGroupSchema = z.looseObject({ flow: z.string(), children: z.array(z.json()) });

export interface Decomposition {
  skeleton: JsonValue;
  islands: Map<string, JsonValue>;
}

type JsonGroup = Omit<FlowGroup, "children"> & { children: JsonValue[] };

function json(value: FlowItem | JsonGroup): JsonValue {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

const jsonListSchema = z.array(z.json());

const jsonRecordSchema = z.record(z.string(), z.json());

export function decompose(composition: Composition | null): Decomposition {
  const islands = new Map<string, JsonValue>();

  if (composition === null) return { skeleton: null, islands };

  function visit(item: FlowItem): JsonValue {
    if (isIsland(item)) {
      islands.set(item.id, json(item));

      return { island: item.id };
    }

    if ("node" in item) return json(item);

    return json({ ...item, children: item.children.map(visit) });
  }

  return { skeleton: { width: composition.width, root: visit(composition.root) }, islands };
}

export function placeholderIds(skeleton: JsonValue): Set<string> {
  const ids = new Set<string>();

  function visit(item: JsonValue) {
    const placeholder = placeholderSchema.safeParse(item);

    const list = jsonListSchema.safeParse(item);
    const record = jsonRecordSchema.safeParse(item);

    if (placeholder.success) ids.add(placeholder.data.island);
    else if (list.success) list.data.forEach(visit);
    else if (record.success) Object.values(record.data).forEach(visit);
  }

  visit(skeleton);

  return ids;
}

export function assemble(
  skeleton: JsonValue,
  islands: ReadonlyMap<string, JsonValue>,
): Composition | null {
  if (skeleton === null) return null;

  const frame = z.object({ width: z.number(), root: z.json() }).parse(skeleton);

  function visit(item: JsonValue): JsonValue | null {
    const placeholder = placeholderSchema.safeParse(item);

    if (placeholder.success) return islands.get(placeholder.data.island) ?? null;
    const group = looseGroupSchema.safeParse(item);

    if (!group.success) return item;

    const children = group.data.children.flatMap((child) => {
      const value = visit(child);

      return value === null ? [] : [value];
    });

    return children.length === 0
      ? null
      : z.json().parse(JSON.parse(JSON.stringify({ ...group.data, children })));
  }

  const root = visit(frame.root);

  return root === null ? null : compositionSchema.parse({ width: frame.width, root });
}

export interface IslandPlacement {
  composition: Composition;
  pulled: { node: string; from: string }[];
  dropped: string[];
  inserted: boolean;
}

function groupLabel(group: FlowGroup): string {
  return group.island?.title ?? group.id ?? `${group.flow} group`;
}

function findGroup(item: FlowItem, id: string): FlowGroup | undefined {
  if ("node" in item) return undefined;

  if (item.id === id) return item;

  for (const child of item.children) {
    const found = findGroup(child, id);

    if (found) return found;
  }

  return undefined;
}

export function placeIsland(
  current: Composition | null,
  island: IslandGroup,
  after?: string,
): IslandPlacement {
  if (current === null) {
    if (after !== undefined) throw new Error(`No group or island has id ${after}`);

    return {
      composition: { width: 1400, root: { flow: "column", children: [island] } },
      pulled: [],
      dropped: [],
      inserted: true,
    };
  }

  const existing = findGroup(current.root, island.id);

  if (existing !== undefined && !isIsland(existing))
    throw new Error(`The id ${island.id} belongs to a plain group; choose another island id`);
  const replacing = existing !== undefined;

  if (!replacing && after !== undefined && findGroup(current.root, after) === undefined)
    throw new Error(`No group or island has id ${after}`);
  const appending = !replacing && (after === undefined || after === current.root.id);
  const incoming = new Set(flowLeaves(island).map((leaf) => leaf.node));
  const pulled: IslandPlacement["pulled"] = [];
  const dropped: string[] = [];

  function visit(item: FlowItem, owner: string): FlowItem | null {
    if ("node" in item) {
      if (!incoming.has(item.node)) return item;
      pulled.push({ node: item.node, from: owner });

      return null;
    }

    if (replacing && item.id === island.id) return island;

    const children = item.children.flatMap((child) => {
      const next = visit(child, isIsland(child) ? `island “${child.island.title}”` : owner);
      const kept = next === null ? [] : [next];

      return !replacing && !appending && "flow" in child && child.id === after
        ? [...kept, island]
        : kept;
    });

    if (children.length === 0) {
      dropped.push(groupLabel(item));

      return null;
    }

    return { ...item, children };
  }

  const root = visit(current.root, "the flow");
  const base = root === null || "node" in root ? { flow: "column" as const, children: [] } : root;

  return {
    composition: {
      ...current,
      root:
        appending || base.children.length === 0
          ? { ...base, children: [...base.children, island] }
          : base,
    },
    pulled,
    dropped,
    inserted: !replacing,
  };
}

function patched<Key extends keyof Island>(
  island: Island,
  key: Key,
  value: Island[Key] | null | undefined,
): Island {
  if (value === undefined) return island;

  if (value !== null) return { ...island, [key]: value };
  const copy = { ...island };

  delete copy[key];

  return copy;
}

export function updateIsland(
  composition: Composition,
  id: string,
  patch: { [Key in keyof Island]?: Island[Key] | null },
): Composition {
  function visit(item: FlowItem): FlowItem {
    if ("node" in item) return item;

    if (isIsland(item) && item.id === id) {
      let island = item.island;

      island = patched(island, "title", patch.title);
      island = patched(island, "question", patch.question);
      island = patched(island, "accent", patch.accent);
      island = patched(island, "surface", patch.surface);
      island = patched(island, "offset", patch.offset);

      return { ...item, island: islandSchema.parse(island) };
    }

    return { ...item, children: item.children.map(visit) };
  }

  const root = visit(composition.root);

  return "node" in root ? composition : { ...composition, root };
}

const maxNotes = 12;

export function compositionNotes(composition: Composition): string[] {
  const notes: string[] = [];
  const islands = islandGroups(composition.root);

  for (const island of islands) {
    const leaves = flowLeaves(island);
    const title = `island “${island.island.title}”`;

    if (leaves.length === 1)
      notes.push(
        `The ${title} holds one module. Merge it into a related island or drop the island wrapper.`,
      );

    if (leaves.length > 12)
      notes.push(
        `The ${title} holds ${leaves.length} modules. Split it by question so each island answers one thing.`,
      );

    if (island.island.question === undefined)
      notes.push(`Give the ${title} a question so readers know what it answers.`);

    const leads = leaves.filter((leaf) => leaf.emphasis === "lead").length;

    if (leads > 1) notes.push(`The ${title} has ${leads} lead modules. Keep one lead per island.`);
  }

  if (islands.length > 8)
    notes.push(
      `${islands.length} islands compete for attention. Merge related questions; three to six islands read best.`,
    );

  function visit(item: FlowItem, insideIsland: boolean) {
    if ("node" in item) return;

    if (item.flow === "bento") {
      const columns = item.columns ?? bentoColumns;

      const rows = packBento(
        item.children.map((child) => child.span ?? 1),
        columns,
      );

      for (const [index, row] of rows.entries())
        if (row.used < columns)
          notes.push(
            `In ${groupLabel(item)}, row ${index + 1} fills ${row.used} of ${columns} columns, so its last module stretches. Adjust spans to choose the fill.`,
          );
    }

    const accents = new Map<string, string>();

    for (const child of item.children)
      if (
        isIsland(child) &&
        child.island.accent !== undefined &&
        child.island.accent !== "neutral"
      ) {
        const previous = accents.get(child.island.accent);

        if (previous !== undefined)
          notes.push(
            `Islands “${previous}” and “${child.island.title}” share the ${child.island.accent} accent. Give each area its own accent or use neutral.`,
          );
        else accents.set(child.island.accent, child.island.title);
      }

    for (const child of item.children) visit(child, insideIsland || isIsland(item));
  }

  visit(composition.root, false);

  const boardLeads =
    flowLeaves(composition.root).filter((leaf) => leaf.emphasis === "lead").length -
    islands.reduce(
      (sum, island) => sum + flowLeaves(island).filter((leaf) => leaf.emphasis === "lead").length,
      0,
    );

  if (boardLeads > 1)
    notes.push(`Use one board-level lead; ${boardLeads} modules outside islands are marked lead.`);

  return notes.slice(0, maxNotes);
}
