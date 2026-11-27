import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { age, createdLabel, rowLine, rowSummary, upcomingDay, upcomingLabel } from "../lib/feed.ts";
import { buildTree, hasFamilyActivity, type ChatNode } from "../lib/grouping.ts";
import { chat, work } from "./work-fixtures.ts";

function node(
  label: Parameters<typeof work>[0],
  change: Parameters<typeof work>[1] = {},
): ChatNode {
  const tree = buildTree([chat("one", label, { work: work(label, change) })]);
  const found = tree.nodes.get("one");
  assert.ok(found);

  return found;
}

describe("shared work presentation", () => {
  it("uses the recorded primary label and explanation", () => {
    assert.deepEqual(rowLine(node("blocked")), {
      verb: "Blocked",
      reason: "Recorded blocked reason",
    });
    assert.deepEqual(rowLine(node("waiting")), {
      verb: "Waiting",
      reason: "Recorded waiting reason",
    });
    assert.deepEqual(rowLine(node("ready-to-archive")), {
      verb: "Ready to archive",
      reason: "Recorded ready-to-archive reason",
    });
  });

  it("says what an External chat is awaiting", () => {
    assert.deepEqual(rowLine(node("external")), {
      verb: "Awaiting",
      reason: "App Store review",
    });

    const unnamed = node("external", {
      assessment: { ...work("external").assessment, waitingOn: null },
    });

    assert.deepEqual(rowLine(unnamed), { verb: "Awaiting", reason: "Recorded external reason" });
  });

  it("keeps the family badge and explanation on the same supplied work summary", () => {
    const tree = buildTree([
      chat("root", "ready-to-archive"),
      chat("scope", "needs-you", { parentThreadId: "root", displayTitle: "Release scope" }),
    ]);

    const root = tree.nodes.get("root");
    assert.ok(root);

    assert.equal(root.state, "need");
    assert.deepEqual(rowLine(root), {
      verb: "Needs you",
      reason: "Sub-chat Release scope: Recorded needs-you reason",
    });
    assert.equal(root.own, "done");
  });

  it("retains another child's advancing work alongside the family's required answer", () => {
    const tree = buildTree([
      chat("root", "ready-to-archive", { shelvedAt: 50, isUnread: true }),
      chat("scope", "needs-you", { parentThreadId: "root", displayTitle: "Release scope" }),
      chat("job", "working", {
        parentThreadId: "root",
        displayTitle: "Release job",
        work: work("working", {
          activity: [
            {
              id: "job",
              kind: "plugin",
              phase: "running",
              label: "Installing the release",
              actor: { kind: "agent", id: "producer", label: "Release producer" },
            },
          ],
        }),
      }),
    ]);

    const root = tree.shelf[0];
    assert.ok(root);

    assert.equal(root.own, "done");
    assert.equal(root.state, "need");
    assert.equal(root.thread.isUnread, true);
    assert.equal(root.thread.work?.postponement, null);
    assert.equal(rowLine(root).verb, "Needs you");
    assert.match(rowLine(root).reason ?? "", /Sub-chat Release scope: Recorded needs-you reason/u);
    assert.match(rowLine(root).reason ?? "", /Sub-chat Release job: Installing the release/u);
  });

  it("shows why a summary is unavailable without inventing work from runtime fields", () => {
    const item = node("open");
    item.thread.work = null;
    item.thread.status = "active";
    assert.deepEqual(rowLine(item), { verb: "Open", reason: "Work summary unavailable" });
  });

  it("preserves activity when a required answer takes primary priority", () => {
    const item = node("needs-you", {
      requiredInput: [{ id: "question", kind: "question", label: "Choose scope" }],
      activity: [
        {
          id: "job",
          kind: "plugin",
          label: "Release job running",
          phase: "running",
          actor: { kind: "agent", id: "owner", label: "Release job" },
        },
      ],
    });

    assert.equal(rowLine(item).verb, "Needs you");
    assert.match(rowLine(item).reason ?? "", /Release job running/u);
    assert.equal(item.thread.work?.requiredInput.length, 1);
  });

  it("surfaces an optional decision while retaining working activity and clears after resolution", () => {
    const item = node("working", {
      optionalInput: [
        { id: "optional", kind: "question", label: "Where should personal docs live?" },
      ],
      activity: [
        {
          id: "job",
          kind: "workflow",
          phase: "running",
          label: "Review fixes",
          actor: { kind: "agent", id: null, label: "Fixer" },
        },
      ],
    });

    assert.equal(item.state, "run");
    assert.equal(rowLine(item).verb, "Open decision");
    assert.match(rowLine(item).reason ?? "", /Where should personal docs live\?/u);
    assert.match(rowLine(item).reason ?? "", /Review fixes/u);
    assert.equal(item.thread.work?.primary.label, "working");
    assert.equal(hasFamilyActivity(item), true);
    assert.equal(node("working").state, "run");
  });

  it("retains a child's optional decision without hiding a sibling's work", () => {
    const tree = buildTree([
      chat("root", "open"),
      chat("job", "working", {
        parentThreadId: "root",
        work: work("working", {
          activity: [
            {
              id: "job",
              kind: "workflow",
              phase: "running",
              label: "Review fixes",
              actor: { kind: "agent", id: null, label: "Fixer" },
            },
          ],
        }),
      }),
      chat("choice", "open", {
        parentThreadId: "root",
        displayTitle: "Personal docs",
        work: work("open", {
          optionalInput: [{ id: "q", kind: "question", label: "Choose a docs location" }],
        }),
      }),
    ]);

    const root = tree.roots[0];
    assert.ok(root);
    assert.equal(root.state, "run");
    assert.equal(rowLine(root).verb, "Open decision");
    assert.match(rowLine(root).reason ?? "", /Sub-chat Personal docs: Choose a docs location/u);
    assert.equal(hasFamilyActivity(root), true);
  });

  it("retains a failure explanation when the chat is read", () => {
    const item = node("blocked", {
      failures: [
        {
          code: "dependency-failed",
          text: "The job failed before returning its result",
          sourceId: "job",
        },
      ],
    });

    item.thread.isUnread = true;
    const before = rowLine(item);
    item.thread.isUnread = false;
    assert.deepEqual(rowLine(item), before);
    assert.match(before.reason ?? "", /job failed/u);
  });

  it("keeps grouping independent of unrelated Glance or Tidy state", () => {
    const item = node("open", {
      assessment: {
        availability: "disabled",
        reason: "Predictions disabled",
        ask: null,
        recap: null,
        sourceSeq: null,
        suggestion: "unavailable",
        noSuggestionReason: null,
        waitingOn: null,
      },
    });

    assert.equal(item.own, "idle");
    assert.equal(rowLine(item).verb, "Open");
  });
});

describe("feed dates", () => {
  it("formats age and local creation time without treating either as work status", () => {
    const at = new Date(2026, 9, 28, 10, 15).getTime();
    assert.equal(age(at + 120_000, at), "2m");
    assert.equal(createdLabel(at + 120_000, at), "10:15");
  });

  it("names upcoming times by day so a return reads as when it comes back", () => {
    const now = new Date(2026, 9, 29, 22, 0).getTime();

    assert.equal(upcomingLabel(now, new Date(2026, 9, 29, 23, 30).getTime()), "23:30");
    assert.equal(upcomingLabel(now, new Date(2026, 9, 30, 9, 0).getTime()), "tomorrow 09:00");
    assert.equal(upcomingLabel(now, new Date(2026, 10, 2, 9, 0).getTime()), "Mon 09:00");
    assert.equal(upcomingLabel(now, new Date(2026, 10, 12, 9, 0).getTime()), "12 Nov");
    assert.equal(upcomingDay(now, new Date(2026, 9, 30, 9, 0).getTime()), "tomorrow");
    assert.equal(upcomingDay(now, new Date(2026, 9, 30, 9, 0).getTime() + 2 * 86_400_000), "Sun");
    assert.equal(upcomingDay(now, new Date(2027, 0, 5, 9, 0).getTime()), "5 Jan 2027");
  });
});

describe("sidebar summaries", () => {
  it("prefers the current Glance summary without replacing the title", () => {
    const item = node("waiting");
    const title = item.thread.displayTitle;
    assert.equal(
      rowSummary(item, "Checking the export on iPhone"),
      "Checking the export on iPhone",
    );
    assert.equal(item.thread.displayTitle, title);
  });

  it("leaves a running chat with only its title", () => {
    assert.equal(rowSummary(node("working"), "Checking the export on iPhone"), null);
    assert.equal(rowSummary(node("working"), null), null);
  });

  it("shows the question on a running chat that asks you", () => {
    const asking = node("working", {
      activity: [
        {
          id: "turn:1",
          kind: "turn",
          phase: "running",
          label: "The agent is working.",
          actor: { kind: "agent", id: null, label: "Agent" },
        },
      ],
      optionalInput: [{ id: "q", kind: "question", label: "Which cleanup should I include?" }],
    });

    assert.equal(
      rowSummary(asking, "Checking the export on iPhone"),
      "Which cleanup should I include? · Recorded working reason · The agent is working.",
    );
  });

  it("uses actionable canonical reasons before a stale card", () => {
    assert.equal(rowSummary(node("needs-you"), "All done"), "Recorded needs-you reason");
    assert.equal(rowSummary(node("blocked"), "All done"), "Recorded blocked reason");
    assert.equal(
      rowSummary(node("waiting"), "Needs you: obsolete question"),
      "Recorded waiting reason",
    );
  });

  it("falls back to meaningful reasons and omits placeholders and repeated titles", () => {
    assert.equal(rowSummary(node("waiting"), "Waiting"), "Recorded waiting reason");
    const item = node("open");
    item.thread.work = null;
    assert.equal(rowSummary(item, item.thread.displayTitle), null);
    assert.equal(rowSummary(item, "Work summary unavailable"), null);
    assert.equal(rowSummary(item, null), null);
  });
});

for (const label of ["working", "waiting", "open"] as const) {
  it(`keeps a failed child out of its ${label} parent's status and explanation`, () => {
    const tree = buildTree([
      chat("parent", label),
      chat("child", "failed", {
        parentThreadId: "parent",
        work: work("failed", {
          failures: [{ code: "run-failed", text: "Child provider failed", sourceId: "child" }],
        }),
      }),
    ]);

    const parent = tree.nodes.get("parent");
    const child = tree.nodes.get("child");
    assert.ok(parent);
    assert.ok(child);
    assert.equal(
      rowLine(parent).verb,
      label === "working" ? "Working" : label === "waiting" ? "Waiting" : "Open",
    );
    assert.doesNotMatch(rowLine(parent).reason ?? "", /failed/iu);
    assert.equal(child.state, "failed");
    assert.match(rowLine(child).reason ?? "", /Child provider failed/u);
  });
}
