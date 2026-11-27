import { expect, it } from "vitest";
import type { Item } from "../app-logic";
import { compactAge, diffBarWidths, groupItems, triage } from "../launchpad";

function pull(fields: Partial<Item>): Item {
  return {
    repo: "acme/widgets",
    number: 1,
    kind: "pr",
    title: "Change",
    state: "OPEN",
    author: "octocat",
    labels: [],
    assignees: [],
    url: "https://github.com/acme/widgets/pull/1",
    body: "",
    updatedAt: "2026-11-20T00:00:00Z",
    ...fields,
  };
}

it.each([
  [{ pullReview: "draft", pullMerge: "CLEAN" }, "draft", "Draft"],
  [{ pullReview: "conflicts", baseRef: "main" }, "blocked", "Conflicts with main"],
  [{ pullMerge: "DIRTY" }, "blocked", "Conflicts with the base branch"],
  [{ checks: "failure", pullMerge: "CLEAN" }, "blocked", "Checks failing"],
  [{ pullMerge: "UNSTABLE", checks: "failure" }, "follow-up", "Optional checks failing"],
  [{ pullReview: "changes-requested", pullMerge: "BLOCKED" }, "follow-up", "Changes requested"],
  [
    { reviewers: [{ login: "OctoCat", state: "requested" }], pullMerge: "BLOCKED" },
    "needs-review",
    "Your review is requested",
  ],
  [{ pullReview: "review-required", pullMerge: "BLOCKED" }, "waiting", "Waiting for review"],
  [{ checks: "pending", pullMerge: "CLEAN" }, "waiting", "Checks running"],
  [{ pullMerge: "BEHIND", baseRef: "main" }, "blocked", "Behind main"],
  [{ pullMerge: "BLOCKED" }, "blocked", "Blocked by branch rules"],
  [{ pullReview: "approved", pullMerge: "CLEAN" }, "ready", "Approved"],
  [{ pullMerge: "HAS_HOOKS" }, "ready", "Ready to merge"],
  [{ pullMerge: "UNKNOWN" }, "unknown", "GitHub has not computed mergeability yet"],
  [{}, "unknown", "GitHub has not computed mergeability yet"],
  [{ state: "MERGED" }, "closed", "Merged"],
  [{ state: "CLOSED" }, "closed", "Closed"],
  [{ kind: "issue" }, "issues", "Opened by you"],
  [{ kind: "issue", assignees: ["octocat"] }, "issues", "Assigned to you"],
  [{ kind: "issue", state: "CLOSED" }, "closed", "Closed"],
] satisfies [Partial<Item>, string, string][])("triages %o into %s", (fields, group, reason) => {
  expect(triage(pull(fields), "octocat")).toEqual({ group, reason });
});

it("orders groups by attention and lists security updates first among ready pull requests", () => {
  const sections = groupItems(
    [
      pull({ number: 1, pullMerge: "CLEAN", updatedAt: "2026-11-22T00:00:00Z" }),
      pull({ number: 2, pullMerge: "BLOCKED", checks: "failure" }),
      pull({
        number: 3,
        pullMerge: "CLEAN",
        labels: ["dependency-security"],
        updatedAt: "2026-11-01T00:00:00Z",
      }),
      pull({ number: 4, kind: "issue" }),
    ],
    "octocat",
  );

  expect(
    sections.map((section) => [section.id, section.rows.map((row) => row.item.number)]),
  ).toEqual([
    ["ready", [3, 1]],
    ["blocked", [2]],
    ["issues", [4]],
  ]);
});

it("formats compact ages and square-root scaled diff bars", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");

  expect(compactAge("2026-11-23T11:59:30Z", now)).toBe("now");
  expect(compactAge("2026-11-23T11:15:00Z", now)).toBe("45m");
  expect(compactAge("2026-11-23T03:00:00Z", now)).toBe("9h");
  expect(compactAge("2026-11-01T12:00:00Z", now)).toBe("22d");
  expect(compactAge("2026-06-01T12:00:00Z", now)).toBe("5mo");
  expect(diffBarWidths(0, 0)).toEqual({ added: 0, removed: 0 });
  expect(diffBarWidths(1, 1)).toEqual({ added: 2, removed: 2 });
  expect(diffBarWidths(800, 800, 48)).toEqual({ added: 24, removed: 24 });
  expect(diffBarWidths(5000, 0, 48)).toEqual({ added: 48, removed: 0 });
});
