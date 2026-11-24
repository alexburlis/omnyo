import { describe, expect, it } from "vitest";
import {
  dockCells,
  rankLauncherProjects,
  type RankableProject,
} from "./project-ranking";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const DAY_MS = 86_400_000;

type RankableThread = RankableProject["threads"][number];

function chat(daysAgo: number): RankableThread {
  return {
    parentThreadId: null,
    lastMessageAt: NOW - daysAgo * DAY_MS,
    createdAt: NOW - 60 * DAY_MS,
  };
}

function project(
  id: string,
  threads: readonly RankableThread[] = [],
): RankableProject {
  return { id, threads };
}

describe("rankLauncherProjects", () => {
  it("puts the projects with the most chats in the last 14 days first", () => {
    expect(
      rankLauncherProjects(
        [
          project("gameslike", [chat(1)]),
          project("omnyo-private", [chat(1), chat(2), chat(3)]),
          project("paraspeech", [chat(5), chat(6)]),
        ],
        NOW,
      ),
    ).toEqual(["omnyo-private", "paraspeech", "gameslike"]);
  });

  it("counts only top-level chats from the window, dated by their last message or else their creation", () => {
    expect(
      rankLauncherProjects(
        [
          project("omnyo-private", [
            { ...chat(1), parentThreadId: "thr_parent" },
            { ...chat(1), parentThreadId: "thr_parent" },
            chat(15),
            chat(40),
          ]),
          project("sledge", [
            {
              parentThreadId: null,
              lastMessageAt: null,
              createdAt: NOW - 2 * DAY_MS,
            },
          ]),
          project("Stratoclash", [chat(13)]),
        ],
        NOW,
      ),
    ).toEqual(["sledge", "Stratoclash", "omnyo-private"]);
  });

  it("breaks a tie by the most recent chat, then by sidebar order", () => {
    expect(
      rankLauncherProjects(
        [
          project("glassyui", [chat(3), chat(4)]),
          project("hardware", [chat(1), chat(9)]),
          project("mailwerk", [chat(1), chat(2)]),
        ],
        NOW,
      ),
    ).toEqual(["hardware", "mailwerk", "glassyui"]);
  });

  it("fills the rest with quiet projects in sidebar order", () => {
    expect(
      rankLauncherProjects(
        [
          project("alexos-prod"),
          project("prim", [chat(20)]),
          project("Stratoclash", [chat(2)]),
          project("live-cargo"),
          project("omnyo-private", [chat(1)]),
          project("codewert-landing"),
        ],
        NOW,
      ),
    ).toEqual([
      "omnyo-private",
      "Stratoclash",
      "alexos-prod",
      "prim",
      "live-cargo",
      "codewert-landing",
    ]);
  });
});

describe("dockCells", () => {
  const ranked = [
    "omnyo-private",
    "paraspeech",
    "sledge",
    "gameslike",
    "glassyui",
    "Stratoclash",
    "prim",
  ];

  it("shows the first five ranked projects, with nothing extra on More while the pick has a cell", () => {
    expect(dockCells(ranked, "sledge")).toEqual({
      cells: ["omnyo-private", "paraspeech", "sledge", "gameslike", "glassyui"],
      moreShows: null,
    });
  });

  it("keeps the five cells and shows a pick beyond them on More", () => {
    expect(dockCells(ranked, "Stratoclash")).toEqual({
      cells: ["omnyo-private", "paraspeech", "sledge", "gameslike", "glassyui"],
      moreShows: { kind: "project", projectId: "Stratoclash" },
    });
  });

  it("shows No project on More", () => {
    expect(dockCells(ranked, null).moreShows).toEqual({ kind: "no-project" });
  });

  it("shows one cell per project when there are fewer than five", () => {
    expect(dockCells(["omnyo-private", "prim"], "prim")).toEqual({
      cells: ["omnyo-private", "prim"],
      moreShows: null,
    });
  });
});
