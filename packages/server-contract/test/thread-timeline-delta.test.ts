import { describe, expect, it } from "vitest";
import {
  applyTimelineDelta,
  computeTimelineRowDelta,
  timelineDeltaSchema,
  timelineRowSchema,
  type TimelineRow,
} from "../src/thread-timeline.js";

function row(id: string, sourceSeqStart: number, title = "t"): TimelineRow {
  return {
    id,
    kind: "system",
    threadId: "thr_x",
    turnId: null,
    sourceSeqStart,
    sourceSeqEnd: sourceSeqStart,
    startedAt: 0,
    createdAt: 0,
    systemKind: "debug",
    title,
    detail: null,
    status: null,
  };
}

describe("timeline delta", () => {
  it("applies a suffix only to the exact delivered base and transmits current metadata", () => {
    const before: TimelineRow = {
      id: "assistant-1",
      kind: "conversation",
      role: "assistant",
      threadId: "thr_x",
      turnId: "turn-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
      startedAt: 1,
      createdAt: 2,
      messageSeq: 2,
      text: "first\n",
      attachments: null,
      turnRequest: null,
      turnGit: null,
    };

    const delta = timelineDeltaSchema.parse({
      baseRevision: "delivered-base",
      upsertRows: [],
      assistantTextAppends: [
        {
          rowId: before.id,
          baseSourceSeqEnd: 2,
          sourceSeqEnd: 3,
          createdAt: 3,
          messageSeq: 3,
          appendText: "next\n",
        },
      ],
    });

    expect(applyTimelineDelta([before], delta, "delivered-base")).toEqual([
      {
        ...before,
        sourceSeqEnd: 3,
        createdAt: 3,
        messageSeq: 3,
        text: "first\nnext\n",
      },
    ]);
    expect(applyTimelineDelta([before], delta, "different-base")).toBeNull();
    expect(
      applyTimelineDelta(
        [{ ...before, sourceSeqEnd: 9 }],
        delta,
        "delivered-base",
      ),
    ).toBeNull();
    expect(applyTimelineDelta([], delta, "delivered-base")).toBeNull();
    expect(before.text).toBe("first\n");
  });

  it("upserts an assistant row when its turn git activity lands after the text", () => {
    const before: TimelineRow = {
      id: "assistant-1",
      kind: "conversation",
      role: "assistant",
      threadId: "thr_x",
      turnId: "turn-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
      startedAt: 1,
      createdAt: 2,
      messageSeq: 2,
      text: "Committed.",
      attachments: null,
      turnRequest: null,
      turnGit: null,
    };

    const after: TimelineRow = {
      ...before,
      turnGit: {
        commits: [
          {
            sha: "abc1234".padEnd(40, "0"),
            subject: "Fix the flaky test",
            kind: "commit",
            branch: "main",
            replacedSha: null,
            committedAt: 1,
            remoteRefs: [],
          },
        ],
        pushes: [],
        remotes: [],
      },
    };

    const delta = computeTimelineRowDelta([before], [after], {
      baseRevision: "delivered-base",
    });

    expect(delta.upsertRows).toEqual([after]);
    expect(delta.assistantTextAppends).toBeUndefined();
    expect(applyTimelineDelta([before], delta, "delivered-base")).toEqual([
      after,
    ]);
  });

  it("reads an assistant row from a server without turn git activity", () => {
    expect(
      timelineRowSchema.parse({
        id: "assistant-1",
        kind: "conversation",
        role: "assistant",
        threadId: "thr_x",
        turnId: "turn-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 2,
        startedAt: 1,
        createdAt: 2,
        messageSeq: 2,
        text: "Done.",
        attachments: null,
        turnRequest: null,
      }),
    ).toMatchObject({ role: "assistant", turnGit: null });
  });

  it("round-trips an upsert + insert (compute then apply equals current)", () => {
    const prev = [row("a", 1), row("b", 2)];
    const current = [row("a", 1), row("b", 2, "changed"), row("c", 3)];
    const delta = computeTimelineRowDelta(prev, current);
    expect(delta.upsertRows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(applyTimelineDelta(prev, delta)).toEqual(current);
  });

  it("round-trips a removal (collapse/eviction)", () => {
    const prev = [row("a", 1), row("b", 2), row("c", 3)];
    const current = [row("a", 1), row("c", 3)];
    const delta = computeTimelineRowDelta(prev, current);
    expect(delta.upsertRows).toHaveLength(0);
    expect(applyTimelineDelta(prev, delta)).toEqual(current);
  });

  it("preserves unchanged row identity (no needless re-render)", () => {
    const a = row("a", 1);
    const prev = [a, row("b", 2)];
    const current = [a, row("b", 2, "changed")];

    const merged = applyTimelineDelta(
      prev,
      computeTimelineRowDelta(prev, current),
    );

    expect(merged?.[0]).toBe(a);
  });

  it("omits row order when membership and ordering are unchanged", () => {
    const prev = [row("a", 1), row("b", 2)];
    const current = [row("a", 1), row("b", 2, "changed")];

    const delta = computeTimelineRowDelta(prev, current);

    expect(delta.rowOrder).toBeUndefined();
    expect(applyTimelineDelta(prev, delta)).toEqual(current);
  });

  it("returns null when the base is stale (id neither held nor sent)", () => {
    expect(
      applyTimelineDelta([row("a", 1)], {
        upsertRows: [],
        rowOrder: ["a", "z"],
      }),
    ).toBeNull();
  });
});
