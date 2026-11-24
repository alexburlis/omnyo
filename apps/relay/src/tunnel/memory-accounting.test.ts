import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  MAX_CHUNK_BYTES,
  TUNNEL_PROTOCOL_QUERY_PARAM,
  decodeFrame,
  encodeFrame,
  type Frame,
} from "@omnyo/tunnel-contract";
import type { TunnelRegistry } from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { meteredBody } from "../gate/streams.js";
import { sourceMigrationDirectories } from "../migrations.js";
import {
  HARNESS_OWNER_HEADER,
  HARNESS_ROUTING_KEY_HEADER,
  startTunnelHarness,
  type TunnelHarness,
} from "./harness.js";
import { createTunnelRegistry } from "./registry.js";

const MIB = 1024 * 1024;

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

interface Fixture {
  database: RelayDatabase;
  registry: TunnelRegistry;
  harness: TunnelHarness;
  sockets: WebSocket[];
  hold: AbortController;
}

const fixtures: Fixture[] = [];

async function createFixture(): Promise<Fixture> {
  const database = openRelayDatabase(":memory:", sourceMigrationDirectories());

  const registry = createTunnelRegistry({
    database,
    log: silentLog,
    maxBufferedBytes: 192 * MIB,
  });

  const fixture = {
    database,
    registry,
    harness: await startTunnelHarness(registry),
    sockets: [],
    hold: new AbortController(),
  };

  fixtures.push(fixture);

  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.hold.abort();
    fixture.registry.closeAll(1001, "test over");

    for (const socket of fixture.sockets) socket.terminate();
    await fixture.harness.close();
    fixture.database.close();
  }
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function rawTunnel(
  fixture: Fixture,
  routingKey: string,
  onFrame: (frame: Frame, socket: WebSocket) => void,
): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${fixture.harness.port}/__tunnel?${TUNNEL_PROTOCOL_QUERY_PARAM}=1`,
    {
      headers: {
        [HARNESS_ROUTING_KEY_HEADER]: routingKey,
        [HARNESS_OWNER_HEADER]: `server:${routingKey}`,
      },
    },
  );

  fixture.sockets.push(socket);
  socket.on("message", (data, isBinary) => {
    if (isBinary) onFrame(decodeFrame(data as Buffer), socket);
  });
  await once(socket, "open");
  await waitFor(() => fixture.registry.has(routingKey));

  return socket;
}

function openGet(fixture: Fixture, routingKey: string): Promise<Response> {
  return fixture.registry.openHttpStream({
    routingKey,
    ownerUserId: routingKey,
    expectedOwner: null,
    target: null,
    grant: { kind: "anonymous" },
    signal: fixture.hold.signal,
    method: "GET",
    path: "/big",
    headers: [],
    body: null,
  });
}

function respondHead(socket: WebSocket, streamId: number): void {
  socket.send(
    encodeFrame({
      type: "resp-head",
      streamId,
      status: 200,
      headers: [["content-type", "application/octet-stream"]],
    }),
  );
}

function sendChunk(socket: WebSocket, streamId: number, bytes: number): void {
  socket.send(
    encodeFrame({
      type: "body-chunk",
      streamId,
      data: new Uint8Array(bytes),
    }),
  );
}

describe("response bytes handed to the consumer", () => {
  it("stay charged until the consumer asks for the next chunk, and the stream releases them at the end", async () => {
    const fixture = await createFixture();
    let streamId = 0;

    const tunnel = await rawTunnel(fixture, "owner", (frame, socket) => {
      if (frame.type !== "open-http") return;
      streamId = frame.streamId;
      respondHead(socket, streamId);
    });

    const response = await openGet(fixture, "owner");
    const reader = response.body?.getReader();

    if (reader === undefined) throw new Error("expected a body");
    const first = reader.read();
    sendChunk(tunnel, streamId, MAX_CHUNK_BYTES);
    expect((await first).value?.byteLength).toBe(MAX_CHUNK_BYTES);
    expect(fixture.registry.stats().bufferedBytes).toBe(MAX_CHUNK_BYTES);

    sendChunk(tunnel, streamId, MAX_CHUNK_BYTES / 2);
    await waitFor(
      () =>
        fixture.registry.stats().bufferedBytes ===
        MAX_CHUNK_BYTES + MAX_CHUNK_BYTES / 2,
    );

    expect((await reader.read()).value?.byteLength).toBe(MAX_CHUNK_BYTES / 2);
    expect(fixture.registry.stats().bufferedBytes).toBe(MAX_CHUNK_BYTES / 2);

    tunnel.send(encodeFrame({ type: "body-end", streamId }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.registry.stats().visitorStreams).toBe(1);

    expect((await reader.read()).done).toBe(true);
    expect(fixture.registry.stats().bufferedBytes).toBe(0);
    expect(fixture.registry.stats().visitorStreams).toBe(0);
  });

  it("ends the stream when the tunnel sends a body-chunk above MAX_CHUNK_BYTES", async () => {
    const fixture = await createFixture();

    const tunnel = await rawTunnel(fixture, "owner", (frame, socket) => {
      if (frame.type !== "open-http") return;
      respondHead(socket, frame.streamId);
      const oversized = new Uint8Array(5 + MAX_CHUNK_BYTES + 1);
      oversized[0] = 2;
      new DataView(oversized.buffer).setUint32(1, frame.streamId);
      socket.send(oversized);
    });

    const response = await openGet(fixture, "owner");

    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(fixture.registry.stats().bufferedBytes).toBe(0);
    expect(tunnel.readyState).toBe(WebSocket.OPEN);
  });

  it("end the metered visitor body as soon as the registry ends the stream, without waiting for another read", async () => {
    const fixture = await createFixture();
    let streamId = 0;

    const tunnel = await rawTunnel(fixture, "owner", (frame, socket) => {
      if (frame.type !== "open-http") return;
      streamId = frame.streamId;
      respondHead(socket, streamId);
    });

    const response = await openGet(fixture, "owner");

    if (response.body === null) throw new Error("expected a body");
    let outcome: string | null = null;

    const metered = meteredBody(
      response.body,
      () => undefined,
      (end) => {
        outcome = end;
      },
    );

    const reader = metered.stream.getReader();
    const first = reader.read();
    sendChunk(tunnel, streamId, MAX_CHUNK_BYTES);
    expect((await first).value?.byteLength).toBe(MAX_CHUNK_BYTES);

    let closed: "pending" | "rejected" = "pending";
    reader.closed.catch(() => {
      closed = "rejected";
    });
    tunnel.terminate();

    await waitFor(() => closed === "rejected");
    expect(outcome).toBe("aborted");
    expect(fixture.registry.stats().bufferedBytes).toBe(0);
  });

  it("are not read ahead by the egress meter", async () => {
    let pulls = 0;

    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(16));
        },
      },
      { highWaterMark: 0 },
    );

    const metered = meteredBody(
      source,
      () => undefined,
      () => undefined,
    );

    const reader = metered.stream.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pulls).toBe(1);
    await reader.cancel();
  });
});

describe("a visitor WebSocket that overflows", () => {
  it("keeps its unsent bytes charged until the visitor socket closes", async () => {
    const fixture = await createFixture();
    await rawTunnel(fixture, "owner", (frame, socket) => {
      if (frame.type !== "open-ws") return;
      socket.send(
        encodeFrame({
          type: "ws-open-ack",
          streamId: frame.streamId,
          protocol: null,
        }),
      );

      for (let index = 0; index < 24; index += 1) {
        socket.send(
          encodeFrame({
            type: "ws-data",
            streamId: frame.streamId,
            isBinary: true,
            data: new Uint8Array(MIB),
          }),
        );
      }
    });

    const visitor = new WebSocket(`ws://127.0.0.1:${fixture.harness.port}/ws`, {
      headers: { [HARNESS_ROUTING_KEY_HEADER]: "owner" },
    });

    fixture.sockets.push(visitor);
    visitor.on("upgrade", (incoming) => incoming.socket.pause());
    await once(visitor, "open");
    await waitFor(() => fixture.registry.stats().visitorStreams === 0);

    expect(fixture.registry.stats().bufferedBytes).toBeGreaterThan(MIB);

    visitor.terminate();
    await waitFor(() => fixture.registry.stats().bufferedBytes === 0);
  });
});

describe("control traffic a tunnel does not read", () => {
  it("gets no automatic pong for a ping", async () => {
    const fixture = await createFixture();
    const tunnel = await rawTunnel(fixture, "owner", () => undefined);
    let pongs = 0;
    tunnel.on("pong", () => {
      pongs += 1;
    });

    tunnel.ping(Buffer.from("x"));
    const ack = once(tunnel, "message");
    tunnel.send(HEARTBEAT_REQUEST);
    const [data] = await ack;

    expect(String(data)).toBe(HEARTBEAT_RESPONSE);
    expect(pongs).toBe(0);
  });

  it("keeps at most one heartbeat reply waiting to be written", async () => {
    const fixture = await createFixture();
    const tunnel = await rawTunnel(fixture, "owner", () => undefined);
    let acks = 0;
    tunnel.on("message", (_data, isBinary) => {
      if (!isBinary) acks += 1;
    });

    for (let index = 0; index < 200; index += 1) tunnel.send(HEARTBEAT_REQUEST);
    await waitFor(() => acks > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(acks).toBeLessThan(200);
    const before = acks;
    tunnel.send(HEARTBEAT_REQUEST);
    await waitFor(() => acks > before);
  });
});

class FakeVisitor extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  isPaused = false;
  readonly pongs: (() => void)[] = [];

  pong(_data: unknown, _mask: unknown, done: () => void): void {
    this.pongs.push(done);
  }

  send(): void {}

  pause(): void {}

  resume(): void {}

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.close();
  }
}

describe("pings from a visitor WebSocket", () => {
  it("are answered with at most one pong waiting to be written", async () => {
    const fixture = await createFixture();
    await rawTunnel(fixture, "owner", (frame, socket) => {
      if (frame.type !== "open-ws") return;
      socket.send(
        encodeFrame({
          type: "ws-open-ack",
          streamId: frame.streamId,
          protocol: null,
        }),
      );
    });

    const result = await fixture.registry.openWsStream({
      routingKey: "owner",
      ownerUserId: "owner",
      expectedOwner: null,
      target: null,
      grant: { kind: "anonymous" },
      signal: fixture.hold.signal,
      path: "/ws",
      headers: [],
      protocols: [],
    });

    if (result.kind !== "accepted") throw new Error("expected an accept");
    const visitor = new FakeVisitor();
    result.bind(visitor as unknown as WebSocket);

    for (let index = 0; index < 50; index += 1)
      visitor.emit("ping", Buffer.alloc(0));
    expect(visitor.pongs).toHaveLength(1);

    visitor.pongs[0]?.();
    visitor.emit("ping", Buffer.alloc(0));
    expect(visitor.pongs).toHaveLength(2);
    visitor.close();
  });
});
