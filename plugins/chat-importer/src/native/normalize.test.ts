import { describe, expect, it } from "vitest";
import { HISTORY_LIMITS, nativeHistoryTurnSchema } from "../host-contract.js";
import {
  contentDiff,
  diffDisplayPath,
  finalizeTurns,
  fitTurnsToBudget,
  hunksDiff,
  promptTitle,
  replacementHunk,
  truncateHeadTail,
  TurnAccumulator,
  withDiffHeader,
  type DraftItem,
} from "./normalize.js";

describe("text caps", () => {
  it("keeps the head and the tail of long output within the cap", () => {
    const output = `HEAD${"m".repeat(10_000)}TAIL`;
    const truncated = truncateHeadTail(output, 200);

    expect(truncated.length).toBeLessThanOrEqual(200);
    expect(truncated.startsWith("HEAD")).toBe(true);
    expect(truncated.endsWith("TAIL")).toBe(true);
    expect(truncated).toContain("characters omitted");
  });

  it("titles a prompt on a word boundary within 80 characters", () => {
    const title = promptTitle(
      "Please   refactor the sidebar drag handling so that split rows keep their order when the user drops them quickly",
    );

    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toMatch(/^Please refactor the sidebar drag handling/);
    expect(title.slice(0, -1).endsWith(" ")).toBe(false);
  });
});

describe("TurnAccumulator", () => {
  it("clamps timestamps to be non-decreasing and closes open turns", () => {
    const accumulator = new TurnAccumulator();

    accumulator.startTurn("first", 1000);
    accumulator.addItem(
      { type: "agentMessage", nativeId: "a", text: "one" },
      3000,
    );
    accumulator.startTurn("second", 2000);
    accumulator.addItem(
      { type: "agentMessage", nativeId: "b", text: "two" },
      1500,
    );
    accumulator.closeTurn("interrupted", null);

    expect(
      accumulator.turns.map(({ startedAt, completedAt, status }) => ({
        startedAt,
        completedAt,
        status,
      })),
    ).toEqual([
      { startedAt: 1000, completedAt: 3000, status: "completed" },
      { startedAt: 3000, completedAt: 3000, status: "interrupted" },
    ]);
  });
});

describe("finalizeTurns", () => {
  it("uses unique native ids, generates ids for duplicates and caps items per turn", () => {
    const items: DraftItem[] = Array.from(
      { length: HISTORY_LIMITS.itemsPerTurn + 5 },
      (_, index) => ({
        type: "agentMessage",
        nativeId: index % 2 === 0 ? "same" : `n-${index}`,
        text: `message ${index}`,
      }),
    );

    const [turn] = finalizeTurns([
      {
        startedAt: 1,
        completedAt: 2,
        status: "completed",
        userText: "go",
        items,
      },
    ]);

    expect(turn?.items).toHaveLength(HISTORY_LIMITS.itemsPerTurn);
    expect(turn?.items.at(-1)).toMatchObject({
      text: `message ${HISTORY_LIMITS.itemsPerTurn + 4}`,
    });
    const ids = turn?.items.map((item) => item.id) ?? [];

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "same")).toHaveLength(1);
    expect(ids.some((id) => id.startsWith("imp-0-"))).toBe(true);
    expect(nativeHistoryTurnSchema.safeParse(turn).success).toBe(true);
  });

  it("caps agent text, command output and tool fields", () => {
    const [turn] = finalizeTurns([
      {
        startedAt: 1,
        completedAt: 2,
        status: "completed",
        userText: "u".repeat(HISTORY_LIMITS.userTextChars + 10),
        items: [
          {
            type: "agentMessage",
            nativeId: null,
            text: "a".repeat(HISTORY_LIMITS.agentTextChars + 10),
          },
          {
            type: "commandExecution",
            nativeId: null,
            command: "ls",
            cwd: null,
            output: "o".repeat(HISTORY_LIMITS.commandOutputChars * 2),
            exitCode: 0,
            durationMs: 12.6,
          },
          {
            type: "toolCall",
            nativeId: null,
            tool: "Read",
            server: null,
            arguments: "x".repeat(HISTORY_LIMITS.toolArgumentsChars + 1),
            result: "r".repeat(HISTORY_LIMITS.toolResultChars + 1),
            error: null,
          },
        ],
      },
    ]);

    expect(nativeHistoryTurnSchema.parse(turn).items).toHaveLength(3);
    expect(turn?.items[1]).toMatchObject({ durationMs: 13 });
  });
});

describe("fitTurnsToBudget", () => {
  it("drops the oldest turns until the serialized result fits", () => {
    const turns = finalizeTurns(
      Array.from({ length: 10 }, (_, index) => ({
        startedAt: index,
        completedAt: index,
        status: "completed" as const,
        userText: `turn ${index} ${"p".repeat(1000)}`,
        items: [],
      })),
    );

    const fitted = fitTurnsToBudget(turns, { turns: [] }, 4500);

    expect(fitted.totalTurns).toBe(10);
    expect(fitted.omittedTurns).toBeGreaterThan(0);
    expect(fitted.turns.at(-1)?.userText).toMatch(/^turn 9 /);
    expect(fitted.turns).toHaveLength(10 - fitted.omittedTurns);
    expect(JSON.stringify({ turns: fitted.turns }).length).toBeLessThanOrEqual(
      4500,
    );
  });
});

describe("diffs", () => {
  it("builds unified diffs with headers", () => {
    expect(contentDiff("src/a.ts", "add", "one\ntwo\n")).toBe(
      "--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n",
    );
    expect(contentDiff("src/a.ts", "delete", "gone\n")).toBe(
      "--- a/src/a.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n",
    );
    expect(withDiffHeader("b.ts", "@@ -1 +1 @@\n-x\n+y\n")).toBe(
      "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n",
    );
    expect(hunksDiff("c.ts", [replacementHunk("old", "new\nlines")])).toBe(
      "--- a/c.ts\n+++ b/c.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+lines\n",
    );
  });

  it("shows paths relative to the working directory when inside it", () => {
    expect(diffDisplayPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(diffDisplayPath("/elsewhere/a.ts", "/repo")).toBe("elsewhere/a.ts");
  });
});
