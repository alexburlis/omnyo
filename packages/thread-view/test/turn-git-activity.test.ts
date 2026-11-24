import { describe, expect, it } from "vitest";
import type {
  GitActivity,
  GitActivityCommit,
  GitActivityPush,
} from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  createTimelineEventFactory,
  decodeThreadEventRow,
  renderTimelineFixture,
  rowsOfKind,
  type TimelineEventFactory,
} from "./timeline-test-harness.js";
import { EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT } from "../src/accepted-client-request-context.js";
import {
  buildThreadTimelineFromEvents,
  createThreadTimelineProjectionCheckpoint,
  formatGitRefLabel,
  formatGitRemoteLabel,
  formatTurnGitActivitySentence,
  gitActivityCommitWebUrl,
  gitCommitWebUrl,
  materializeThreadTimelineProjectionCheckpoint,
  summarizeTurnGitActivity,
} from "../src/index.js";

type TimelineFixtureEvent = ReturnType<
  TimelineEventFactory[keyof TimelineEventFactory]
>;

type AssistantRow = Extract<
  TimelineRow,
  { kind: "conversation"; role: "assistant" }
>;

const GITHUB_ORIGIN = {
  name: "origin",
  url: "git@github.com:example/omnyo.git",
};

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

const pushedActivity: GitActivity = {
  commits: [
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
  ],
  pushes: [mainPush],
  remotes: [GITHUB_ORIGIN],
};

const unpushedActivity: GitActivity = {
  commits: [commit({ sha: sha("aaa1111"), subject: "WIP", branch: "feat" })],
  pushes: [],
  remotes: [GITHUB_ORIGIN],
};

function assistantTurnGitByText(
  rows: readonly TimelineRow[],
): Record<string, GitActivity | null> {
  return Object.fromEntries(
    rowsOfKind(rows, "conversation")
      .filter((row): row is AssistantRow => row.role === "assistant")
      .map((row) => [row.text, row.turnGit]),
  );
}

function render(
  events: TimelineFixtureEvent[],
  completedTurnDisplay: "collapse" | "flat" = "collapse",
) {
  return renderTimelineFixture({
    completedTurnDisplay,
    events,
    projectionOptions: { threadStatus: "idle", turnMessageDetail: "summary" },
  });
}

function committedTurnThenNextTurn(
  event: TimelineEventFactory,
  gitActivityEvents: (event: TimelineEventFactory) => TimelineFixtureEvent[],
): TimelineFixtureEvent[] {
  return [
    event.turnStarted(),
    event.assistantCompleted({ itemId: "a-1", text: "Committing now." }),
    event.commandCompleted({ itemId: "cmd-1", command: "git commit -m fix" }),
    event.assistantCompleted({ itemId: "a-2", text: "Committed." }),
    event.turnCompleted(),
    event.turnStarted({ turnId: "turn-2" }),
    event.assistantCompleted({
      itemId: "a-3",
      text: "Next answer.",
      turnId: "turn-2",
    }),
    ...gitActivityEvents(event),
    event.turnCompleted({ turnId: "turn-2" }),
  ];
}

describe("turn git activity projection", () => {
  it.each(["collapse", "flat"] as const)(
    "attaches late git activity to the final assistant row of its own turn (%s)",
    (completedTurnDisplay) => {
      const event = createTimelineEventFactory({ threadId: "thread-1" });

      const timeline = render(
        committedTurnThenNextTurn(event, (factory) => [
          factory.gitActivity({ turnId: "turn-1", activity: pushedActivity }),
        ]),
        completedTurnDisplay,
      );

      expect(assistantTurnGitByText(timeline.rows)).toEqual({
        "Committing now.": null,
        "Committed.": pushedActivity,
        "Next answer.": null,
      });
    },
  );

  it("adds no timeline row of its own", () => {
    const withActivity = render(
      committedTurnThenNextTurn(
        createTimelineEventFactory({ threadId: "thread-1" }),
        (factory) => [
          factory.gitActivity({ turnId: "turn-1", activity: pushedActivity }),
        ],
      ),
    );

    const withoutActivity = render(
      committedTurnThenNextTurn(
        createTimelineEventFactory({ threadId: "thread-1" }),
        () => [],
      ),
    );

    expect(withActivity.rows.map((row) => row.id)).toEqual(
      withoutActivity.rows.map((row) => row.id),
    );
  });

  it("uses the last git activity event for a turn", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });

    const timeline = render(
      committedTurnThenNextTurn(event, (factory) => [
        factory.gitActivity({ turnId: "turn-1", activity: unpushedActivity }),
        factory.gitActivity({ turnId: "turn-1", activity: pushedActivity }),
      ]),
    );

    expect(assistantTurnGitByText(timeline.rows)["Committed."]).toEqual(
      pushedActivity,
    );
  });

  it("ignores git activity for a turn outside the event set", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });

    const timeline = render(
      committedTurnThenNextTurn(event, (factory) => [
        factory.gitActivity({
          turnId: "turn-missing",
          activity: pushedActivity,
        }),
      ]),
    );

    expect(assistantTurnGitByText(timeline.rows)).toEqual({
      "Committing now.": null,
      "Committed.": null,
      "Next answer.": null,
    });
  });

  it("leaves a running turn without git activity", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });

    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted(),
        event.assistantCompleted({ itemId: "a-1", text: "Still working." }),
        event.gitActivity({ activity: pushedActivity }),
      ],
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "summary",
      },
    });

    expect(assistantTurnGitByText(timeline.rows)).toEqual({
      "Still working.": null,
    });
  });

  it("does not attach git activity when the turn ends on an error", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });

    const timeline = render([
      event.turnStarted(),
      event.assistantCompleted({ itemId: "a-1", text: "Pushing now." }),
      event.providerError({ message: "Provider crashed" }),
      event.turnCompleted({ status: "failed" }),
      event.gitActivity({ activity: pushedActivity }),
    ]);

    expect(assistantTurnGitByText(timeline.rows)).toEqual({
      "Pushing now.": null,
    });
  });

  it("drops commits that a later amend replaced", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const original = commit({ sha: sha("1111111"), subject: "First try" });

    const firstAmend = commit({
      sha: sha("2222222"),
      subject: "Second try",
      kind: "amend",
      replacedSha: original.sha,
    });

    const finalAmend = commit({
      sha: sha("3333333"),
      subject: "Final",
      kind: "amend",
      replacedSha: firstAmend.sha,
    });

    const unrelated = commit({ sha: sha("4444444"), subject: "Docs" });

    const timeline = render([
      event.turnStarted(),
      event.assistantCompleted({ itemId: "a-1", text: "Amended." }),
      event.turnCompleted(),
      event.gitActivity({
        activity: {
          commits: [original, firstAmend, unrelated, finalAmend],
          pushes: [],
          remotes: [],
        },
      }),
    ]);

    expect(
      assistantTurnGitByText(timeline.rows)["Amended."]?.commits.map(
        (entry) => entry.subject,
      ),
    ).toEqual(["Docs", "Final"]);
  });

  it("keeps git activity when the timeline is materialized from a checkpoint", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });

    const events = committedTurnThenNextTurn(event, (factory) => [
      factory.gitActivity({ turnId: "turn-1", activity: pushedActivity }),
    ]).map((row) => decodeThreadEventRow(row));

    const args = {
      acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
      contextWindowEvents: [],
      events,
      options: {
        completedTurnDisplay: "collapse" as const,
        includeDiagnosticOperations: false,
        includeNestedRows: true,
        isLatestPage: true,
        threadStatus: "idle" as const,
        threadName: "",
        workspaceRoot: null,
      },
    };

    const checkpoint = createThreadTimelineProjectionCheckpoint(args);

    expect(
      assistantTurnGitByText(
        materializeThreadTimelineProjectionCheckpoint(checkpoint, []).rows,
      ),
    ).toEqual(assistantTurnGitByText(buildThreadTimelineFromEvents(args).rows));
    expect(
      assistantTurnGitByText(
        materializeThreadTimelineProjectionCheckpoint(checkpoint, []).rows,
      )["Committed."],
    ).toEqual(pushedActivity);
  });
});

describe("turn git activity summary", () => {
  it.each([
    {
      label: "all commits pushed",
      activity: pushedActivity,
      state: "pushed",
      sentence: "2 commits on main, pushed to main (example/omnyo)",
    },
    {
      label: "no commit pushed",
      activity: unpushedActivity,
      state: "not-pushed",
      sentence: "1 commit on feat, not pushed",
    },
    {
      label: "some commits pushed",
      activity: {
        ...pushedActivity,
        commits: [
          ...pushedActivity.commits,
          commit({
            sha: sha("fff9999"),
            subject: "Local only",
            branch: "feat",
          }),
        ],
      },
      state: "partly-pushed",
      sentence: "3 commits, 2 pushed to main (example/omnyo), 1 not pushed",
    },
    {
      label: "push without new commits",
      activity: {
        commits: [],
        pushes: [{ ...mainPush, commitCount: 3 }],
        remotes: [{ name: "origin", url: "https://github.com/owner/repo.git" }],
      },
      state: "push-only",
      sentence: "pushed 3 commits to main (owner/repo)",
    },
    {
      label: "commits already on a remote without a recorded push",
      activity: {
        commits: [
          commit({
            sha: sha("abc1234"),
            subject: "Release",
            branch: "release",
            remoteRefs: ["team/fork/release"],
          }),
        ],
        pushes: [],
        remotes: [
          { name: "team", url: "git@github.com:team/other.git" },
          { name: "team/fork", url: "git@github.com:team/fork.git" },
        ],
      },
      state: "pushed",
      sentence: "1 commit on release, pushed to team/fork/release (team/fork)",
    },
    {
      label: "no git activity",
      activity: { commits: [], pushes: [], remotes: [] },
      state: "none",
      sentence: null,
    },
  ] satisfies Array<{
    label: string;
    activity: GitActivity;
    state: string;
    sentence: string | null;
  }>)("describes $label", ({ activity, state, sentence }) => {
    const summary = summarizeTurnGitActivity(activity);

    expect(summary.state).toBe(state);
    expect(formatTurnGitActivitySentence(summary)).toBe(sentence);
  });

  it("names branches by remote unless the remote is origin", () => {
    expect(formatGitRefLabel("origin", "main")).toBe("main");
    expect(formatGitRefLabel("upstream", "main")).toBe("upstream/main");
  });

  it.each([
    ["git@github.com:owner/repo.git", "owner/repo"],
    ["github.com:owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["https://github.com/owner/repo.git", "owner/repo"],
    ["ssh://git@host.example/owner/repo.git", "owner/repo"],
    ["https://user:secret@gitlab.com/group/sub/repo.git", "group/sub/repo"],
    ["/srv/git/remote.git", "remote"],
    ["file:///srv/git/remote.git", "remote"],
    ["not a url", "not a url"],
  ])("labels remote %s as %s", (url, label) => {
    expect(formatGitRemoteLabel(url)).toBe(label);
  });

  it.each([
    ["git@github.com:owner/repo.git", true],
    ["https://github.com/owner/repo", true],
    ["ssh://git@github.com/owner/repo.git", true],
    ["https://gitlab.com/owner/repo.git", false],
    ["git@github.com:owner/repo/extra.git", false],
    ["/srv/git/remote.git", false],
  ])("links commits for remote %s: %s", (url, linked) => {
    expect(gitCommitWebUrl(url, sha("abc1234"))).toBe(
      linked ? `https://github.com/owner/repo/commit/${sha("abc1234")}` : null,
    );
  });

  it("links a pushed commit through the remote that contains it", () => {
    const activity: GitActivity = {
      ...pushedActivity,
      remotes: [
        { name: "origin", url: "https://gitlab.com/owner/repo.git" },
        { name: "github", url: "git@github.com:owner/repo.git" },
      ],
    };

    const onGitHub = commit({
      sha: sha("abc1234"),
      subject: "Mirrored",
      remoteRefs: ["origin/main", "github/main"],
    });

    expect(gitActivityCommitWebUrl(activity, onGitHub)).toBe(
      `https://github.com/owner/repo/commit/${sha("abc1234")}`,
    );
    expect(
      gitActivityCommitWebUrl(activity, { ...onGitHub, remoteRefs: [] }),
    ).toBeNull();
    expect(
      gitActivityCommitWebUrl(activity, {
        ...onGitHub,
        remoteRefs: ["origin/main"],
      }),
    ).toBeNull();
  });
});
