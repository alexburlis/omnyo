import type { PluginSidebarThread } from "@omnyo/plugin-sdk/app";
import { describe, expect, it } from "vitest";
import { viewsFromSnapshot, type ServerView } from "../components/inbox-views";
import { cardPresentation, serverStatus } from "../components/presentation";

const reported = {
  status: "done" as const,
  stale: false,
  headline: "Card is live",
  blocker: "Sam unblocks it",
  next: "The agent checks the device",
};

function view(change: Partial<ServerView>): ServerView {
  return {
    view: "inbox",
    state: "finished",
    reason: { kind: "recap", text: "Result verified", threadId: "lead" },
    archiveReady: false,
    stale: false,
    card: "result",
    primary: "ok",
    ...change,
  };
}

type Work = NonNullable<PluginSidebarThread["experimental_work"]>;

function work(label: Work["primary"]["label"]): Work {
  return {
    revision: "work-1",
    basis: "basis-1",
    primary: { label, reason: { code: "test", text: "Waiting for another chat" } },
    activity: [],
    requiredInput: [],
    optionalInput: [],
    failures: [],
    waits: [],
    nextActors: [],
    assessment: {
      availability: "missing",
      reason: "No completion assessment has been prepared.",
      sourceSeq: null,
      suggestion: "unavailable",
      noSuggestionReason: null,
      waitingOn: null,
      ask: null,
      recap: null,
    },
    postponement: null,
    archive: { eligible: false, recommended: false, reason: "The chat is not finished." },
  };
}

describe("the Glance chip renders the server view", () => {
  it("maps each server state to one chip regardless of legacy view or work label", () => {
    const cases = [
      ["needs-you", "needs-you"],
      ["failed", "failed"],
      ["finished", "finished"],
      ["working", "working"],
      ["waiting", "waiting"],
      ["resting", "open"],
      ["archive", "done"],
    ] as const;

    for (const [state, expected] of cases) expect(serverStatus(view({ state }))).toBe(expected);
    expect(
      cardPresentation(reported, undefined, work("waiting"), view({ state: "needs-you" })).status,
    ).toBe("needs-you");
    expect(
      cardPresentation(reported, undefined, work("needs-you"), view({ state: "working" })).status,
    ).toBe("working");
  });

  it("uses the shared server reason with the reported next step", () => {
    expect(cardPresentation(reported, undefined, null, view({ state: "working" }))).toEqual({
      status: "working",
      headline: "Result verified",
      blocker: null,
      next: "The agent checks the device",
      lastReported: null,
    });
  });

  it("reads every chat a snapshot names, including Runs and incident members", () => {
    const member = (threadId: string) => ({
      threadId,
      title: threadId,
      primary: { kind: "resume", targetThreadId: threadId, targetTitle: null } as const,
      causes: [],
      since: 1,
      latch: threadId,
    });

    const entry = {
      threadId: "lead",
      projectId: "omnyo",
      title: "lead",
      shelved: false,
      automationId: null,
      state: "needs-you" as const,
      reason: { kind: "decision" as const, text: "Choose recovery", threadId: "lead" },
      recap: null,
      archiveReady: false,
      optionalQuestion: null,
      pendingResults: 0,
      view: "inbox" as const,
      card: null,
      waiting: null,
      running: null,
      runs: null,
      incident: { key: "k", label: "codex usage limit", resetAt: null, members: [member("other")] },
      sortAt: 1,
      latch: "l",
    };

    const views = viewsFromSnapshot({
      revision: "r",
      generatedAt: 1,
      inbox: [entry],
      waiting: [{ ...entry, threadId: "waits", view: "waiting", incident: null }],
      running: [],
      shelf: [],
      counts: {
        inbox: 1,
        needsYou: 1,
        questions: 0,
        running: 0,
        waiting: 1,
        onYou: [],
        nextBackAt: null,
      },
      lastMove: null,
    });

    expect(views.get("other")).toEqual(views.get("lead"));
    expect(views.get("other")?.state).toBe("needs-you");
    expect(
      viewsFromSnapshot(
        {
          revision: "stale",
          generatedAt: 1,
          inbox: [entry],
          waiting: [],
          running: [],
          shelf: [],
          counts: {
            inbox: 1,
            needsYou: 1,
            questions: 0,
            running: 0,
            waiting: 0,
            onYou: [],
            nextBackAt: null,
          },
          lastMove: null,
        },
        true,
      ).get("lead")?.stale,
    ).toBe(true);
    expect(views.get("waits")?.view).toBe("waiting");
  });
});

it("keeps the failure reason when the reported card says done", () => {
  expect(
    cardPresentation(
      reported,
      undefined,
      work("open"),
      view({
        state: "failed",
        reason: { kind: "failure", text: "The operation failed", threadId: "lead" },
      }),
    ),
  ).toMatchObject({ status: "failed", headline: "The operation failed" });
});
