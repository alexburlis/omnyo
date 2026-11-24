import { describe, expect, it } from "vitest";
import { githubEventResult, parseGithubEventKey } from "./inbox-events";

describe("GitHub events for Omnyo waits", () => {
  it("parses only the registered key shapes", () => {
    expect(parseGithubEventKey("github-pr:example/omnyo#17")).toEqual({
      kind: "pr",
      repo: "example/omnyo",
      number: 17,
    });
    expect(parseGithubEventKey("github-checks:a/b#2")?.kind).toBe("checks");
    expect(parseGithubEventKey("github-pr:a/b#0")).toBeNull();
    expect(parseGithubEventKey("github-pr:ab#3")).toBeNull();
  });

  it("fires a PR wait on merge or close, never while it is open", () => {
    const key = { kind: "pr" as const, repo: "a/b", number: 3 };
    const view = { mergedAt: null, statusCheckRollup: null };

    expect(githubEventResult(key, { ...view, state: "OPEN" })).toBeNull();
    expect(githubEventResult(key, { ...view, state: "MERGED" })).toBe(
      "a/b#3 merged.",
    );
    expect(githubEventResult(key, { ...view, state: "CLOSED" })).toBe(
      "a/b#3 closed without merging.",
    );
  });

  it("fires a checks wait once every check run and status has finished", () => {
    const key = { kind: "checks" as const, repo: "a/b", number: 3 };
    const open = { state: "OPEN" as const, mergedAt: null };

    expect(
      githubEventResult(key, { ...open, statusCheckRollup: [] }),
    ).toBeNull();
    expect(
      githubEventResult(key, {
        ...open,
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "IN_PROGRESS", conclusion: null },
        ],
      }),
    ).toBeNull();
    expect(
      githubEventResult(key, {
        ...open,
        statusCheckRollup: [
          { status: null, conclusion: null, state: "PENDING" },
        ],
      }),
    ).toBeNull();
    expect(
      githubEventResult(key, {
        ...open,
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "FAILURE" },
          { status: null, conclusion: null, state: "SUCCESS" },
        ],
      }),
    ).toBe("Checks finished on a/b#3: 2 passed, 1 failed.");
  });
});
