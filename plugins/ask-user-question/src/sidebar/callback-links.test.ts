import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildLinkGraph,
  LINK_COLORS,
  traceLinks,
  type LinkWait,
} from "./callback-links";

const wait = (
  threadId: string,
  sourceThreadId: string | null,
  sourceState: LinkWait["sourceState"] = "working",
): LinkWait => ({
  threadId,
  sourceThreadId,
  sourceState,
  reason: `${threadId} needs ${sourceThreadId}`,
});

test("chains and fan-ins form one group keyed by their root", () => {
  const graph = buildLinkGraph([
    wait("thr_a", "thr_b"),
    wait("thr_b", "thr_c"),
    wait("thr_d", "thr_c"),
    wait("thr_x", "thr_y"),
  ]);

  assert.equal(graph.groups.length, 2);
  const chain = graph.groupOf.get("thr_a");
  assert.equal(chain?.key, "thr_c");
  assert.equal(graph.groupOf.get("thr_d"), chain);
  assert.deepEqual(Object.fromEntries(chain?.members ?? []), {
    thr_a: "waiting",
    thr_b: "both",
    thr_c: "source",
    thr_d: "waiting",
  });
  assert.notEqual(graph.groupOf.get("thr_x")?.color, chain?.color);
  assert.equal(graph.groupOf.has("thr_unrelated"), false);
});

test("a group keeps its colour while members join or leave", () => {
  const before = buildLinkGraph([
    wait("thr_a", "thr_root"),
    wait("thr_other", "thr_far"),
  ]);

  const after = buildLinkGraph([
    wait("thr_a", "thr_root"),
    wait("thr_b", "thr_a"),
    wait("thr_other", "thr_far"),
  ]);

  assert.equal(
    after.groupOf.get("thr_b")?.color,
    before.groupOf.get("thr_a")?.color,
  );
  assert.equal(
    after.groupOf.get("thr_other")?.color,
    before.groupOf.get("thr_other")?.color,
  );
});

test("distinct colours until the palette is exhausted", () => {
  const graph = buildLinkGraph(
    Array.from({ length: LINK_COLORS + 2 }, (_, index) =>
      wait(`thr_c${index}`, `thr_s${index}`),
    ),
  );

  const first = graph.groups.slice(0, LINK_COLORS).map((group) => group.color);
  assert.equal(new Set(first).size, LINK_COLORS);
  assert.ok(
    graph.groups.every(
      (group) => group.color >= 0 && group.color < LINK_COLORS,
    ),
  );
});

test("unverified legacy waits and self edges are not links", () => {
  const graph = buildLinkGraph([
    wait("thr_a", null, "unverified"),
    wait("thr_b", "thr_b"),
  ]);

  assert.equal(graph.groups.length, 0);
});

test("blocked sources are marked on their edge", () => {
  const graph = buildLinkGraph([
    wait("thr_a", "thr_b", "needs-input"),
    wait("thr_c", "thr_d", "waiting"),
  ]);

  assert.equal(graph.sourceOf.get("thr_a")?.blocked, true);
  assert.equal(graph.sourceOf.get("thr_c")?.blocked, false);
});

test("trace follows the whole upstream chain and every downstream waiter, not siblings", () => {
  const graph = buildLinkGraph([
    wait("thr_a", "thr_b"),
    wait("thr_b", "thr_c"),
    wait("thr_sibling", "thr_c"),
    wait("thr_z", "thr_a"),
  ]);

  const trace = traceLinks(graph, "thr_a");
  assert.deepEqual(Object.fromEntries(trace?.nodes ?? []), {
    thr_a: { relation: "self", depth: 0 },
    thr_b: { relation: "upstream", depth: 1 },
    thr_c: { relation: "upstream", depth: 2 },
    thr_z: { relation: "downstream", depth: 1 },
  });
  assert.deepEqual(
    trace?.edges.map((edge) => `${edge.consumer}->${edge.source}`),
    ["thr_a->thr_b", "thr_b->thr_c", "thr_z->thr_a"],
  );
});

test("a source sees everyone waiting on it", () => {
  const graph = buildLinkGraph([
    wait("thr_a", "thr_s"),
    wait("thr_b", "thr_s"),
    wait("thr_c", "thr_a"),
  ]);

  const trace = traceLinks(graph, "thr_s");
  assert.deepEqual(
    [...(trace?.nodes.keys() ?? [])],
    ["thr_s", "thr_a", "thr_b", "thr_c"],
  );
  assert.equal(trace?.nodes.get("thr_c")?.depth, 2);
  assert.equal(traceLinks(graph, "thr_none"), null);
});
