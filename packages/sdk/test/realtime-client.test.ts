import { expect, it, vi } from "vitest";
import { resolveRealtimeUrl } from "../src/realtime-url.js";
import { createOmnyoSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import type { OmnyoRealtimeSocket } from "../src/transport.js";

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
