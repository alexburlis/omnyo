import { describe, expect, it } from "vitest";
import { ActionHistory, type HistoryEntry } from "./action-history";

function trackedEntry(label: string, log: string[]): HistoryEntry {
  return {
    label,
    undo: async () => {
      log.push(`undo ${label}`);
    },
    redo: async () => {
      log.push(`redo ${label}`);
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe("ActionHistory", () => {
  it("notifies subscribers when undo or redo availability changes", async () => {
    const history = new ActionHistory();
    const seen: Array<[boolean, boolean]> = [];

    const stop = history.subscribe(() =>
      seen.push([history.canUndo, history.canRedo]),
    );

    const start = history.getVersion();
    history.record(trackedEntry("a", []));
    await history.undo();
    stop();
    await history.redo();

    expect(seen).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
    expect(history.getVersion()).toBe(start + 5);
  });

  it("undoes newest first and redoes in the original order", async () => {
    const log: string[] = [];
    const history = new ActionHistory();
    history.record(trackedEntry("a", log));
    history.record(trackedEntry("b", log));
    history.record(trackedEntry("c", log));

    await history.undo();
    await history.undo();
    await history.redo();
    await history.undo();
    await history.undo();
    await history.redo();
    await history.redo();
    await history.redo();

    expect(log).toEqual([
      "undo c",
      "undo b",
      "redo b",
      "undo b",
      "undo a",
      "redo a",
      "redo b",
      "redo c",
    ]);
    expect(history.canRedo).toBe(false);
    await expect(history.redo()).resolves.toBeNull();
  });

  it("clears the redo stack when a new action is recorded", async () => {
    const log: string[] = [];
    const history = new ActionHistory();
    history.record(trackedEntry("a", log));
    await history.undo();
    expect(history.canRedo).toBe(true);

    history.record(trackedEntry("b", log));

    expect(history.canRedo).toBe(false);
    await history.undo();
    expect(log).toEqual(["undo a", "undo b"]);
  });

  it("ignores actions recorded by the replay itself", async () => {
    const log: string[] = [];
    const history = new ActionHistory();
    const redoing = trackedEntry("b", log);
    history.record(trackedEntry("a", log));
    history.record({
      ...redoing,
      redo: async () => {
        history.record(trackedEntry("duplicate", log));
        await redoing.redo();
      },
    });
    await history.undo();
    await history.undo();
    await history.redo();
    await history.redo();

    expect(history.canRedo).toBe(false);
    await history.undo();
    await history.undo();
    expect(history.canUndo).toBe(false);
    expect(log).toEqual([
      "undo b",
      "undo a",
      "redo a",
      "redo b",
      "undo b",
      "undo a",
    ]);
  });

  it("retains a new action while an earlier undo waits for the server", async () => {
    const history = new ActionHistory();
    const pending = deferred();
    const log: string[] = [];
    history.record({
      label: "first",
      undo: () => pending.promise,
      redo: async () => {},
    });
    const undoing = history.undo();
    history.record(trackedEntry("second", log));
    pending.resolve();
    await undoing;
    expect(history.canRedo).toBe(false);
    await history.undo();
    expect(log).toEqual(["undo second"]);
  });

  it("keeps a redone action before a new action recorded while redo waits", async () => {
    const history = new ActionHistory();
    const pending = deferred();
    const log: string[] = [];
    history.record({
      ...trackedEntry("first", log),
      redo: () => pending.promise,
    });
    await history.undo();
    const redoing = history.redo();
    history.record(trackedEntry("second", log));
    pending.resolve();
    await redoing;
    await history.undo();
    await history.undo();
    expect(log).toEqual(["undo first", "undo second", "undo first"]);
  });

  it("drops an entry whose undo fails and rethrows the error", async () => {
    const log: string[] = [];
    const history = new ActionHistory();
    const failure = new Error("offline");
    history.record(trackedEntry("a", log));
    history.record({
      label: "b",
      undo: () => Promise.reject(failure),
      redo: () => Promise.resolve(),
    });

    await expect(history.undo()).rejects.toBe(failure);

    expect(history.canRedo).toBe(false);
    await expect(history.undo()).resolves.toMatchObject({ label: "a" });
    expect(log).toEqual(["undo a"]);
  });

  it("undoes a specific entry from the middle of the stack", async () => {
    const log: string[] = [];
    const history = new ActionHistory();
    const middle = trackedEntry("b", log);
    history.record(trackedEntry("a", log));
    history.record(middle);
    history.record(trackedEntry("c", log));

    await history.undoEntry(middle);
    await history.undoEntry(middle);
    await history.undo();
    await history.undo();
    await history.redo();

    expect(log).toEqual(["undo b", "undo c", "undo a", "redo a"]);
    expect(history.peek("redo")?.label).toBe("c");
  });

  it("keeps only the newest 100 entries", async () => {
    const log: string[] = [];
    const history = new ActionHistory();

    for (let index = 0; index < 101; index += 1) {
      history.record(trackedEntry(String(index), log));
    }

    while (history.canUndo) await history.undo();

    expect(log).toHaveLength(100);
    expect(log.at(-1)).toBe("undo 1");
  });

  it("ignores presses while an undo is still running", async () => {
    const history = new ActionHistory();
    const gate = deferred();
    let undoCalls = 0;
    history.record({ label: "a", undo: async () => {}, redo: async () => {} });
    history.record({
      label: "b",
      undo: async () => {
        undoCalls += 1;
        await gate.promise;
      },
      redo: async () => {},
    });

    const first = history.undo();
    const second = history.undo();
    gate.resolve();

    await expect(second).resolves.toBeNull();
    await expect(first).resolves.toMatchObject({ label: "b" });
    expect(undoCalls).toBe(1);
    expect(history.peek("undo")?.label).toBe("a");
  });
  it("forgets an entry from either stack and keeps its neighbours", async () => {
    const log: string[] = [];
    const history = new ActionHistory();
    const middle = trackedEntry("b", log);
    const newest = trackedEntry("c", log);
    const recorded = trackedEntry("d", log);
    history.record(trackedEntry("a", log));
    history.record(middle);
    history.record(newest);
    await history.undo();
    await history.undo();
    history.forget(newest);
    expect(history.peek("redo")?.label).toBe("b");
    history.forget(middle);
    expect(history.canRedo).toBe(false);
    history.record(recorded);
    history.forget(recorded);

    await expect(history.undo()).resolves.toMatchObject({ label: "a" });
    expect(history.canUndo).toBe(false);
    expect(log).toEqual(["undo c", "undo b", "undo a"]);
  });

  it("does not move an entry forgotten during its replay onto the redo stack", async () => {
    const history = new ActionHistory();
    const gate = deferred();

    const entry: HistoryEntry = {
      label: "a",
      undo: () => gate.promise,
      redo: async () => {},
    };

    history.record(entry);
    const undoing = history.undo();
    history.forget(entry);
    gate.resolve();

    await expect(undoing).resolves.toBeNull();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
