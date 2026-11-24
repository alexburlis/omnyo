import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { machineRoutingKey } from "@omnyo/connect-db";
import { TunnelSession, type StreamOriginResult } from "@omnyo/tunnel-client";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
  TUNNEL_REPLACED_CLOSE_REASON,
} from "@omnyo/tunnel-contract";
import type {
  LogFieldValue,
  RelayLogger,
  TunnelRegistry,
} from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import {
  HARNESS_EXPECTED_OWNER_HEADER,
  HARNESS_OWNER_HEADER,
  HARNESS_ROUTING_KEY_HEADER,
  HARNESS_TARGET_HEADER,
  startTunnelHarness,
  type TunnelHarness,
} from "./harness.js";
import { TUNNEL_OFFLINE_HEADER } from "./protocol-headers.js";
import {
  PORT_SHARE_TOO_OLD,
  STREAM_OVERFLOW_CLOSE_CODE,
  STREAM_OVERFLOW_MESSAGE,
  TUNNEL_REVOKED_CLOSE_REASON,
  createTunnelRegistry,
} from "./registry.js";

const MIB = 1024 * 1024;

const HTML = `<!doctype html><title>omnyo</title>${"<p>relayed body</p>".repeat(50)}`;

const GZIP = gzipSync(Buffer.from(HTML));

const PORT_SHARE_BODY = "port share 8000";

const SERVER_KEY = "alice";

const SERVER_OWNER = "server:s1";

const MACHINE_KEY = machineRoutingKey("bob", "gen1");

const MACHINE_OWNER = "machine:m1";

interface LogEntry {
  level: "info" | "warn" | "error";
  event: string;
  fields: Readonly<Record<string, LogFieldValue>>;
}

function capturingLogger(entries: LogEntry[]): RelayLogger {
  const record =
    (level: LogEntry["level"]) =>
    (event: string, fields: Readonly<Record<string, LogFieldValue>> = {}) =>
      entries.push({ level, event, fields });

  return { info: record("info"), warn: record("warn"), error: record("error") };
}

const silentClientLog = { warn: () => {}, info: () => {} };

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function startOrigin(): { server: Server; wss: WebSocketServer } {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => [...offered][0] ?? false,
  });

  wss.on("connection", (socket, request) => {
    if (request.url?.startsWith("/ws-flood") === true) {
      const chunk = Buffer.alloc(MIB, 7);

      for (let index = 0; index < 40; index += 1) socket.send(chunk);

      return;
    }

    if (request.url?.startsWith("/ws-big") === true) {
      const bytes = Number(
        new URL(request.url, "http://origin.local").searchParams.get("bytes"),
      );

      socket.send(Buffer.alloc(bytes, 4));

      return;
    }

    socket.on("message", (data, isBinary) =>
      socket.send(data, { binary: isBinary }),
    );
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://origin.local");

    if (url.pathname === "/hello") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "x-origin-host": request.headers.host ?? "",
      });
      response.end("hello from origin");

      return;
    }

    if (url.pathname === "/echo") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      request.pipe(response);

      return;
    }

    if (url.pathname === "/gzip") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": String(GZIP.byteLength),
      });
      response.end(GZIP);

      return;
    }

    if (url.pathname === "/drip") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(1024, 2));

      const timer = setInterval(
        () => response.write(Buffer.alloc(1024, 2)),
        50,
      );

      response.once("close", () => clearInterval(timer));

      return;
    }

    if (url.pathname === "/big") {
      const total = Number(url.searchParams.get("bytes"));
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let written = 0;

      const writeNext = () => {
        while (written < total) {
          const size = Math.min(256 * 1024, total - written);
          written += size;

          if (!response.write(Buffer.alloc(size, 3))) {
            response.once("drain", writeNext);

            return;
          }
        }

        response.end();
      };

      response.once("close", () => {
        written = total;
      });
      writeNext();

      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.on("upgrade", (request, socket, head) =>
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws, request),
    ),
  );

  return { server, wss };
}

interface Visit {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  elapsedMs: number;
}

interface VisitOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

function visit(
  port: number,
  path: string,
  options: VisitOptions = {},
): Promise<Visit> {
  const startedAt = performance.now();

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            elapsedMs: performance.now() - startedAt,
          }),
        );
        response.once("error", reject);
      },
    );

    request.once("error", reject);
    request.end(options.body);
  });
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

interface DialedTunnel {
  socket: WebSocket;
  session: TunnelSession;
}

interface Fixture {
  database: RelayDatabase;
  logs: LogEntry[];
  registry: TunnelRegistry;
  harness: TunnelHarness;
}

let originPort = 0;

let portSharePort = 0;

let origin: ReturnType<typeof startOrigin>;

let portShare: Server;

const fixtures: Fixture[] = [];

const tunnels: WebSocket[] = [];

function resolveOrigin(target: string | undefined): StreamOriginResult {
  if (target === undefined) {
    return {
      kind: "ok",
      resolved: {
        origin: `http://127.0.0.1:${originPort}`,
        publicOrigin: "http://alice.relay.test",
      },
    };
  }

  if (target === "8000") {
    return {
      kind: "ok",
      resolved: {
        origin: `http://127.0.0.1:${portSharePort}`,
        publicOrigin: "http://bob--8000.relay.test",
        host: "127.0.0.1:8000",
      },
    };
  }

  return { kind: "unregistered" };
}

function seed(database: RelayDatabase): void {
  const created = Date.UTC(2026, 10, 1);
  database.sqlite
    .prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("u1", "Owner", "owner@example.com", created, created);
  database.sqlite
    .prepare(
      "INSERT INTO server (id, user_id, name, subdomain, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("s1", "u1", "default", "alice", created);
  database.sqlite
    .prepare(
      "INSERT INTO machine (id, user_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("m1", "u1", "laptop", "unused-hash", created);
}

async function createFixture(
  overrides: {
    returnGraceMs?: number;
    maxBufferedBytes?: number;
    silenceLimitMs?: number;
    tunnelBacklogLimitBytes?: number;
    userBufferLimitBytes?: number;
  } = {},
): Promise<Fixture> {
  const database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  seed(database);
  const logs: LogEntry[] = [];

  const registry = createTunnelRegistry({
    database,
    log: capturingLogger(logs),
    maxBufferedBytes: overrides.maxBufferedBytes ?? 192 * MIB,
    ...(overrides.returnGraceMs !== undefined
      ? { returnGraceMs: overrides.returnGraceMs }
      : {}),
    ...(overrides.silenceLimitMs !== undefined
      ? { silenceLimitMs: overrides.silenceLimitMs }
      : {}),
    ...(overrides.tunnelBacklogLimitBytes !== undefined
      ? { tunnelBacklogLimitBytes: overrides.tunnelBacklogLimitBytes }
      : {}),
    ...(overrides.userBufferLimitBytes !== undefined
      ? { userBufferLimitBytes: overrides.userBufferLimitBytes }
      : {}),
  });

  const harness = await startTunnelHarness(registry);
  const fixture = { database, logs, registry, harness };
  fixtures.push(fixture);

  return fixture;
}

async function dial(
  fixture: Fixture,
  routingKey: string,
  owner: string,
  protocolVersion: number = PROTOCOL_VERSION,
): Promise<DialedTunnel> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${fixture.harness.port}/__tunnel?${TUNNEL_PROTOCOL_QUERY_PARAM}=${protocolVersion}`,
    {
      headers: {
        [HARNESS_ROUTING_KEY_HEADER]: routingKey,
        [HARNESS_OWNER_HEADER]: owner,
      },
    },
  );

  tunnels.push(socket);

  const session = new TunnelSession({
    tunnel: socket,
    log: silentClientLog,
    resolveOrigin,
  });

  socket.once("open", () => session.start());
  await once(socket, "open");

  return { socket, session };
}

function heartbeatAck(socket: WebSocket): Promise<number> {
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary || data.toString() !== HEARTBEAT_RESPONSE) return;
      socket.off("message", onMessage);
      resolve(performance.now() - startedAt);
    };

    socket.on("message", onMessage);
    socket.send(HEARTBEAT_REQUEST);
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const route = (routingKey: string, extra: Record<string, string> = {}) => ({
  [HARNESS_ROUTING_KEY_HEADER]: routingKey,
  ...extra,
});

let main: Fixture;

beforeAll(async () => {
  origin = startOrigin();
  originPort = await listen(origin.server);
  portShare = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(PORT_SHARE_BODY);
  });
  portSharePort = await listen(portShare);
  main = await createFixture();
});

afterAll(async () => {
  for (const socket of tunnels) socket.terminate();

  for (const fixture of fixtures) {
    fixture.registry.closeAll(1012, "relay restarting");
    await fixture.harness.close();
    fixture.database.close();
  }

  for (const client of origin.wss.clients) client.terminate();
  await closeServer(origin.server);
  await closeServer(portShare);
});

describe("tunnel registry round trip (P1)", () => {
  it("answers 503 offline at once when no tunnel ever connected", async () => {
    const page = await visit(main.harness.port, "/", {
      headers: route("nobody", { accept: "text/html" }),
    });

    expect(page.status).toBe(503);
    expect(page.headers[TUNNEL_OFFLINE_HEADER]).toBe("1");
    expect(page.headers.refresh).toBe("10");
    expect(page.body.toString()).toContain(
      '<meta http-equiv="refresh" content="10">',
    );
    expect(page.elapsedMs).toBeLessThan(1000);

    const api = await visit(main.harness.port, "/api", {
      headers: route("nobody"),
    });

    expect(api.status).toBe(503);
    expect(api.headers[TUNNEL_OFFLINE_HEADER]).toBe("1");
    expect(api.headers["content-type"]).toContain("text/plain");
  });

  it("relays GET, a 3 MiB POST and gzip bytes unchanged, and records presence", async () => {
    await dial(main, SERVER_KEY, SERVER_OWNER);

    const hello = await visit(main.harness.port, "/hello?x=1", {
      headers: route(SERVER_KEY),
    });

    expect(hello.status).toBe(200);
    expect(hello.body.toString()).toBe("hello from origin");

    const seen = main.database.sqlite
      .prepare("SELECT last_seen_at FROM server WHERE id = ?")
      .get("s1");

    expect(seen).toMatchObject({ last_seen_at: expect.any(Number) });

    const upload = randomBytes(3 * MIB);

    const echoed = await visit(main.harness.port, "/echo", {
      method: "POST",
      headers: route(SERVER_KEY, {
        "content-type": "application/octet-stream",
        "content-length": String(upload.byteLength),
      }),
      body: upload,
    });

    expect(echoed.status).toBe(200);
    expect(echoed.body.byteLength).toBe(upload.byteLength);
    expect(sha256(echoed.body)).toBe(sha256(upload));

    const gzip = await visit(main.harness.port, "/gzip", {
      headers: route(SERVER_KEY, { "accept-encoding": "gzip" }),
    });

    expect(gzip.status).toBe(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(Buffer.compare(gzip.body, GZIP)).toBe(0);
  });

  it("echoes a visitor WebSocket with the negotiated subprotocol", async () => {
    const visitor = new WebSocket(
      `ws://127.0.0.1:${main.harness.port}/ws-echo`,
      ["omnyo.test"],
      { headers: route(SERVER_KEY) },
    );

    await once(visitor, "open");
    expect(visitor.protocol).toBe("omnyo.test");

    const replies: Array<{ data: Buffer; isBinary: boolean }> = [];
    visitor.on("message", (data: Buffer, isBinary: boolean) =>
      replies.push({ data, isBinary }),
    );
    const binary = randomBytes(64 * 1024);
    visitor.send("ping text");
    visitor.send(binary);
    await waitFor(() => replies.length === 2, 3000);

    expect(replies[0]).toMatchObject({ isBinary: false });
    expect(replies[0]?.data.toString()).toBe("ping text");
    expect(replies[1]?.isBinary).toBe(true);
    expect(sha256(replies[1]?.data ?? Buffer.alloc(0))).toBe(sha256(binary));

    visitor.close(1000, "done");
    await once(visitor, "close");
    await waitFor(() => main.registry.stats().visitorStreams === 0, 2000);
  });

  it("serves a --8000 port share over a machine tunnel and checks owner and protocol", async () => {
    await dial(main, MACHINE_KEY, MACHINE_OWNER);

    const shared = await visit(main.harness.port, "/", {
      headers: route(MACHINE_KEY, {
        [HARNESS_TARGET_HEADER]: "8000",
        [HARNESS_EXPECTED_OWNER_HEADER]: MACHINE_OWNER,
      }),
    });

    expect(shared.status).toBe(200);
    expect(shared.body.toString()).toBe(PORT_SHARE_BODY);

    const mismatch = await visit(main.harness.port, "/", {
      headers: route(MACHINE_KEY, {
        [HARNESS_EXPECTED_OWNER_HEADER]: "machine:someone-else",
      }),
    });

    expect(mismatch.status).toBe(503);
    expect(mismatch.headers[TUNNEL_OFFLINE_HEADER]).toBe("1");

    await dial(main, "old-client", "server:s1", 0);

    const tooOld = await visit(main.harness.port, "/", {
      headers: route("old-client", { [HARNESS_TARGET_HEADER]: "8000" }),
    });

    expect(tooOld.status).toBe(502);
    expect(tooOld.body.toString()).toContain(PORT_SHARE_TOO_OLD);
  });

  it("replaces an existing tunnel with the replaced close reason", async () => {
    const first = await dial(main, "replace-me", SERVER_OWNER);
    const closed = once(first.socket, "close");
    await dial(main, "replace-me", SERVER_OWNER);
    const [code, reason] = (await closed) as [number, Buffer];

    expect(code).toBe(1000);
    expect(reason.toString()).toBe(TUNNEL_REPLACED_CLOSE_REASON);

    const served = await visit(main.harness.port, "/hello", {
      headers: route("replace-me"),
    });

    expect(served.status).toBe(200);
  });

  it("holds a visitor while a lost tunnel returns within the grace period", async () => {
    const lost = await dial(main, "flaky", SERVER_OWNER);
    const closed = once(lost.socket, "close");
    lost.socket.terminate();
    await closed;
    await waitFor(() => !main.registry.has("flaky"), 2000);

    const waiting = visit(main.harness.port, "/hello", {
      headers: route("flaky"),
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    await dial(main, "flaky", SERVER_OWNER);
    const served = await waiting;

    expect(served.status).toBe(200);
    expect(served.body.toString()).toBe("hello from origin");
    expect(served.elapsedMs).toBeGreaterThanOrEqual(250);
  });

  it("closes only the overflowing stream and keeps heartbeats flowing", async () => {
    const tunnel = await dial(main, "slow", SERVER_OWNER);
    const abort = new AbortController();

    const response = await main.registry.openHttpStream({
      routingKey: "slow",
      ownerUserId: "slow",
      expectedOwner: null,
      target: null,
      grant: { kind: "anonymous" },
      signal: abort.signal,
      method: "GET",
      path: `/big?bytes=${32 * MIB}`,
      headers: [],
      body: null,
    });

    expect(response.status).toBe(200);
    await waitFor(
      () => main.logs.some((entry) => entry.event === "tunnel.stream_overflow"),
      5000,
    );

    const reader = response.body?.getReader();
    await expect(reader?.read()).rejects.toThrow(STREAM_OVERFLOW_MESSAGE);
    expect(main.registry.stats().visitorStreams).toBe(0);
    expect(main.registry.stats().bufferedBytes).toBe(0);
    expect(await heartbeatAck(tunnel.socket)).toBeLessThan(1000);
    expect(tunnel.socket.readyState).toBe(WebSocket.OPEN);

    const after = await visit(main.harness.port, "/hello", {
      headers: route("slow"),
    });

    expect(after.status).toBe(200);
  });

  it("closes a slow visitor WebSocket with 1009 when its buffer overflows", async () => {
    const visitor = new WebSocket(
      `ws://127.0.0.1:${main.harness.port}/ws-flood`,
      { headers: route(SERVER_KEY) },
    );

    await once(visitor, "open");
    visitor.pause();
    await waitFor(
      () =>
        main.logs.some(
          (entry) =>
            entry.event === "tunnel.stream_overflow" &&
            entry.fields.kind === "ws",
        ),
      5000,
    );
    const closed = once(visitor, "close");
    visitor.resume();
    const [code] = (await closed) as [number, Buffer];

    expect(code).toBe(STREAM_OVERFLOW_CLOSE_CODE);
  });

  it("relays an origin WebSocket message above 4 MiB and overflows only that stream past the stream limit", async () => {
    const tunnel = await dial(main, "big-ws", SERVER_OWNER);

    const delivered = new WebSocket(
      `ws://127.0.0.1:${main.harness.port}/ws-big?bytes=${6 * MIB}`,
      { headers: route("big-ws") },
    );

    const [message] = (await once(delivered, "message")) as [Buffer];
    expect(message.byteLength).toBe(6 * MIB);
    delivered.close(1000, "done");
    await once(delivered, "close");

    const oversized = new WebSocket(
      `ws://127.0.0.1:${main.harness.port}/ws-big?bytes=${8 * MIB + 512 * 1024}`,
      { headers: route("big-ws") },
    );

    const [code] = (await once(oversized, "close")) as [number, Buffer];

    expect(code).toBe(STREAM_OVERFLOW_CLOSE_CODE);
    expect(tunnel.socket.readyState).toBe(WebSocket.OPEN);
    expect(await heartbeatAck(tunnel.socket)).toBeLessThan(1000);
    expect(main.registry.has("big-ws")).toBe(true);
  });

  it("closes a revoked tunnel with the owner reason and ends its visitor streams at once", async () => {
    const tunnel = await dial(main, "revoke-me", SERVER_OWNER);
    const tunnelClosed = once(tunnel.socket, "close");

    const visitor = new WebSocket(
      `ws://127.0.0.1:${main.harness.port}/ws-echo`,
      { headers: route("revoke-me") },
    );

    await once(visitor, "open");
    const visitorClosed = once(visitor, "close");

    const streaming = await main.registry.openHttpStream({
      routingKey: "revoke-me",
      ownerUserId: "revoke-me",
      expectedOwner: null,
      target: null,
      grant: { kind: "anonymous" },
      signal: new AbortController().signal,
      method: "GET",
      path: "/drip",
      headers: [],
      body: null,
    });

    expect(streaming.status).toBe(200);
    const reader = streaming.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);

    const lost = await dial(main, "revoke-waiting", SERVER_OWNER);
    lost.socket.terminate();
    await waitFor(() => !main.registry.has("revoke-waiting"), 2000);

    const waiting = visit(main.harness.port, "/hello", {
      headers: route("revoke-waiting"),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = performance.now();
    main.registry.close("revoke-me", TUNNEL_REVOKED_CLOSE_REASON);
    main.registry.close("revoke-waiting", TUNNEL_REVOKED_CLOSE_REASON);

    const [tunnelCode, tunnelReason] = (await tunnelClosed) as [number, Buffer];
    expect(tunnelCode).toBe(1000);
    expect(tunnelReason.toString()).toBe(TUNNEL_REVOKED_CLOSE_REASON);

    const [visitorCode] = (await visitorClosed) as [number, Buffer];
    expect(visitorCode).toBe(1001);

    await expect(
      (async () => {
        for (;;) {
          const next = await reader?.read();

          if (next === undefined || next.done) return "ended";
        }
      })(),
    ).rejects.toThrow("tunnel closed by the relay");

    const offline = await waiting;
    expect(offline.status).toBe(503);
    expect(offline.headers[TUNNEL_OFFLINE_HEADER]).toBe("1");
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(main.registry.has("revoke-me")).toBe(false);
    await waitFor(() => main.registry.stats().visitorStreams === 0, 2000);
  });

  it("terminates a tunnel that stops reading while visitors upload and releases its backlog", async () => {
    const stalled = await createFixture({ tunnelBacklogLimitBytes: 4 * MIB });
    const tunnel = await dial(stalled, "stalled", SERVER_OWNER);
    const closed = once(tunnel.socket, "close");

    const visitors = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const visitor = new WebSocket(
          `ws://127.0.0.1:${stalled.harness.port}/ws-echo`,
          { headers: route("stalled") },
        );

        visitor.on("error", () => {});
        await once(visitor, "open");

        return visitor;
      }),
    );

    tunnel.socket.pause();
    const beat = setInterval(() => tunnel.socket.send(HEARTBEAT_REQUEST), 100);
    const upload = randomBytes(MIB);

    for (const visitor of visitors) {
      for (let index = 0; index < 8; index += 1) visitor.send(upload);
    }

    await waitFor(
      () =>
        stalled.logs.some(
          (entry) =>
            entry.event === "tunnel.write_backlog" &&
            entry.fields.cause === "tunnel",
        ),
      8000,
    );
    clearInterval(beat);
    tunnel.socket.resume();
    await closed;

    expect(stalled.registry.has("stalled")).toBe(false);
    await waitFor(
      () => stalled.registry.stats().tunnelBacklogBytes === 0,
      2000,
    );
    await waitFor(() => stalled.registry.stats().visitorStreams === 0, 2000);
    expect(stalled.registry.stats().bufferedBytes).toBe(0);

    for (const visitor of visitors) visitor.terminate();
  });

  it("answers offline after the grace period and enforces the global buffer budget", async () => {
    const small = await createFixture({
      returnGraceMs: 200,
      maxBufferedBytes: 6 * MIB,
    });

    const lost = await dial(small, "gone", SERVER_OWNER);
    lost.socket.terminate();
    await waitFor(() => !small.registry.has("gone"), 2000);

    const offline = await visit(small.harness.port, "/hello", {
      headers: route("gone"),
    });

    expect(offline.status).toBe(503);
    expect(offline.headers[TUNNEL_OFFLINE_HEADER]).toBe("1");
    expect(offline.elapsedMs).toBeGreaterThanOrEqual(150);

    await dial(small, "budget", SERVER_OWNER);

    const open = (path: string) =>
      small.registry.openHttpStream({
        routingKey: "budget",
        ownerUserId: "budget",
        expectedOwner: null,
        target: null,
        grant: { kind: "anonymous" },
        signal: new AbortController().signal,
        method: "GET",
        path,
        headers: [],
        body: null,
      });

    const [first, second] = await Promise.all([
      open(`/big?bytes=${5 * MIB}`),
      open(`/big?bytes=${5 * MIB}`),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await waitFor(
      () =>
        small.logs.some(
          (entry) =>
            entry.event === "tunnel.stream_overflow" &&
            entry.fields.cause === "budget",
        ),
      5000,
    );
    expect(small.registry.stats().bufferedBytes).toBeLessThanOrEqual(6 * MIB);
  });

  it("keeps one user's unread responses from crowding out another user", async () => {
    const shared = await createFixture({ userBufferLimitBytes: 6 * MIB });
    await dial(shared, "hog-a", SERVER_OWNER);
    await dial(shared, "hog-b", SERVER_OWNER);
    await dial(shared, "fair", SERVER_OWNER);

    const open = (routingKey: string) =>
      shared.registry.openHttpStream({
        routingKey,
        ownerUserId: "hog",
        expectedOwner: null,
        target: null,
        grant: { kind: "anonymous" },
        signal: new AbortController().signal,
        method: "GET",
        path: `/big?bytes=${5 * MIB}`,
        headers: [],
        body: null,
      });

    const [first, second] = await Promise.all([open("hog-a"), open("hog-b")]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await waitFor(
      () =>
        shared.logs.some(
          (entry) =>
            entry.event === "tunnel.stream_overflow" &&
            entry.fields.cause === "user",
        ),
      5000,
    );

    const fair = await visit(shared.harness.port, "/hello", {
      headers: route("fair"),
    });

    expect(fair.status).toBe(200);
  });

  it("terminates a silent tunnel but keeps one that sends heartbeats", async () => {
    const quiet = await createFixture({ silenceLimitMs: 300 });
    const silent = await dial(quiet, "silent", SERVER_OWNER);
    const chatty = await dial(quiet, "chatty", SERVER_OWNER);
    const beat = setInterval(() => chatty.socket.send(HEARTBEAT_REQUEST), 100);
    const [code] = (await once(silent.socket, "close")) as [number, Buffer];
    clearInterval(beat);

    expect(code).toBe(1006);
    await waitFor(() => !quiet.registry.has("silent"), 2000);
    expect(quiet.registry.has("chatty")).toBe(true);
    expect(quiet.logs.some((entry) => entry.event === "tunnel.silent")).toBe(
      true,
    );
  });
});
