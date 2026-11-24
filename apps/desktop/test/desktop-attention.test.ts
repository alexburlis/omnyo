import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDesktopAttentionIpc } from "../src/desktop-attention.js";
import { OMNYO_DESKTOP_SET_ATTENTION_CHANNEL } from "../src/desktop-attention-ipc.js";

const mock = vi.hoisted(() => {
  type Handler = (
    event: { sender: unknown; senderFrame: unknown },
    payload: unknown,
  ) => void;

  const handlers = new Map<string, Handler>();

  return {
    handlers,
    on: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock("electron", () => ({ ipcMain: { on: mock.on } }));

class FakeWebContents extends EventEmitter {
  readonly mainFrame = { name: "main" };

  constructor(readonly id: number) {
    super();
  }
}

const changes: boolean[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  changes.length = 0;
  registerDesktopAttentionIpc({
    applicationWindowWebContentsIds: new Set([1, 2]),
    onChange: (active) => changes.push(active),
  });
});

function send(
  sender: FakeWebContents,
  payload: unknown,
  senderFrame: unknown = sender.mainFrame,
): void {
  const handler = mock.handlers.get(OMNYO_DESKTOP_SET_ATTENTION_CHANNEL);

  if (handler === undefined) throw new Error("attention handler missing");
  handler({ sender, senderFrame }, payload);
}

describe("desktop attention votes", () => {
  it("reports a change only when the first window asks or the last one stops", () => {
    const first = new FakeWebContents(1);
    const second = new FakeWebContents(2);

    send(first, true);
    send(second, true);
    send(first, false);
    send(second, false);

    expect(changes).toEqual([true, false]);
  });

  it("drops a window's vote when it navigates, crashes or closes", () => {
    const first = new FakeWebContents(1);
    const second = new FakeWebContents(2);

    send(first, true);
    first.emit("did-navigate");
    send(first, true);
    first.emit("render-process-gone");
    send(first, true);
    send(second, true);
    first.emit("destroyed");
    second.emit("destroyed");

    expect(changes).toEqual([true, false, true, false, true, false]);
    expect(first.listenerCount("did-navigate")).toBe(1);
  });

  it("ignores invalid payloads, subframes and other web contents", () => {
    const window = new FakeWebContents(1);

    send(window, "yes");
    send(window, true, { name: "child" });
    send(new FakeWebContents(9), true);

    expect(changes).toEqual([]);
  });
});
