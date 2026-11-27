import { expect, it, vi } from "vitest";
import { resolveRealtimeUrl } from "../src/realtime-url.js";
import { createOmnyoSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import type { OmnyoRealtimeSocket } from "../src/transport.js";

it("retains shared targets across reconnect and closes only after the final idempotent cleanup", async () => {
  vi.useFakeTimers();

  try {
    const sockets: OmnyoRealtimeSocket[] = [];
    const frames: string[][] = [];
    const closed: number[] = [];
    const connections: string[] = [];

    const sdk = createOmnyoSdk({
      transport: createHttpTransport({
        baseUrl: "http://omnyo.test",
        runtime: "node",
        websocket: () => {
          const index = sockets.length;
          const sent: string[] = [];

          const socket: OmnyoRealtimeSocket = {
            readyState: 0,
            onclose: null,
            onerror: null,
            onmessage: null,
            onopen: null,
            send(message) {
              sent.push(message);
            },
            close() {
              closed.push(index);
            },
          };

          frames.push(sent);
          sockets.push(socket);

          return socket;
        },
      }),
    });

    const stopConnections = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        connections.push(event.state);
      },
    });

    const first = sdk.subscribe({
      event: "thread:changed",
      threadId: "t1",
      callback() {},
    });

    const second = sdk.subscribe({
      event: "thread:changed",
      threadId: "t1",
      callback() {},
    });

    const project = sdk.subscribe({ event: "project:changed", callback() {} });
    const socket = sockets[0];

    if (!socket) throw new Error("Expected initial socket");
    socket.readyState = 1;
    socket.onopen?.();

    const threadSubscribe = JSON.stringify({
      type: "subscribe",
      target: { kind: "thread-detail", threadId: "t1" },
    });

    const projectSubscribe = JSON.stringify({
      type: "subscribe",
      target: { kind: "project-list" },
    });

    expect(frames[0]).toEqual([threadSubscribe, projectSubscribe]);
    expect(connections.at(-1)).toBe("connected");
    socket.readyState = 3;
    socket.onclose?.();
    first();
    first();
    project();
    project();
    await vi.advanceTimersByTimeAsync(1000);
    const replacement = sockets[1];

    if (!replacement) throw new Error("Expected replacement socket");
    replacement.readyState = 1;
    replacement.onopen?.();
    expect(frames[1]).toEqual([threadSubscribe]);
    second();
    second();
    expect(frames[1]).toEqual([
      threadSubscribe,
      JSON.stringify({
        type: "unsubscribe",
        target: { kind: "thread-detail", threadId: "t1" },
      }),
    ]);
    expect(closed).toEqual([1]);
    expect(connections.at(-1)).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    stopConnections();
  } finally {
    vi.useRealTimers();
  }
});

it("names the Omnyo SDK when realtime has no absolute URL", () => {
  const transport = createHttpTransport({ baseUrl: "/", runtime: "node" });

  expect(() => resolveRealtimeUrl({ transport })).toThrow(
    "Omnyo SDK realtime requires an absolute baseUrl or realtimeUrl in this runtime.",
  );
});

it("closes a failing socket once even when close reports another error", () => {
  let closes = 0;
  const sockets: OmnyoRealtimeSocket[] = [];

  const sdk = createOmnyoSdk({
    transport: createHttpTransport({
      baseUrl: "http://omnyo.test",
      runtime: "node",
      websocket: () => {
        const socket: OmnyoRealtimeSocket = {
          close() {
            closes += 1;
            socket.onerror?.();
          },
          onclose: null,
          onerror: null,
          onmessage: null,
          onopen: null,
          readyState: 0,
          send() {},
        };

        sockets.push(socket);

        return socket;
      },
    }),
  });

  const unsubscribe = sdk.subscribe({
    event: "thread:changed",
    callback: () => {},
  });

  const [socket] = sockets;
  expect(socket).toBeDefined();
  expect(() => socket?.onerror?.()).not.toThrow();
  expect(closes).toBe(1);
  unsubscribe();
});

it("reconnects after a first connection fails without a close event", async () => {
  vi.useFakeTimers();

  try {
    const sockets: OmnyoRealtimeSocket[] = [];

    const sdk = createOmnyoSdk({
      transport: createHttpTransport({
        baseUrl: "http://omnyo.test",
        runtime: "node",
        websocket: () => {
          const socket: OmnyoRealtimeSocket = {
            close() {},
            onclose: null,
            onerror: null,
            onmessage: null,
            onopen: null,
            readyState: 0,
            send() {},
          };

          sockets.push(socket);

          return socket;
        },
      }),
    });

    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      callback: () => {},
    });

    expect(sockets).toHaveLength(1);
    sockets[0]?.onerror?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBeGreaterThan(1);
    unsubscribe();
  } finally {
    vi.useRealTimers();
  }
});
