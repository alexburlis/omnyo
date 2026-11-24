import { once } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  MAX_CONTROL_FRAME_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
  decodeFrame,
  encodeFrame,
  type Frame,
} from "@omnyo/tunnel-contract";
import type {
  LogFieldValue,
  RelayLogger,
  TunnelRegistry,
} from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import {
  HARNESS_OWNER_HEADER,
  HARNESS_ROUTING_KEY_HEADER,
  startTunnelHarness,
  type TunnelHarness,
} from "./harness.js";
import {
  INVALID_FRAME_MESSAGE,
  MAX_INVALID_FRAMES_PER_TUNNEL,
  createTunnelRegistry,
} from "./registry.js";

const FRAME_TYPE_CODE = { "resp-head": 4, "ws-open-ack": 6, "close-stream": 8 };

const VICTIM_BODY = "victim ok";

const INJECTED_PROTOCOL = "omnyo.v1\r\nx-planted: 1";

type LogFields = Readonly<Record<string, LogFieldValue>>;

interface LogEntry {
  level: "info" | "warn" | "error";
  event: string;
  fields: LogFields;
}

interface Fixture {
  database: RelayDatabase;
  logs: LogEntry[];
  registry: TunnelRegistry;
  harness: TunnelHarness;
}

type FrameHandler = (socket: WebSocket, frame: Frame) => void;

const fixtures: Fixture[] = [];

const sockets: WebSocket[] = [];

function logger(
  entries: LogEntry[],
  throwOn: (event: string, fields: LogFields) => boolean,
): RelayLogger {
  const record =
    (level: LogEntry["level"]) =>
    (event: string, fields: LogFields = {}) => {
      entries.push({ level, event, fields });

      if (throwOn(event, fields)) throw new TypeError(`injected ${event}`);
    };

  return { info: record("info"), warn: record("warn"), error: record("error") };
}

async function createFixture(
  options: {
    streamBufferLimitBytes?: number;
    throwOn?: (event: string, fields: LogFields) => boolean;
  } = {},
): Promise<Fixture> {
  const database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  const logs: LogEntry[] = [];

  const registry = createTunnelRegistry({
    database,
    log: logger(logs, options.throwOn ?? (() => false)),
    maxBufferedBytes: 64 * 1024 * 1024,
    ...(options.streamBufferLimitBytes !== undefined
      ? { streamBufferLimitBytes: options.streamBufferLimitBytes }
      : {}),
  });

  const harness = await startTunnelHarness(registry);
  const fixture = { database, logs, registry, harness };
  fixtures.push(fixture);

  return fixture;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function dialRaw(
  fixture: Fixture,
  routingKey: string,
  onFrame: FrameHandler,
): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${fixture.harness.port}/__tunnel?${TUNNEL_PROTOCOL_QUERY_PARAM}=${PROTOCOL_VERSION}`,
    {
      headers: {
        [HARNESS_ROUTING_KEY_HEADER]: routingKey,
        [HARNESS_OWNER_HEADER]: `server:${routingKey}`,
      },
    },
  );

  sockets.push(socket);
  socket.on("error", () => {});
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) onFrame(socket, decodeFrame(new Uint8Array(data)));
  });
  await once(socket, "open");
  await waitFor(() => fixture.registry.has(routingKey), 2000);

  return socket;
}

function rawControlFrame(
  type: keyof typeof FRAME_TYPE_CODE,
  streamId: number,
  payload: string,
): Buffer {
  const bytes = Buffer.from(payload, "utf8");
  const out = Buffer.alloc(5 + bytes.length);
  out[0] = FRAME_TYPE_CODE[type];
  out.writeUInt32BE(streamId, 1);
  bytes.copy(out, 5);

  return out;
}

function answerOk(socket: WebSocket, streamId: number): void {
  socket.send(
    encodeFrame({
      type: "resp-head",
      streamId,
      status: 200,
      headers: [["content-type", "text/plain"]],
    }),
  );
  socket.send(
    encodeFrame({
      type: "body-chunk",
      streamId,
      data: Buffer.from(VICTIM_BODY),
    }),
  );
  socket.send(encodeFrame({ type: "body-end", streamId }));
}

interface Visit {
  status: number;
  body: string;
}

function visit(
  fixture: Fixture,
  routingKey: string,
  path: string,
): Promise<Visit | "timed out"> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: fixture.harness.port,
        path,
        headers: { [HARNESS_ROUTING_KEY_HEADER]: routingKey },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        response.once("error", reject);
      },
    );

    request.setTimeout(2000, () => {
      request.destroy();
      resolve("timed out");
    });
    request.once("error", reject);
    request.end();
  });
}

function heartbeatAcked(socket: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.readyState !== WebSocket.OPEN) {
      resolve(false);

      return;
    }

    const timer = setTimeout(() => finish(false), 1000);

    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (!isBinary && data.toString() === HEARTBEAT_RESPONSE) finish(true);
    };

    const onClose = () => finish(false);

    function finish(acked: boolean): void {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      resolve(acked);
    }

    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.send(HEARTBEAT_REQUEST);
  });
}

function openDirect(
  registry: TunnelRegistry,
  routingKey: string,
  path: string,
  body: ReadableStream<Uint8Array> | null = null,
): Promise<Response> {
  return registry.openHttpStream({
    routingKey,
    ownerUserId: routingKey,
    expectedOwner: null,
    target: null,
    grant: { kind: "anonymous" },
    signal: new AbortController().signal,
    method: body === null ? "GET" : "POST",
    path,
    headers: [],
    body,
  });
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  return Promise.race([
    promise,
    new Promise<"timed out">((resolve) =>
      setTimeout(() => resolve("timed out"), ms),
    ),
  ]);
}

const INVALID_HEADS: ReadonlyArray<readonly [string, string]> = [
  [
    "204 with an invalid header name",
    '{"status":204,"headers":[["bad name","x"]]}',
  ],
  [
    "304 with a CRLF header value",
    '{"status":304,"headers":[["x-a","a\\r\\nb"]]}',
  ],
  ["200 with null headers", '{"status":200,"headers":null}'],
  ["200 with numeric headers", '{"status":200,"headers":42}'],
  ["200 with a numeric header name", '{"status":200,"headers":[[7,"x"]]}'],
  [
    "304 with a one-element header pair",
    '{"status":304,"headers":[["only-one"]]}',
  ],
  [
    "200 with a control character Node cannot write",
    '{"status":200,"headers":[["x-a","a\\u0001b"]]}',
  ],
  ["status 99", '{"status":99,"headers":[]}'],
  ["a string status", '{"status":"200","headers":[]}'],
  ["a payload that is not an object", "[]"],
  [
    "a payload above the control frame limit",
    JSON.stringify({
      status: 200,
      headers: [["x-pad", "a".repeat(MAX_CONTROL_FRAME_PAYLOAD_BYTES)]],
    }),
  ],
];

const casePayloads = new Map(
  INVALID_HEADS.map(([, payload], index) => [`/case/${index}`, payload]),
);

let shared: Fixture;

let mallory: WebSocket;

function answerMallory(socket: WebSocket, frame: Frame): void {
  if (frame.type === "open-http") {
    const payload = casePayloads.get(frame.path);

    if (payload !== undefined) {
      socket.send(rawControlFrame("resp-head", frame.streamId, payload));

      return;
    }

    if (frame.path === "/override-type") {
      socket.send(
        rawControlFrame(
          "resp-head",
          frame.streamId,
          '{"type":"body-chunk","data":{"byteLength":5},"status":200,"headers":[["content-type","text/plain"]]}',
        ),
      );
      socket.send(encodeFrame({ type: "body-end", streamId: frame.streamId }));

      return;
    }

    if (frame.path === "/bad-close") {
      socket.send(
        rawControlFrame(
          "close-stream",
          frame.streamId,
          '{"code":"x","reason":7}',
        ),
      );
    }

    return;
  }

  if (frame.type !== "open-ws") return;

  if (frame.path === "/ws-inject") {
    socket.send(
      rawControlFrame(
        "ws-open-ack",
        frame.streamId,
        JSON.stringify({ protocol: INJECTED_PROTOCOL }),
      ),
    );

    return;
  }

  socket.send(
    encodeFrame({
      type: "ws-open-ack",
      streamId: frame.streamId,
      protocol: null,
    }),
  );
  socket.send(
    rawControlFrame(
      "resp-head",
      frame.streamId,
      '{"type":"ws-data","isBinary":true,"data":"x","status":200,"headers":[]}',
    ),
  );
}

beforeAll(async () => {
  shared = await createFixture();
  await dialRaw(shared, "victim", (socket, frame) => {
    if (frame.type === "open-http") answerOk(socket, frame.streamId);
  });
  mallory = await dialRaw(shared, "mallory", answerMallory);
});

afterAll(async () => {
  for (const socket of sockets) socket.terminate();

  for (const fixture of fixtures) {
    fixture.registry.closeAll(1012, "relay restarting");
    await fixture.harness.close();
    fixture.database.close();
  }
});

describe("a tunnel client's invalid frames end only its own stream", () => {
  it.each(INVALID_HEADS.map(([name], index) => [name, index] as const))(
    "answers 502 for a resp-head with %s and keeps every tunnel serving",
    async (_name, index) => {
      const outcome = await visit(shared, "mallory", `/case/${index}`);

      expect(outcome).toMatchObject({ status: 502 });
      expect(outcome === "timed out" ? "" : outcome.body).toContain(
        INVALID_FRAME_MESSAGE,
      );
      expect(await heartbeatAcked(mallory)).toBe(true);
      expect(await visit(shared, "victim", "/after")).toEqual({
        status: 200,
        body: VICTIM_BODY,
      });
      expect(shared.registry.stats().visitorStreams).toBe(0);
      expect(
        shared.logs.some(
          (entry) =>
            entry.event === "tunnel.bad_frame" &&
            entry.fields.routingKey === "mallory" &&
            entry.fields.stream === true,
        ),
      ).toBe(true);
    },
  );

  it("treats payload keys as data, so a resp-head cannot pose as another frame type", async () => {
    expect(await visit(shared, "mallory", "/override-type")).toEqual({
      status: 200,
      body: "",
    });
  });

  it("answers 502 for a close-stream whose code and reason have the wrong types", async () => {
    expect(await visit(shared, "mallory", "/bad-close")).toMatchObject({
      status: 502,
    });
    expect(await heartbeatAcked(mallory)).toBe(true);
  });

  it("refuses a WebSocket ack whose protocol would add headers to the visitor's handshake", async () => {
    const visitor = new WebSocket(
      `ws://127.0.0.1:${shared.harness.port}/ws-inject`,
      ["omnyo.v1"],
      { headers: { [HARNESS_ROUTING_KEY_HEADER]: "mallory" } },
    );

    visitor.on("error", () => {});
    sockets.push(visitor);

    const outcome = await new Promise<{
      status: number;
      headers: IncomingHttpHeaders;
    }>((resolve) => {
      visitor.once("upgrade", (response) =>
        resolve({ status: 101, headers: response.headers }),
      );
      visitor.once("unexpected-response", (_request, response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
        });
        response.resume();
      });
    });

    expect(outcome.status).toBe(502);
    expect(outcome.headers["x-planted"]).toBeUndefined();
  });

  it("keeps buffer accounting numeric when a resp-head for a WebSocket stream carries data keys", async () => {
    const visitor = new WebSocket(
      `ws://127.0.0.1:${shared.harness.port}/ws-plain`,
      { headers: { [HARNESS_ROUTING_KEY_HEADER]: "mallory" } },
    );

    sockets.push(visitor);
    await once(visitor, "open");
    expect(await heartbeatAcked(mallory)).toBe(true);
    expect(shared.registry.stats().bufferedBytes).toBe(0);
    visitor.close(1000, "done");
    await once(visitor, "close");
  });
});

describe("a throw while handling a frame", () => {
  it("closes only the tunnel that sent the frame and ends its streams", async () => {
    const fixture = await createFixture({
      streamBufferLimitBytes: 64 * 1024,
      throwOn: (event, fields) =>
        event === "tunnel.stream_overflow" && fields.routingKey === "breaker",
    });

    const healthy = await dialRaw(fixture, "healthy", (socket, frame) => {
      if (frame.type === "open-http") answerOk(socket, frame.streamId);
    });

    const breaker = await dialRaw(fixture, "breaker", (socket, frame) => {
      if (frame.type !== "open-http") return;
      socket.send(
        encodeFrame({
          type: "resp-head",
          streamId: frame.streamId,
          status: 200,
          headers: [],
        }),
      );
      socket.send(
        encodeFrame({
          type: "body-chunk",
          streamId: frame.streamId,
          data: new Uint8Array(128 * 1024),
        }),
      );
    });

    const closed = once(breaker, "close");
    const response = await openDirect(fixture.registry, "breaker", "/big");

    expect(response.status).toBe(200);
    expect(await within(closed, 2000)).not.toBe("timed out");
    await expect(response.text()).rejects.toThrow(
      "tunnel disconnected mid-request",
    );
    expect(fixture.registry.has("breaker")).toBe(false);
    expect(fixture.registry.stats()).toMatchObject({
      tunnels: 1,
      visitorStreams: 0,
      bufferedBytes: 0,
    });
    expect(
      fixture.logs.some(
        (entry) =>
          entry.level === "error" &&
          entry.event === "tunnel.frame_failed" &&
          entry.fields.routingKey === "breaker",
      ),
    ).toBe(true);
    expect(await heartbeatAcked(healthy)).toBe(true);
    expect(await visit(fixture, "healthy", "/after")).toEqual({
      status: 200,
      body: VICTIM_BODY,
    });
  });
});

describe("a tunnel client that keeps sending invalid frames", () => {
  it("is kept below the limit and dropped, with one log line per frame, once it reaches it", async () => {
    const fixture = await createFixture();
    const tunnel = await dialRaw(fixture, "noisy", () => {});
    const garbage = rawControlFrame("resp-head", 999, "not json");

    for (let index = 0; index < MAX_INVALID_FRAMES_PER_TUNNEL - 1; index += 1) {
      tunnel.send(garbage);
    }

    expect(await heartbeatAcked(tunnel)).toBe(true);
    expect(fixture.registry.has("noisy")).toBe(true);

    const closed = once(tunnel, "close");
    tunnel.send(garbage);
    expect(await within(closed, 2000)).not.toBe("timed out");

    await waitFor(() => !fixture.registry.has("noisy"), 2000);

    expect(
      fixture.logs.filter((entry) => entry.event === "tunnel.bad_frame"),
    ).toHaveLength(MAX_INVALID_FRAMES_PER_TUNNEL);

    expect(
      fixture.logs.filter((entry) => entry.event === "tunnel.bad_frame_limit"),
    ).toHaveLength(1);
  });
});

describe("registry paths that nothing awaits", () => {
  it("ends a stream whose request body cannot be read", async () => {
    const fixture = await createFixture();
    const closes: Frame[] = [];

    await dialRaw(fixture, "uploads", (_socket, frame) => {
      if (frame.type === "close-stream") closes.push(frame);
    });

    const locked = new ReadableStream<Uint8Array>();
    locked.getReader();

    const response = await within(
      openDirect(fixture.registry, "uploads", "/upload", locked),
      2000,
    );

    expect(response === "timed out" ? response : response.status).toBe(502);
    await waitFor(() => closes.length === 1, 2000);
    expect(closes[0]).toMatchObject({ type: "close-stream", code: 1011 });
    expect(fixture.registry.stats().visitorStreams).toBe(0);
  });

  it("forwards a path that is not a valid relative URL instead of leaking its stream", async () => {
    const fixture = await createFixture();
    const paths: string[] = [];

    await dialRaw(fixture, "odd-paths", (socket, frame) => {
      if (frame.type !== "open-http") return;
      paths.push(frame.path);
      answerOk(socket, frame.streamId);
    });

    const response = await within(
      openDirect(fixture.registry, "odd-paths", "//["),
      2000,
    );

    if (response === "timed out") throw new Error("the stream was not opened");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(VICTIM_BODY);
    expect(paths).toEqual(["//["]);
    expect(fixture.registry.stats().visitorStreams).toBe(0);
  });
});
