import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedWatchManager } from "./workspace-observer-client.js";
import type { WorkspaceObserverResponse } from "./workspace-observer-protocol.js";

type SentCommand = { kind: string; id: number } & Record<string, unknown>;

class FakeObserverChild extends EventEmitter {
  readonly pid = undefined;
  connected = true;
  readonly sent: SentCommand[] = [];

  send(command: SentCommand, callback?: (error: Error | null) => void) {
    this.sent.push(command);
    callback?.(null);
    queueMicrotask(() =>
      this.reply({
        kind: "result",
        id: command.id,
        workspaceWatches: 0,
        threadStorageTargets: 0,
      }),
    );

    return true;
  }

  reply(message: WorkspaceObserverResponse) {
    this.emit("message", message);
  }

  kill() {
    this.connected = false;

    return true;
  }

  disconnect() {
    this.connected = false;
  }

  unref() {}
}

const { children } = vi.hoisted(() => ({
  children: [] as FakeObserverChild[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();

  return {
    ...original,
    fork: () => {
      const child = new FakeObserverChild();
      children.push(child);
      queueMicrotask(() => child.reply({ kind: "ready" }));

      return child;
    },
  };
});

const managers: { shutdown: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  children.length = 0;
});

describe("createIsolatedWatchManager thread-storage watches", () => {
  it("sends each thread's storage path and routes changes by watch id", async () => {
    const manager = createIsolatedWatchManager({
      logger: { warn: () => undefined },
      threadStorageRootPath: "/storage",
    });

    managers.push(manager);
    const onFirstChange = vi.fn();
    const onSecondChange = vi.fn();

    manager.hostWatcher.watchThreadStorage({
      threadStoragePath: "/storage/thr_first",
      onChange: onFirstChange,
      onWatchError: () => undefined,
    });
    manager.hostWatcher.watchThreadStorage({
      threadStoragePath: "/storage/thr_second",
      onChange: onSecondChange,
      onWatchError: () => undefined,
    });

    await vi.waitFor(() =>
      expect(
        children[0]?.sent.filter((command) => command.kind === "watch"),
      ).toHaveLength(2),
    );

    const child = children[0];

    if (child === undefined) throw new Error("Observer child did not start");
    const watches = child.sent.filter((command) => command.kind === "watch");

    expect(watches.map((command) => command.watch)).toEqual([
      { kind: "thread-storage", rootPath: "/storage/thr_first" },
      { kind: "thread-storage", rootPath: "/storage/thr_second" },
    ]);

    const secondWatchId = watches[1]?.watchId;

    if (typeof secondWatchId !== "number")
      throw new Error("Watch command has no watch id");
    child.reply({ kind: "watch-storage-change", watchId: secondWatchId });

    expect(onSecondChange).toHaveBeenCalledTimes(1);
    expect(onFirstChange).not.toHaveBeenCalled();
  });
});
