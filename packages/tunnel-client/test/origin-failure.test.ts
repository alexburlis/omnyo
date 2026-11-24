import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket as NodeWebSocket } from "ws";
import {
  InvalidFrameError,
  decodeFrame,
  encodeFrame,
  type Frame,
} from "@omnyo/tunnel-contract";
import { TunnelSession } from "../src/session.js";

class FakeTunnel extends EventEmitter {
  readonly readyState = 1;
  readonly frames: Frame[] = [];
  readonly terminate = vi.fn();

  send(data: Uint8Array): void {
    this.frames.push(decodeFrame(data));
  }
}

async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return address.port;
}

describe("tunnel origin failures", () => {
  it("logs the failed request without its query string", async () => {
    const port = await closedLoopbackPort();
    const tunnel = new FakeTunnel();
    const warnings: string[] = [];

    const session = new TunnelSession({
      tunnel: tunnel as unknown as NodeWebSocket,
      log: { warn: (message) => warnings.push(message) },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: `http://127.0.0.1:${port}`,
          publicOrigin: "https://handle.example.test",
        },
      }),
    });

    session.start();

    tunnel.emit(
      "message",
      Buffer.from(
        encodeFrame({
          type: "open-http",
          streamId: 7,
          method: "POST",
          path: "/api/v1/plugins/demo/http/hook?token=secret-token",
          headers: [],
          hasBody: false,
        }),
      ),
      true,
    );

    await vi.waitFor(() => {
      expect(tunnel.frames).toContainEqual(
        expect.objectContaining({ type: "close-stream", streamId: 7 }),
      );
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^origin http error on POST \/api\/v1\/plugins\/demo\/http\/hook: .*ECONNREFUSED/u,
    );
    expect(warnings[0]).not.toContain("secret-token");
    session.dispose();
  });

  it("tells the relay to close a stream whose frame it cannot decode, so the slot is freed at once", () => {
    const tunnel = new FakeTunnel();
    const warnings: string[] = [];

    const session = new TunnelSession({
      tunnel: tunnel as unknown as NodeWebSocket,
      log: { warn: (message) => warnings.push(message) },
      resolveOrigin: () => ({ kind: "unregistered" }),
    });

    session.start();

    const malformed = new Uint8Array([1, 0, 0, 0, 9, 123, 34]);

    expect(() => decodeFrame(malformed)).toThrow(InvalidFrameError);
    tunnel.emit("message", Buffer.from(malformed), true);

    expect(tunnel.frames).toEqual([
      {
        type: "close-stream",
        streamId: 9,
        code: 1011,
        reason: "invalid frame",
      },
    ]);
    expect(warnings).toHaveLength(1);
    session.dispose();
  });

  it("sends one origin request when the relay repeats body-end", async () => {
    let requests = 0;

    const origin = createHttpServer((_request, response) => {
      requests += 1;
      response.end("ok");
    });

    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", resolve),
    );
    const address = origin.address() as AddressInfo;
    const tunnel = new FakeTunnel();

    const session = new TunnelSession({
      tunnel: tunnel as unknown as NodeWebSocket,
      log: { warn: () => {} },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: `http://127.0.0.1:${address.port}`,
          publicOrigin: "https://handle.example.test",
        },
      }),
    });

    try {
      session.start();

      const send = (frame: Frame) =>
        tunnel.emit("message", Buffer.from(encodeFrame(frame)), true);

      send({
        type: "open-http",
        streamId: 13,
        method: "POST",
        path: "/api/v1/echo",
        headers: [],
        hasBody: true,
      });
      send({ type: "body-end", streamId: 13 });
      send({ type: "body-end", streamId: 13 });

      await vi.waitFor(() => {
        expect(tunnel.frames).toContainEqual(
          expect.objectContaining({ type: "body-end", streamId: 13 }),
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(requests).toBe(1);
    } finally {
      session.dispose();
      origin.close();
    }
  });

  it("closes the stream without an unhandled rejection when a failed request's path cannot be parsed", async () => {
    const port = await closedLoopbackPort();
    const tunnel = new FakeTunnel();
    const warnings: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);

    process.on("unhandledRejection", onUnhandled);

    const session = new TunnelSession({
      tunnel: tunnel as unknown as NodeWebSocket,
      log: { warn: (message) => warnings.push(message) },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: `http://127.0.0.1:${port}`,
          publicOrigin: "https://handle.example.test",
        },
      }),
    });

    try {
      session.start();

      tunnel.emit(
        "message",
        Buffer.from(
          encodeFrame({
            type: "open-http",
            streamId: 11,
            method: "GET",
            path: "//[",
            headers: [],
            hasBody: false,
          }),
        ),
        true,
      );

      await vi.waitFor(() => {
        expect(tunnel.frames).toContainEqual(
          expect.objectContaining({ type: "close-stream", streamId: 11 }),
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandled).toEqual([]);
      expect(warnings.join("\n")).toContain("(unparseable path)");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      session.dispose();
    }
  });
});
