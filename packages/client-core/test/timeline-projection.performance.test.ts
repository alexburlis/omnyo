import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { TimelineRow, TimelineTurnRow } from "@omnyo/server-contract";
import {
  buildTimelineViewRows,
  createTimelineViewRowsCache,
} from "@omnyo/thread-view";
import { timelineRowsSignature } from "../src/timeline/timelineRowSignatures.js";

it.skipIf(!process.env.OMNYO_CLIENT_PROJECTION_MEASUREMENT_OUTPUT)(
  "measures immutable streamed timeline projection and render signatures against the full oracle",
  async () => {
    const output = process.env.OMNYO_CLIENT_PROJECTION_MEASUREMENT_OUTPUT;

    if (!output) throw new Error("Measurement output is required");

    const turns: TimelineTurnRow[] = Array.from({ length: 300 }, (_, turn) => ({
      id: `turn-${turn}`,
      threadId: "projection-fixture",
      turnId: `turn-${turn}`,
      sourceSeqStart: turn * 12,
      sourceSeqEnd: turn * 12 + 11,
      startedAt: turn,
      createdAt: turn,
      kind: "turn",
      status: "completed",
      summaryCount: 12,
      completedAt: turn + 1,
      children: Array.from({ length: 12 }, (_, child) => ({
        id: `message-${turn}-${child}`,
        threadId: "projection-fixture",
        turnId: `turn-${turn}`,
        sourceSeqStart: turn * 12 + child,
        sourceSeqEnd: turn * 12 + child,
        startedAt: turn,
        createdAt: turn,
        kind: "conversation",
        role: "assistant",
        messageSeq: turn * 12 + child,
        text: "Synthetic formatted message content. ".repeat(8),
        attachments: null,
        turnRequest: null,
        turnGit: null,
      })),
    }));

    const fixtureHash = createHash("sha256")
      .update(JSON.stringify(turns))
      .digest("hex");

    const cache = createTimelineViewRowsCache();
    timelineRowsSignature(buildTimelineViewRows(turns, { cache }));
    let rows: TimelineRow[] = turns;
    const samplesMs: number[] = [];

    for (let step = 0; step < 30; step++) {
      const last = turns[turns.length - 1]!;

      const children = last.children!.map((row, index) =>
        index === 11 && row.kind === "conversation"
          ? { ...row, text: row.text + " appended".repeat(step + 1) }
          : row,
      );

      rows = [
        ...turns.slice(0, -1),
        { ...last, children, sourceSeqEnd: last.sourceSeqEnd + step + 1 },
      ];
      const start = performance.now();
      const view = buildTimelineViewRows(rows, { cache });
      const signature = timelineRowsSignature(view);
      samplesMs.push(performance.now() - start);
      const oracle = buildTimelineViewRows(rows);
      expect(view).toEqual(oracle);
      expect(signature).toBe(timelineRowsSignature(oracle));
    }

    await writeFile(
      output,
      JSON.stringify(
        {
          fixtureHash,
          turns: 300,
          childrenPerTurn: 12,
          samplesMs,
          samples: samplesMs.length,
          oracle:
            "full uncached projection and render signature equal after every append",
          method:
            "elapsed projection plus signature, oracle outside timer; fixed immutable latest-turn updates",
        },
        null,
        2,
      ),
    );
  },
);
