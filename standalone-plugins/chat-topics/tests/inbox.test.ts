import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  archiveRequest,
  asksWhileWorking,
  bulkArchive,
  busyRoots,
  cardActionLine,
  cardLines,
  cardSummary,
  displayedReceiptIds,
  happenedWaitId,
  keyCommand,
  moveLabel,
  openTarget,
  pickedDate,
  primaryIntent,
  primaryLabel,
  questionThreadId,
  readyToArchive,
  inboxSection,
  rowMark,
  runningProgress,
  replyTarget,
  runEntry,
  shelfRows,
  waitChoices,
  waitRequest,
  waitingChip,
  waitingCondition,
  waitingDetail,
  waitingIn,
  waitingKind,
  waitingLane,
  waitingNextAt,
  type InboxEntry,
  type InboxPrimary,
  type KeyInput,
} from "../lib/inbox.ts";
import { OK, card, cause, entry, question, row, snapshot, waiting } from "./inbox-fixtures.ts";

const NOW = new Date(2026, 9, 29, 22, 0).getTime();

const TOMORROW_NINE = new Date(2026, 9, 30, 9, 0).getTime();

const MONDAY_NINE = new Date(2026, 10, 2, 9, 0).getTime();

const FIVE = ["r1", "r2", "r3", "r4", "r5"].map((id) => cause(id));

function key(value: string, change: Partial<KeyInput> = {}): KeyInput {
  return { key: value, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...change };
}

describe("Inbox card primaries", () => {
  it("labels every primary with its fixed button word", () => {
    const labels: [InboxPrimary, string][] = [
      [{ kind: "answer" }, "Answer"],
      [
        {
          kind: "accept-proposal",
          proposalKind: "report",
          waitId: "w",
          label: "On you: overlap recurs?",
        },
        "On you: overlap recurs?",
      ],
      [OK, "OK"],
      [{ kind: "reply", waiterTitles: [] }, "Reply"],
      [{ kind: "archive" }, "Archive"],
      [{ kind: "your-call" }, "Your call"],
      [{ kind: "resume", targetThreadId: "root", targetTitle: null }, "Resume"],
      [{ kind: "resume", targetThreadId: "kid", targetTitle: "Release job" }, "Resume Release job"],
      [{ kind: "problem-chooser", targetThreadId: "root", retryAllowed: true }, "Your call"],
      [{ kind: "keep-waiting", waitId: "w", until: MONDAY_NINE }, "Keep waiting until Mon 09:00"],
      [{ kind: "remind-later", waitId: "w" }, "Remind me in 14 days"],
      [{ kind: "continue-with-result", waitId: "w" }, "Continue with it"],
    ];

    for (const [primary, label] of labels) assert.equal(primaryLabel(primary, NOW, false), label);
    assert.equal(primaryLabel({ kind: "your-call" }, NOW, true), "Open");
  });

  it("never sends words from Enter: Reply only focuses the chat and Your call opens a chooser", () => {
    const reply = entry("root", { card: card({ kind: "reply", waiterTitles: [] }) });
    const yours = entry("root", { card: card({ kind: "your-call" }) });

    assert.deepEqual(primaryIntent(reply, card({ kind: "reply", waiterTitles: [] }), true, false), {
      kind: "command",
      command: "reply",
    });

    const chooser = primaryIntent(yours, card({ kind: "your-call" }), true, false);

    assert.equal(chooser.kind, "choose");
    assert.deepEqual(
      chooser.kind === "choose" ? chooser.items.map((item) => `${item.digit} ${item.label}`) : [],
      ["1 Archive", "2 Reply", "3 Wait", "4 Shelf"],
    );
    assert.deepEqual(primaryIntent(yours, card({ kind: "your-call" }), true, true), {
      kind: "command",
      command: "open",
    });
    assert.deepEqual(primaryIntent(yours, card({ kind: "archive" }), true, false), {
      kind: "command",
      command: "archive",
    });
  });

  it("offers Retry on a failure only when no outward effect ran, keeping each item's digit", () => {
    const failed = entry("root");

    const choices = (retryAllowed: boolean) => {
      const intent = primaryIntent(
        failed,
        card(
          { kind: "problem-chooser", targetThreadId: "root", retryAllowed },
          { kind: "problem" },
        ),
        true,
        false,
      );

      return intent.kind === "choose"
        ? intent.items.map((item) => `${item.digit} ${item.label}`)
        : [];
    };

    assert.deepEqual(choices(true), ["1 Retry", "2 Reply", "3 Archive"]);
    assert.deepEqual(choices(false), ["2 Reply", "3 Archive"]);
  });

  it("handles exactly the receipts a card displays, with the latch it showed", () => {
    const many = card(OK, { causes: FIVE });
    const shown = entry("root", { card: many, latch: "shown-latch" });

    assert.deepEqual(primaryIntent(shown, many, false, false), {
      kind: "act",
      request: {
        action: "ok",
        threadId: "root",
        displayedReceiptIds: ["r1", "r2", "r3"],
        latch: "shown-latch",
      },
    });
    assert.deepEqual(displayedReceiptIds(many, true), ["r1", "r2", "r3", "r4", "r5"]);
    assert.deepEqual(archiveRequest(shown, true, true), {
      action: "archive",
      threadId: "root",
      displayedReceiptIds: ["r1", "r2", "r3", "r4", "r5"],
      stopRunning: true,
      latch: "shown-latch",
    });
  });

  it("resumes the chat that failed and keeps a returned wait armed until the new date", () => {
    const failure = card(
      { kind: "resume", targetThreadId: "kid", targetTitle: "Release job" },
      { kind: "problem" },
    );

    const returned = card(
      { kind: "keep-waiting", waitId: "wait-9", until: MONDAY_NINE },
      { kind: "returned" },
    );

    assert.deepEqual(primaryIntent(entry("root", { card: failure }), failure, true, false), {
      kind: "act",
      request: {
        action: "resume",
        threadId: "root",
        displayedReceiptIds: ["r1"],
        latch: entry("root", { card: failure }).latch,
        targetThreadId: "kid",
      },
    });

    const request = primaryIntent(entry("root", { card: returned }), returned, true, false);

    assert.equal(request.kind === "act" ? request.request.action : null, "keep-waiting");
  });
});

describe("Inbox card lines", () => {
  it("shows a failure with what waits behind it", () => {
    const failure = card(
      { kind: "resume", targetThreadId: "root", targetTitle: null },
      {
        kind: "problem",
        failure: {
          threadId: "root",
          reason: "Provider timed out",
          queuedCount: 1,
          scheduledCount: 2,
        },
      },
    );

    assert.deepEqual(cardLines(failure, NOW), [
      "Failed: Provider timed out",
      "1 queued message waiting",
      "2 scheduled messages waiting",
    ]);
  });

  it("names what the chat waits on next, who waits on a stalled source, and when nothing is next", () => {
    assert.deepEqual(cardLines(card({ kind: "ok", thenWaits: "App Store review" }), NOW), [
      "Then waits: App Store review",
    ]);
    assert.deepEqual(
      cardLines(card({ kind: "reply", waiterTitles: ["Overlap fix", "Release"] }), NOW),
      ["Overlap fix and Release are waiting on this chat's result"],
    );
    assert.deepEqual(cardLines(card({ kind: "your-call" }), NOW), ["Nothing next"]);
    assert.deepEqual(
      cardLines(card({ kind: "your-call" }, { notAssessed: "the chat changed" }), NOW),
      ["Not assessed: the chat changed"],
    );
    assert.deepEqual(
      cardLines(
        card(OK, { stillOnYou: "overlap recurs", snoozedQuestionUntil: TOMORROW_NINE }),
        NOW,
      ),
      ["Still on you: overlap recurs", "Question waits until tomorrow 09:00"],
    );
  });

  it("summarizes the kind, every cause with its source chat, then the card lines", () => {
    const failed = card(
      { kind: "resume", targetThreadId: "root", targetTitle: null },
      {
        kind: "problem",
        causes: [...FIVE.slice(0, 3), cause("r4", { fromTitle: "Release job" }), FIVE[4]],
        failure: {
          threadId: "root",
          reason: "Provider timed out",
          queuedCount: 1,
          scheduledCount: 0,
        },
      },
    );

    assert.equal(
      cardSummary(failed, NOW),
      [
        "Problem",
        "Result r1",
        "Result r2",
        "Result r3",
        "Result r4 · from Release job",
        "Result r5",
        "Failed: Provider timed out",
        "1 queued message waiting",
      ].join("\n"),
    );
  });

  it("names the chat a question came from", () => {
    const asked = question("q-1", {
      questionFrom: "Release scope",
      causes: [cause("q1", { cause: "question", summary: "Pick the release scope" })],
    });

    assert.equal(cardSummary(asked, NOW), "Question from Release scope\nPick the release scope");
    assert.equal(cardSummary(question("q-2"), NOW), "Question\nResult r1");
  });

  it("lists a repeated cause once with its count", () => {
    const repeated = card(OK, {
      causes: [
        cause("r1", { summary: "Turn finished" }),
        cause("r2", { summary: "Shipped the fix" }),
        cause("r3", { summary: "Turn finished" }),
        cause("r4", { summary: "Turn finished" }),
      ],
    });

    assert.equal(cardSummary(repeated, NOW), "Result\nTurn finished ×3\nShipped the fix");
  });
});

describe("Inbox card action line", () => {
  it("drops the action the primary already does and the primary a chooser repeats", () => {
    assert.deepEqual(cardActionLine(card({ kind: "archive" })), {
      primary: true,
      actions: ["wait", "reply", "shelf"],
    });
    assert.deepEqual(cardActionLine(card({ kind: "reply", waiterTitles: [] })), {
      primary: true,
      actions: ["archive", "wait", "shelf"],
    });
    assert.deepEqual(cardActionLine(card({ kind: "your-call" })), {
      primary: false,
      actions: ["archive", "wait", "reply", "shelf"],
    });
    assert.deepEqual(cardActionLine(card(OK)), {
      primary: true,
      actions: ["archive", "wait", "reply", "shelf"],
    });
  });
});

describe("Inbox wait menu", () => {
  it("offers tomorrow, Monday, a picked date and a report-it wait on a Result card", () => {
    const result = card(OK);
    const choices = waitChoices(result, NOW);

    assert.deepEqual(
      choices.map((choice) => choice.label),
      ["Tomorrow 09:00", "Monday 09:00", "Pick a date", "On you (When I report it)"],
    );
    assert.deepEqual(
      choices.flatMap((choice) => (choice.step === "date" ? [choice.until] : [])),
      [TOMORROW_NINE, MONDAY_NINE],
    );
    assert.deepEqual(waitRequest(entry("root", { card: result }), result, true, TOMORROW_NINE), {
      action: "wait",
      threadId: "root",
      displayedReceiptIds: ["r1"],
      latch: entry("root", { card: result }).latch,
      until: TOMORROW_NINE,
    });
  });

  it("keeps the original wait armed from a Returned card instead of snoozing it", () => {
    const returned = card(
      { kind: "keep-waiting", waitId: "wait-9", until: MONDAY_NINE },
      { kind: "returned" },
    );

    const labels = waitChoices(returned, NOW).map((choice) => choice.label);
    const request = waitRequest(entry("root", { card: returned }), returned, true, TOMORROW_NINE);

    assert.deepEqual(labels.slice(0, 2), [
      "Keep waiting until tomorrow 09:00",
      "Keep waiting until Mon 09:00",
    ]);
    assert.equal(request.action, "keep-waiting");
    assert.equal(request.action === "keep-waiting" ? request.waitId : null, "wait-9");
  });

  it("picks next week's Monday on a Monday and reads a picked date at 09:00", () => {
    const monday = new Date(2026, 10, 2, 8, 0).getTime();
    const choices = waitChoices(card(OK), monday);

    assert.deepEqual(
      choices.flatMap((choice) => (choice.step === "date" ? [choice.until] : [])),
      [new Date(2026, 10, 3, 9, 0).getTime(), new Date(2026, 10, 9, 9, 0).getTime()],
    );
    assert.equal(pickedDate("2026-11-12"), new Date(2026, 10, 12, 9, 0).getTime());
    assert.equal(pickedDate("next week"), null);
  });
});

describe("Inbox keys", () => {
  it("maps the list keys to their actions and ignores shortcuts with modifiers", () => {
    const commands = [
      "j",
      "k",
      "ArrowDown",
      "ArrowUp",
      "Enter",
      "Escape",
      "r",
      "e",
      "w",
      "s",
      "h",
      "o",
      "z",
    ].map((value) => keyCommand(key(value)));

    assert.deepEqual(
      commands.map((result) => (result?.kind === "command" ? result.command : null)),
      [
        "next",
        "previous",
        "next",
        "previous",
        "primary",
        "escape",
        "reply",
        "archive",
        "wait",
        "shelf",
        "happened",
        "open",
        "undo",
      ],
    );
    assert.deepEqual(keyCommand(key("E", { shiftKey: true })), {
      kind: "command",
      command: "bulk",
    });
    assert.deepEqual(keyCommand(key("J")), { kind: "command", command: "next" });
    assert.deepEqual(keyCommand(key("3")), { kind: "digit", digit: 3 });
    assert.equal(keyCommand(key("0")), null);
    assert.equal(keyCommand(key("J", { shiftKey: true })), null);
    assert.equal(keyCommand(key("e", { metaKey: true })), null);
    assert.equal(keyCommand(key("Enter", { ctrlKey: true })), null);
    assert.equal(keyCommand(key("x")), null);
  });

  it("reports It happened only on a report-it wait", () => {
    assert.equal(
      happenedWaitId(waiting("root", { group: "on-you", waitId: "report-1" })),
      "report-1",
    );
    assert.equal(
      happenedWaitId(entry("root", { card: card({ kind: "remind-later", waitId: "report-2" }) })),
      "report-2",
    );
    assert.equal(happenedWaitId(waiting("root")), null);
    assert.equal(happenedWaitId(entry("root")), null);
  });

  it("replies to the chat that failed when a sub-chat's failure lifted onto the card", () => {
    const failure = card(
      { kind: "resume", targetThreadId: "kid", targetTitle: "Release job" },
      {
        kind: "problem",
        failure: { threadId: "kid", reason: "Crashed", queuedCount: 0, scheduledCount: 0 },
      },
    );

    assert.equal(replyTarget(entry("root", { card: failure })), "kid");
    assert.equal(replyTarget(entry("root")), "root");
  });
});

describe("Waiting rows", () => {
  it("says when a wait checks and when it comes back", () => {
    const fiveNov = new Date(2026, 10, 5, 12, 0).getTime();
    const lateTonight = new Date(2026, 9, 29, 23, 0).getTime();

    assert.equal(waitingDetail(row({ checking: true, returnAt: fiveNov }), NOW), "Checking…");
    assert.equal(
      waitingDetail(row({ checkAt: lateTonight, returnAt: fiveNov + 7 * 86_400_000 }), NOW),
      "checks 23:00 · back by 12 Nov",
    );
    assert.equal(
      waitingDetail(row({ checkAt: TOMORROW_NINE, checkCount: 3, returnAt: TOMORROW_NINE }), NOW),
      "checked 3× · next tomorrow 09:00",
    );
    assert.equal(waitingDetail(row({ returnAt: fiveNov }), NOW), "back 5 Nov");
    assert.equal(waitingDetail(row(), NOW), null);
    assert.equal(
      waitingDetail(row({ retry: { at: TOMORROW_NINE, attempt: 1, maxAttempts: 4 } }), NOW),
      "Retrying tomorrow 09:00 · 1 of 4",
    );
  });

  it("files each wait under its kind, with on-you waits first", () => {
    assert.equal(waitingLane(row({ kind: "check" })), "check");
    assert.equal(waitingLane(row({ kind: "check", group: "on-you" })), "on-you");
    assert.equal(waitingLane(null), "event");
  });

  it("works out the kind when an older host sends none", () => {
    const old = { ...row(), kind: undefined };

    assert.equal(
      waitingKind({ ...old, retry: { at: null, attempt: null, maxAttempts: null } }),
      "retry",
    );
    assert.equal(waitingKind({ ...old, behind: "Refund letter", checkAt: TOMORROW_NINE }), "chat");
    assert.equal(waitingKind({ ...old, checkAt: TOMORROW_NINE }), "check");
    assert.equal(waitingKind({ ...old, returnAt: TOMORROW_NINE }), "scheduled");
    assert.equal(waitingKind(old), "event");
  });

  it("puts how soon a chat comes back in the gutter", () => {
    assert.equal(
      waitingNextAt(row({ checkAt: TOMORROW_NINE, returnAt: TOMORROW_NINE + 1 }), NOW),
      TOMORROW_NINE,
    );
    assert.equal(waitingNextAt(row({ checking: true }), NOW), NOW);
    assert.equal(waitingNextAt(row(), NOW), null);
    assert.equal(waitingIn(NOW, NOW + 30_000), "now");
    assert.equal(waitingIn(NOW, NOW + 55 * 60_000), "55m");
    assert.equal(waitingIn(NOW, TOMORROW_NINE), "11h");
    assert.equal(waitingIn(NOW, NOW + 7 * 86_400_000), "7d");
  });

  it("leaves times to the gutter and chips only checks in progress and retries", () => {
    assert.equal(waitingChip(row({ kind: "check", checkAt: TOMORROW_NINE })), null);
    assert.equal(waitingChip(row({ kind: "scheduled", returnAt: TOMORROW_NINE })), null);
    assert.equal(waitingChip(row({ kind: "event" })), null);
    assert.deepEqual(waitingChip(row({ checking: true })), {
      icon: "Spinner",
      text: "Checking",
      warning: false,
    });
    assert.deepEqual(
      waitingChip(row({ kind: "retry", retry: { at: TOMORROW_NINE, attempt: 2, maxAttempts: 3 } })),
      { icon: "RotateCcw", text: "2/3", warning: true },
    );
  });

  it("gives a second line only to waits on a condition", () => {
    assert.equal(waitingCondition(row({ kind: "scheduled", returnAt: TOMORROW_NINE })), null);
    assert.equal(
      waitingCondition(row({ kind: "check", reason: "GSC final data", checkCount: 2 })),
      "GSC final data · checked 2×",
    );
    assert.equal(
      waitingCondition(row({ kind: "chat", reason: "Draft ready", behind: "Refund letter" })),
      "Draft ready · from Refund letter",
    );
  });
});

describe("Runs cards", () => {
  const runs = [
    {
      threadId: "run-1",
      title: "Nightly 1",
      primary: { kind: "archive" } as const,
      causes: [cause("n1")],
      since: 1_000,
      latch: "run-1-latch",
    },
    {
      threadId: "run-2",
      title: "Nightly 2",
      primary: OK,
      causes: [cause("n2"), cause("n3")],
      since: 2_000,
      latch: "run-2-latch",
    },
  ];

  it("labels the group primary and archives exactly the listed runs as one request", () => {
    const done: InboxPrimary = {
      kind: "archive-runs",
      mode: "done",
      threadIds: ["run-1", "run-2"],
    };

    const older: InboxPrimary = { kind: "archive-runs", mode: "older", threadIds: ["run-1"] };
    const group = card(done, { kind: "runs", actions: [] });
    const shown = entry("run-2", { card: group, runs, latch: "runs-latch" });

    assert.equal(primaryLabel(done, NOW, false), "Archive 2 done runs");
    assert.equal(primaryLabel(older, NOW, false), "Keep latest · archive 1 older");
    assert.deepEqual(primaryIntent(shown, group, true, false), {
      kind: "act",
      request: {
        action: "archive-runs",
        threadId: "run-2",
        threadIds: ["run-1", "run-2"],
        latch: "runs-latch",
      },
    });
    assert.equal(
      moveLabel({ action: "archive-runs", threadId: "run-2", threadIds: ["run-1", "run-2"] }, NOW),
      "Archived 2 runs",
    );
  });

  it("acts on one member with that member's chat, receipts, primary and latch", () => {
    const group = card(
      { kind: "archive-runs", mode: "done", threadIds: ["run-1"] },
      { kind: "runs", actions: [] },
    );

    const member = runEntry(entry("run-2", { card: group, runs }), runs[1]);

    assert.equal(member.threadId, "run-2");
    assert.equal(member.runs, null);
    assert.deepEqual(member.card === null ? null : primaryIntent(member, member.card, true, true), {
      kind: "act",
      request: {
        action: "ok",
        threadId: "run-2",
        displayedReceiptIds: ["n2", "n3"],
        latch: "run-2-latch",
      },
    });
    assert.deepEqual(
      archiveRequest(runEntry(entry("run-2", { card: group, runs }), runs[0]), true, false),
      {
        action: "archive",
        threadId: "run-1",
        displayedReceiptIds: ["n1"],
        stopRunning: false,
        latch: "run-1-latch",
      },
    );
  });
});

describe("Provider incidents", () => {
  it("resumes every chat of a shared usage limit at its verified reset in one request", () => {
    const resetAt = NOW + 9 * 60 * 60 * 1000;

    const primary: InboxPrimary = {
      kind: "resume-all-at-reset",
      resetAt,
      threadIds: ["limited-1", "limited-2"],
    };

    const group = card(primary, { kind: "problem", actions: [] });

    const members = ["limited-1", "limited-2"].map((threadId, index) => ({
      threadId,
      title: threadId,
      primary: { kind: "resume", targetThreadId: threadId, targetTitle: null } as const,
      causes: [cause(`f${index}`)],
      since: 1_000 + index,
      latch: `${threadId}-latch`,
    }));

    const shown = entry("limited-1", {
      card: group,
      incident: {
        key: "codex:rate-limit:host:host_mac",
        label: "codex usage limit",
        resetAt,
        members,
      },
      latch: "incident-latch",
    });

    assert.match(primaryLabel(primary, NOW, false), /^Resume all at reset · /);
    assert.deepEqual(primaryIntent(shown, group, true, false), {
      kind: "act",
      request: {
        action: "resume-all-at-reset",
        threadId: "limited-1",
        threadIds: ["limited-1", "limited-2"],
        latch: "incident-latch",
      },
    });
    assert.equal(
      moveLabel(
        {
          action: "resume-all-at-reset",
          threadId: "limited-1",
          threadIds: ["limited-1", "limited-2"],
        },
        NOW,
      ),
      "2 chats resume at the reset",
    );
    assert.equal(bulkArchive([shown], new Set()).length, 0);
  });
});

describe("Shift+E", () => {
  it("lists only cards whose primary is Archive, skipping Shelf chats, Runs and running work", () => {
    const done = entry("done", { card: card({ kind: "archive" }) });
    const shelved = entry("shelved", { shelved: true, card: card({ kind: "archive" }) });
    const runs = entry("runs", { card: card({ kind: "archive" }, { kind: "runs" }) });
    const source = entry("source", { card: card({ kind: "reply", waiterTitles: ["A"] }) });
    const running = entry("running", { card: card({ kind: "archive" }) });

    assert.deepEqual(
      bulkArchive([done, shelved, runs, source, running, entry("ok")], new Set(["running"])).map(
        (item) => item.threadId,
      ),
      ["done"],
    );
  });
});

describe("Inbox data from the server", () => {
  it("lists a shelved chat on the Shelf only when no other section shows it", () => {
    const shelvedCard = entry("card", { shelved: true, card: question("q2") });
    const shelvedWaiting = { ...waiting("wait"), shelved: true };

    const shelvedRunning = entry("run", {
      shelved: true,
      view: "running",
      card: null,
      running: { label: "Working", progress: null },
    });

    const resting = entry("rest", { shelved: true, view: "resting", card: null });

    const whole = snapshot({
      inbox: [shelvedCard],
      waiting: [shelvedWaiting],
      running: [shelvedRunning],
      shelf: [shelvedCard, shelvedWaiting, shelvedRunning, resting],
    });

    assert.deepEqual(
      shelfRows(whole).map((item) => item.threadId),
      ["rest"],
    );
  });

  it("sorts cards into Needs you and Ready to archive by what they ask of you", () => {
    const done = entry("done", { card: card({ kind: "archive" }) });

    const runs = entry("runs", {
      card: card({ kind: "archive-runs", mode: "done", threadIds: ["r1"] }, { kind: "runs" }),
    });

    const waits = entry("waits", { card: card({ kind: "ok", thenWaits: "SSD back" }) });
    const works = entry("works", { card: card({ kind: "ok", thenWaits: "Work continues" }) });

    const older = entry("older", {
      card: card({ kind: "archive-runs", mode: "older", threadIds: ["r1"] }, { kind: "runs" }),
    });

    const asks = entry("asks", { card: question("q1") });
    const reply = entry("reply", { card: card({ kind: "reply", waiterTitles: [] }) });
    const call = entry("call", { card: card({ kind: "your-call" }) });
    const broken = entry("broken", { card: card({ kind: "archive" }, { kind: "problem" }) });

    for (const item of [done, runs]) assert.equal(readyToArchive(item), true, item.threadId);

    for (const item of [waits, works, older, asks, reply, call, broken])
      assert.equal(readyToArchive(item), false, item.threadId);
  });

  it("keeps a shelved chat that only needs archiving on the Shelf, not the Inbox", () => {
    const parked = entry("parked", { shelved: true, card: card({ kind: "archive" }) });
    const resting = entry("resting", { shelved: true, card: card(OK) });
    const asks = entry("asks", { shelved: true, card: question("q1") });

    const whole = snapshot({
      inbox: [asks, parked, resting],
      shelf: [asks, parked, resting],
    });

    assert.deepEqual(
      shelfRows(whole).map((item) => item.threadId),
      ["parked", "resting"],
    );

    assert.equal(readyToArchive(resting), false);
  });

  it("reads a running chat's todo progress and ignores a server that sends none", () => {
    type ServerRunning = {
      label: string;
      progress?: { done: number; total: number } | null;
    } | null;

    const running = (value: ServerRunning): InboxEntry =>
      Object.assign(entry("r", { view: "running", card: null }), { running: value });

    assert.deepEqual(runningProgress(running({ label: "x", progress: { done: 2, total: 5 } })), {
      done: 2,
      total: 5,
    });
    assert.equal(runningProgress(running({ label: "x", progress: null })), null);
    assert.equal(runningProgress(running({ label: "x" })), null);
    assert.equal(runningProgress(running(null)), null);
  });

  it("finds running work anywhere in a family and the sub-chat that asks a question", () => {
    const threads = [
      { id: "root", projectId: "omnyo", parentThreadId: null, status: "idle" },
      { id: "kid", projectId: "omnyo", parentThreadId: "root", status: "idle" },
      { id: "worker", projectId: "omnyo", parentThreadId: "kid", status: "active" },
      { id: "quiet", projectId: "omnyo", parentThreadId: null, status: "idle" },
    ];

    assert.deepEqual([...busyRoots(threads)], ["root"]);

    const asked = question("q-7", { questionFrom: "Release scope" });

    const family = [
      { id: "root", experimental_work: { requiredInput: [], optionalInput: [] } },
      { id: "kid", experimental_work: { requiredInput: [{ id: "q-7" }], optionalInput: [] } },
    ];

    assert.equal(questionThreadId(asked, "root", family), "kid");
    assert.equal(questionThreadId(question("q-8"), "root", family), "root");
  });

  it("opens a question card at the chat that asked and every other card at its own chat", () => {
    const family = [
      { id: "root", experimental_work: { requiredInput: [], optionalInput: [] } },
      { id: "kid", experimental_work: { requiredInput: [{ id: "q-7" }], optionalInput: [] } },
    ];

    assert.equal(openTarget(entry("root", { card: question("q-7") }), family), "kid");
    assert.equal(openTarget(entry("root", { card: question("q-8") }), family), "root");
    assert.equal(
      openTarget(entry("root", { card: card(OK, { questionIds: ["q-7"] }) }), family),
      "root",
    );
    assert.equal(openTarget(waiting("root"), family), "root");
  });

  it("opens the descendant optional question without requiring an answer or changing activity", () => {
    const optional = question("optional-child", {
      questionMode: "optional",
      actions: ["archive", "wait", "reply", "shelf"],
    });

    const family = [
      { id: "root", experimental_work: { requiredInput: [], optionalInput: [] } },
      {
        id: "kid",
        experimental_work: { requiredInput: [], optionalInput: [{ id: "optional-child" }] },
      },
    ];

    const before = JSON.stringify({ optional, family });
    assert.equal(questionThreadId(optional, "root", family), "kid");
    assert.deepEqual(primaryIntent(entry("root", { card: optional }), optional, true, false), {
      kind: "answer",
    });
    assert.equal(JSON.stringify({ optional, family }), before);
  });

  it("chooses a required descendant before an optional root on a mixed question card", () => {
    const mixed = question("optional-root", {
      questionIds: ["optional-root", "required-child"],
      questionMode: "required",
    });

    const family = [
      {
        id: "root",
        experimental_work: { requiredInput: [], optionalInput: [{ id: "optional-root" }] },
      },
      {
        id: "kid",
        experimental_work: { requiredInput: [{ id: "required-child" }], optionalInput: [] },
      },
    ];

    assert.equal(questionThreadId(mixed, "root", family), "kid");
    assert.equal(mixed.questionMode, "required");
  });

  it("retains optional mode and active work through the actual snapshot update with a distinct latch", () => {
    const required = entry("root", { card: question("same-question") });

    const optionalCard = question("same-question", {
      questionMode: "optional",
      actions: ["archive", "wait", "reply", "shelf"],
    });

    const optional = entry("root", {
      card: optionalCard,
      running: { label: "Review fixes", progress: null },
    });

    assert.notEqual(required.latch, optional.latch);
    assert.equal(waitRequest(optional, optionalCard, true, TOMORROW_NINE).action, "wait");
    const archived = archiveRequest(optional, true, false);

    if (archived.action !== "archive") assert.fail("Expected the existing archive request");
    assert.equal(archived.stopRunning, false);
  });

  it("names each move in its Undo toast", () => {
    assert.equal(moveLabel(archiveRequest(entry("a"), true, false), NOW), "Archived");
    assert.equal(
      moveLabel(waitRequest(entry("a"), card(OK), true, TOMORROW_NINE), NOW),
      "Waits until tomorrow 09:00",
    );
    assert.equal(moveLabel({ action: "shelf", threadId: "a", shelved: true }, NOW), "On the Shelf");
    assert.equal(
      moveLabel({ action: "shelf", threadId: "a", shelved: false }, NOW),
      "Off the Shelf",
    );
  });
});

describe("server-owned Inbox sections", () => {
  it("moves a working chat's open question card into Needs you and keeps finished work out", () => {
    const optionalQuestion = { id: "q", label: "Optional choice", threadId: "working" };

    const asking = entry("working", {
      state: "working",
      optionalQuestion,
      card: question("q", { questionMode: "optional" }),
    });

    assert.equal(asksWhileWorking(asking), true);
    assert.equal(inboxSection(asking), "need");
    assert.equal(
      inboxSection(entry("working", { state: "working", card: question("required") })),
      "need",
    );

    const badgeOnly = entry("working", { state: "working", optionalQuestion });

    assert.equal(asksWhileWorking(badgeOnly), false);
    assert.equal(inboxSection(badgeOnly), "run");

    const subChatAsks = entry("working", {
      state: "working",
      card: question("child", { questionMode: "optional", questionFrom: "Helper" }),
    });

    const idleRootWhileSubChatRuns = entry("working", {
      state: "working",
      card: question("root", { questionMode: "optional" }),
      reason: { kind: "activity", text: "Working", threadId: "helper" },
    });

    assert.equal(inboxSection(subChatAsks), "run");
    assert.equal(inboxSection(idleRootWhileSubChatRuns), "run");
    assert.equal(
      inboxSection(entry("waiting", { state: "waiting", card: question("waits") })),
      "waiting",
    );
    assert.equal(
      inboxSection(entry("finished", { state: "finished", archiveReady: false })),
      "finished",
    );
    assert.equal(inboxSection(entry("ready", { state: "finished", archiveReady: true })), "ready");
  });
});

describe("rowMark", () => {
  it("badges the project icon with each state", () => {
    assert.equal(rowMark("need", { state: "needs-you", archiveReady: false }), "need");
    assert.equal(rowMark("idle", { state: "working", archiveReady: false }), "run");
    assert.equal(rowMark("stop", { state: "working", archiveReady: false }), "stop");
    assert.equal(rowMark("que", { state: "waiting", archiveReady: false }), "wait");
    assert.equal(rowMark("done", { state: "finished", archiveReady: false }), "done");
    assert.equal(rowMark("done", { state: "finished", archiveReady: true }), "ready");
    assert.equal(rowMark("done", { state: "archive", archiveReady: false }), null);
    assert.equal(rowMark("idle", { state: "resting", archiveReady: false }), null);
  });
});

describe("failed server state", () => {
  it("keeps failures separate from owner questions with a failure mark", () => {
    const failed = entry("failure", { state: "failed" });
    assert.equal(inboxSection(failed), "failed");
    assert.equal(rowMark("failed", failed), "failed");
  });
});

it("preserves retry actions and receipts on failed rows", () => {
  const failure = card(
    { kind: "problem-chooser", targetThreadId: "child", retryAllowed: true },
    { kind: "problem" },
  );

  const failed = entry("root", { state: "failed", card: failure });
  assert.equal(inboxSection(failed), "failed");
  assert.deepEqual(primaryIntent(failed, failure, false, false), {
    kind: "choose",
    items: [
      { digit: 1, label: "Retry", command: "retry" },
      { digit: 2, label: "Reply", command: "reply" },
      { digit: 3, label: "Archive", command: "archive" },
    ],
  });
  assert.deepEqual(displayedReceiptIds(failure, false), ["r1"]);
});
