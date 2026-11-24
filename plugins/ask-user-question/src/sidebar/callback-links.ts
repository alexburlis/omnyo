import type { CallbackWaitView } from "./callback-waits";

export type LinkWait = Pick<
  CallbackWaitView,
  "threadId" | "sourceThreadId" | "sourceState" | "reason"
>;

export type LinkRole = "waiting" | "source" | "both";

export type LinkEdge = {
  consumer: string;
  source: string;
  sourceState: CallbackWaitView["sourceState"];
  blocked: boolean;
  reason: string;
};

export type LinkGroup = {
  key: string;
  color: number;
  members: ReadonlyMap<string, LinkRole>;
};

export type LinkGraph = {
  groups: readonly LinkGroup[];
  groupOf: ReadonlyMap<string, LinkGroup>;
  sourceOf: ReadonlyMap<string, LinkEdge>;
  consumersOf: ReadonlyMap<string, readonly LinkEdge[]>;
};

export const LINK_COLORS = 6;

export const EMPTY_LINK_GRAPH: LinkGraph = {
  groups: [],
  groupOf: new Map(),
  sourceOf: new Map(),
  consumersOf: new Map(),
};

function hash(text: string): number {
  let value = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }

  return value >>> 0;
}

export function buildLinkGraph(waits: readonly LinkWait[]): LinkGraph {
  const sourceOf = new Map<string, LinkEdge>();
  const consumersOf = new Map<string, LinkEdge[]>();

  for (const wait of waits) {
    if (wait.sourceThreadId === null || wait.sourceThreadId === wait.threadId)
      continue;

    const edge: LinkEdge = {
      consumer: wait.threadId,
      source: wait.sourceThreadId,
      sourceState: wait.sourceState,
      blocked: wait.sourceState !== "working" && wait.sourceState !== "waiting",
      reason: wait.reason,
    };

    sourceOf.set(edge.consumer, edge);
    const list = consumersOf.get(edge.source) ?? [];
    list.push(edge);
    consumersOf.set(edge.source, list);
  }

  if (sourceOf.size === 0) return EMPTY_LINK_GRAPH;

  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let current = id;

    for (;;) {
      const next = sourceOf.get(current);

      if (next === undefined || seen.has(next.source)) return current;
      seen.add(current);
      current = next.source;
    }
  };

  const byRoot = new Map<string, Map<string, LinkRole>>();
  const nodes = new Set<string>([...sourceOf.keys(), ...consumersOf.keys()]);

  for (const id of nodes) {
    const root = rootOf(id);
    const members = byRoot.get(root) ?? new Map<string, LinkRole>();
    const waiting = sourceOf.has(id);
    const owing = consumersOf.has(id);
    members.set(id, waiting && owing ? "both" : waiting ? "waiting" : "source");
    byRoot.set(root, members);
  }

  const keys = [...byRoot.keys()].sort();
  const taken = new Set<number>();
  const groups: LinkGroup[] = [];
  const groupOf = new Map<string, LinkGroup>();

  for (const key of keys) {
    const preferred = hash(key) % LINK_COLORS;
    let color = preferred;

    if (taken.size < LINK_COLORS) {
      while (taken.has(color)) color = (color + 1) % LINK_COLORS;
    }

    taken.add(color);
    const members = byRoot.get(key) ?? new Map<string, LinkRole>();
    const group: LinkGroup = { key, color, members };
    groups.push(group);

    for (const id of members.keys()) groupOf.set(id, group);
  }

  return { groups, groupOf, sourceOf, consumersOf };
}

export type LinkRelation = "self" | "upstream" | "downstream";

export type LinkTrace = {
  nodes: ReadonlyMap<
    string,
    {
      relation: LinkRelation;
      depth: number;
    }
  >;
  edges: readonly LinkEdge[];
};

export function traceLinks(graph: LinkGraph, id: string): LinkTrace | null {
  if (!graph.groupOf.has(id)) return null;

  const nodes = new Map<
    string,
    {
      relation: LinkRelation;
      depth: number;
    }
  >();

  const edges: LinkEdge[] = [];
  nodes.set(id, { relation: "self", depth: 0 });
  let current = id;

  for (let depth = 1; ; depth += 1) {
    const edge = graph.sourceOf.get(current);

    if (edge === undefined || nodes.has(edge.source)) break;
    nodes.set(edge.source, { relation: "upstream", depth });
    edges.push(edge);
    current = edge.source;
  }

  const queue: Array<{
    id: string;
    depth: number;
  }> = [{ id, depth: 0 }];

  while (queue.length > 0) {
    const next = queue.shift();

    if (next === undefined) break;

    for (const edge of graph.consumersOf.get(next.id) ?? []) {
      if (nodes.has(edge.consumer)) continue;
      nodes.set(edge.consumer, {
        relation: "downstream",
        depth: next.depth + 1,
      });
      edges.push(edge);
      queue.push({ id: edge.consumer, depth: next.depth + 1 });
    }
  }

  return { nodes, edges };
}
