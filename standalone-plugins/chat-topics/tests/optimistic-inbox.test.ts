import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chainsBehindPending,
  leavesInbox,
  offersUndo,
  predictAct,
  restoreThreadRows,
  shelvedOnly,
  type InboxActRequest,
} from "../lib/inbox.ts";
import {
  createInboxFlights,
  inboxOutcome,
  undoAfter,
  type InboxOutcome,
} from "../lib/inbox-store.ts";
import { card, counts, entry, question, snapshot, waiting } from "./inbox-fixtures.ts";

const ARCHIVE_A: InboxActRequest = {
  action: "archive",
  threadId: "a",
  displayedReceiptIds: ["r1"],
  latch: "l1",
  stopRunning: false,
};

function shelve(threadId: string): InboxActRequest {
  return { action: "shelf", threadId, shelved: true };
}

function unshelve(threadId: string): InboxActRequest {
  return { action: "shelf", threadId, shelved: false };
}

function ids(entries: readonly { threadId: string }[]): string[] {
  return entries.map((item) => item.threadId);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;

  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const DONE: InboxOutcome = { kind: "done", moveId: "move-1", entry: null };

describe("predictAct for cursor decisions", () => {
  const before = snapshot({
    inbox: [entry("a"), entry("b")],
    waiting: [waiting("w", { group: "on-you", reason: "Deploy" })],
    shelf: [entry("a", { shelved: true })],
    counts: counts({ inbox: 2, waiting: 1, onYou: ["Deploy"] }),
  });

  it("archive removes the chat from every list and recounts", () => {
    const next = predictAct(before, ARCHIVE_A);

    assert.deepEqual(ids(next.inbox), ["b"]);
    assert.deepEqual(ids(next.shelf), []);
    assert.equal(next.counts.inbox, 1);
  });

  it("happened clears the On you row", () => {
    const next = predictAct(before, {
      action: "happened",
      threadId: "w",
      waitId: "wait-1",
      note: null,
    });

    assert.deepEqual(ids(next.waiting), []);
    assert.deepEqual(next.counts.onYou, []);
  });

  it("shelving a card the server rests on the Shelf leaves the Inbox at once", () => {
    const yourCall = entry("y", { card: card({ kind: "your-call" }) });
    const ready = entry("r", { card: card({ kind: "archive" }) });
    const next = predictAct(snapshot({ inbox: [yourCall, ready] }), shelve("y"));
    const both = predictAct(next, shelve("r"));

    assert.equal(shelvedOnly(next.inbox[0] ?? yourCall), true);
    assert.deepEqual(ids(both.shelf), ["y", "r"]);
    assert.equal(
      both.inbox.every((item) => shelvedOnly(item)),
      true,
    );
  });

  it("unshelving keeps a card whose work still continues", () => {
    const working = entry("w", { shelved: true, card: card({ kind: "ok", thenWaits: "Deploy" }) });
    const next = predictAct(snapshot({ inbox: [working], shelf: [working] }), unshelve("w"));

    assert.deepEqual(ids(next.inbox), ["w"]);
    assert.equal(next.inbox[0]?.shelved, false);
  });

  it("leavesInbox follows the prediction", () => {
    const asking = snapshot({ inbox: [entry("q", { card: question("q1") }), entry("b")] });

    assert.equal(
      leavesInbox(before, (value) => predictAct(value, ARCHIVE_A), "a"),
      true,
    );
    assert.equal(
      leavesInbox(asking, (value) => predictAct(value, shelve("b")), "b"),
      true,
    );
    assert.equal(
      leavesInbox(asking, (value) => predictAct(value, shelve("q")), "q"),
      false,
    );
  });

  it("an OK card leaves the Inbox but keeps its other rows", () => {
    const next = predictAct(before, {
      action: "ok",
      threadId: "a",
      displayedReceiptIds: ["r1"],
      latch: "l1",
    });

    assert.deepEqual(ids(next.inbox), ["b"]);
    assert.deepEqual(ids(next.shelf), ["a"]);
  });
});

describe("Inbox act outcomes", () => {
  it("maps a stale card to updated and asks for a fresh snapshot", async () => {
    let refreshes = 0;

    const outcome = await inboxOutcome(
      () => Promise.reject({ status: 409, code: "inbox_updated", body: null }),
      () => {
        refreshes += 1;
      },
    );

    assert.deepEqual(outcome, { kind: "updated" });
    assert.equal(refreshes, 1);
  });

  it("surfaces the server's refusal and treats anything else as a failure", async () => {
    const refused = await inboxOutcome(
      () => Promise.reject({ status: 409, code: "retry_unavailable", body: { message: "Busy" } }),
      () => {},
    );

    const failed = await inboxOutcome(
      () => Promise.reject(new Error("offline")),
      () => {},
    );

    assert.deepEqual(refused, { kind: "refused", message: "Busy" });
    assert.deepEqual(failed, { kind: "failed" });
  });

  it("leaves refreshing to core when the move succeeds", async () => {
    let refreshes = 0;

    const outcome = await inboxOutcome(
      () => Promise.resolve({ moveId: "move-1", entry: null }),
      () => {
        refreshes += 1;
      },
    );

    assert.deepEqual(outcome, DONE);
    assert.equal(refreshes, 0);
  });
});

describe("Undo before the move settles", () => {
  it("offers Undo at once only for moves the server can undo", () => {
    assert.equal(offersUndo(ARCHIVE_A), true);
    assert.equal(offersUndo(shelve("a")), true);
    assert.equal(
      offersUndo({ action: "happened", threadId: "w", waitId: "wait-1", note: null }),
      false,
    );
  });

  it("waits for the move, then undoes it by its id", async () => {
    const move = deferred<InboxOutcome | null>();
    const undone: string[] = [];

    const outcome = undoAfter(move.promise, (moveId) => {
      undone.push(moveId);

      return Promise.resolve(DONE);
    });

    await tick();
    assert.deepEqual(undone, []);
    move.resolve(DONE);
    assert.deepEqual(await outcome, DONE);
    assert.deepEqual(undone, ["move-1"]);
  });

  it("skips the undo when the move failed or produced nothing to undo", async () => {
    const undone: string[] = [];

    const undo = (moveId: string) => {
      undone.push(moveId);

      return Promise.resolve(DONE);
    };

    assert.equal(await undoAfter(Promise.resolve({ kind: "failed" }), undo), null);
    assert.equal(
      await undoAfter(Promise.resolve({ kind: "done", moveId: null, entry: null }), undo),
      null,
    );
    assert.equal(await undoAfter(Promise.resolve(null), undo), null);
    assert.deepEqual(undone, []);
  });
});

describe("second command on a pending row", () => {
  it("chains only requests without a latch", () => {
    assert.equal(chainsBehindPending(shelve("a")), true);
    assert.equal(chainsBehindPending(ARCHIVE_A), false);
  });

  it("sends a chained command after the first succeeds and reports idle once", async () => {
    const idle: string[] = [];
    const flights = createInboxFlights((threadId) => idle.push(threadId));
    const first = deferred<InboxOutcome>();
    const sent: string[] = [];

    const one = flights.start(
      "a",
      () => {
        sent.push("shelve");

        return first.promise;
      },
      true,
    );

    const two = flights.start(
      "a",
      () => {
        sent.push("unshelve");

        return Promise.resolve(DONE);
      },
      true,
    );

    await tick();
    assert.deepEqual(sent, ["shelve"]);
    first.resolve(DONE);
    assert.deepEqual(await one, DONE);
    assert.deepEqual(await two, DONE);
    await tick();
    assert.deepEqual(sent, ["shelve", "unshelve"]);
    assert.deepEqual(idle, ["a"]);
  });

  it("drops a chained command when the first one fails", async () => {
    const flights = createInboxFlights(() => {});
    const sent: string[] = [];

    void flights.start("a", () => Promise.resolve({ kind: "failed" }), true);

    const two = flights.start(
      "a",
      () => {
        sent.push("unshelve");

        return Promise.resolve(DONE);
      },
      true,
    );

    assert.equal(await two, null);
    assert.deepEqual(sent, []);
  });
});

describe("pending move Undo preview", () => {
  it("restores only the move target and preserves newer unrelated rows", () => {
    const a = entry("a");
    const b = entry("b");
    const newer = entry("b", { title: "New result" });
    const before = snapshot({ inbox: [a, b], shelf: [a] });
    const moved = snapshot({ inbox: [newer], shelf: [] });
    const restored = restoreThreadRows(moved, before, new Set(["a"]));
    assert.deepEqual(restored.inbox, [a, newer]);
    assert.deepEqual(restored.shelf, [a]);
  });
});
