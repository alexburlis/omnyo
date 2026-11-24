// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitActivity,
  GitActivityCommit,
  GitActivityPush,
} from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import { TurnGitPill } from "./TurnGitPill";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sha(prefix: string): string {
  return prefix.padEnd(40, "0");
}

function commit(
  args: Pick<GitActivityCommit, "sha" | "subject"> & Partial<GitActivityCommit>,
): GitActivityCommit {
  return {
    kind: "commit",
    branch: "main",
    replacedSha: null,
    committedAt: 1_000,
    remoteRefs: [],
    ...args,
  };
}

const mainPush: GitActivityPush = {
  remote: "origin",
  branch: "main",
  oldSha: sha("0123456"),
  newSha: sha("def5678"),
  forced: false,
  pushedAt: 2_000,
  commitCount: 2,
};

const remotes = [
  { name: "origin", url: "git@github.com:example/omnyo.git" },
];

const pushedCommits = [
  commit({
    sha: sha("abc1234"),
    subject: "Fix the flaky checkout test",
    remoteRefs: ["origin/main"],
  }),
  commit({
    sha: sha("def5678"),
    subject: "Add a regression test",
    remoteRefs: ["origin/main"],
  }),
];

const pushedActivity: GitActivity = {
  commits: pushedCommits,
  pushes: [mainPush],
  remotes,
};

const partlyPushedActivity: GitActivity = {
  commits: [
    ...pushedCommits,
    commit({ sha: sha("aaa1111"), subject: "Local only", branch: "feat" }),
  ],
  pushes: [mainPush],
  remotes,
};

function gitPill(): HTMLElement {
  return screen.getByRole("button", { name: /^Git: / });
}

describe("TurnGitPill", () => {
  it.each([
    {
      label: "all commits pushed",
      activity: pushedActivity,
      name: "Git: 2 commits on main, pushed to main (example/omnyo)",
      text: "2 commits·main",
    },
    {
      label: "no commit pushed",
      activity: {
        commits: [
          commit({ sha: sha("aaa1111"), subject: "WIP", branch: "feat" }),
        ],
        pushes: [],
        remotes,
      },
      name: "Git: 1 commit on feat, not pushed",
      text: "1 commit on feat·Not pushed",
    },
    {
      label: "some commits pushed",
      activity: partlyPushedActivity,
      name: "Git: 3 commits, 2 pushed to main (example/omnyo), 1 not pushed",
      text: "3 commits·main·1 not pushed",
    },
    {
      label: "a push to two branches without new commits",
      activity: {
        commits: [],
        pushes: [
          { ...mainPush, commitCount: 1 },
          { ...mainPush, branch: "release", commitCount: 2 },
        ],
        remotes,
      },
      name: "Git: pushed 3 commits to main, release (example/omnyo)",
      text: "Pushed to 2 branches",
    },
  ] satisfies Array<{
    label: string;
    activity: GitActivity;
    name: string;
    text: string;
  }>)("summarizes $label", ({ activity, name, text }) => {
    render(<TurnGitPill activity={activity} />);

    expect(screen.getByRole("button", { name }).textContent).toBe(text);
  });

  it("renders nothing for a turn without commits or pushes", () => {
    const { container } = render(
      <TurnGitPill activity={{ commits: [], pushes: [], remotes: [] }} />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("lists commits and pushes and links only pushed GitHub commits", () => {
    const onOpenLink = vi.fn(() => true);

    render(
      <TurnGitPill activity={partlyPushedActivity} onOpenLink={onOpenLink} />,
    );
    fireEvent.click(gitPill());

    expect(screen.getByText("Local only")).toBeTruthy();
    expect(screen.getByText("0123456..def5678")).toBeTruthy();

    const links = screen.getAllByRole("link", {
      name: "Open commit on GitHub",
    });

    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `https://github.com/example/omnyo/commit/${sha("abc1234")}`,
      `https://github.com/example/omnyo/commit/${sha("def5678")}`,
    ]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noreferrer");

    const [firstLink] = links;

    if (!firstLink) throw new Error("Expected a commit link");
    expect(fireEvent.click(firstLink)).toBe(false);
    expect(onOpenLink).toHaveBeenCalledWith({
      href: `https://github.com/example/omnyo/commit/${sha("abc1234")}`,
    });
  });

  it("copies the full commit SHA from a commit row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    render(<TurnGitPill activity={pushedActivity} />);
    fireEvent.click(gitPill());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fireEvent.click(
      screen.getByRole("button", { name: /Fix the flaky checkout test/ }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(sha("abc1234")));
  });
});

describe("TurnGitPill in the timeline", () => {
  function timelineRows(turnGit: GitActivity | null): TimelineRow[] {
    return [
      conversationRow({
        id: "assistant-final",
        role: "assistant",
        text: "Committed and pushed.",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        turnGit,
      }),
    ];
  }

  function timeline(rows: TimelineRow[]) {
    return (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThreadTimelineRows
            threadId="thr_git"
            timelineRows={rows}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it("shows the pill when git activity lands on an already rendered message", () => {
    const view = render(timeline(timelineRows(null)));

    expect(screen.queryByRole("button", { name: /^Git: / })).toBeNull();

    view.rerender(timeline(timelineRows(pushedActivity)));

    expect(gitPill().textContent).toBe("2 commits·main");
  });
});
