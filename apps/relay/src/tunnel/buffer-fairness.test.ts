import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { TunnelSession, type StreamOriginResult } from "@omnyo/tunnel-client";
import { TUNNEL_PROTOCOL_QUERY_PARAM } from "@omnyo/tunnel-contract";
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
import { createTunnelRegistry } from "./registry.js";

const MIB = 1024 * 1024;

const GLOBAL_BUDGET = 12 * MIB;

const silentClientLog = { warn: () => {}, info: () => {} };

interface LogEntry {
  event: string;
  fields: Readonly<Record<string, LogFieldValue>>;
}

interface Fixture {
  database: RelayDatabase;
  logs: LogEntry[];
  registry: TunnelRegistry;
  harness: TunnelHarness;
  sessions: TunnelSession[];
  hold: AbortController;
}

let originPort = 0;

let origin: Server;

const fixtures: Fixture[] = [];

const tunnels: WebSocket[] = [];

function resolveOrigin(): StreamOriginResult {
  return {
    kind: "ok",
    resolved: {
      origin: `http://127.0.0.1:${originPort}`,
      publicOrigin: "http://owner.relay.test",
    },
  };
}

function startOrigin(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://origin.local");
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
  });
}

function capturingLogger(entries: LogEntry[]): RelayLogger {
  const record = (event: string, fields = {}) =>
    entries.push({ event, fields });

  return { info: record, warn: record, error: record };
}

async function createFixture(overrides: {
  maxBufferedBytes: number;
  userBufferLimitBytes: number;
}): Promise<Fixture> {
  const database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  const logs: LogEntry[] = [];

  const registry = createTunnelRegistry({
    database,
    log: capturingLogger(logs),
    maxBufferedBytes: overrides.maxBufferedBytes,
    userBufferLimitBytes: overrides.userBufferLimitBytes,
  });

  const harness = await startTunnelHarness(registry);

  const fixture = {
    database,
    logs,
    registry,
    harness,
    sessions: [],
    hold: new AbortController(),
  };

  fixtures.push(fixture);

  return fixture;
}

async function dial(fixture: Fixture, routingKey: string): Promise<void> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${fixture.harness.port}/__tunnel?${TUNNEL_PROTOCOL_QUERY_PARAM}=1`,
    {
      headers: {
        [HARNESS_ROUTING_KEY_HEADER]: routingKey,
        [HARNESS_OWNER_HEADER]: `server:${routingKey}`,
      },
    },
  );

  tunnels.push(socket);

  const session = new TunnelSession({
    tunnel: socket,
    log: silentClientLog,
    resolveOrigin,
  });

  fixture.sessions.push(session);
  socket.once("open", () => session.start());
  await once(socket, "open");
  await waitFor(() => fixture.registry.has(routingKey), 2000);
}

function openUnread(
  fixture: Fixture,
  routingKey: string,
  ownerUserId: string,
  bytes: number,
): Promise<Response> {
  return fixture.registry.openHttpStream({
    routingKey,
    ownerUserId,
    expectedOwner: null,
    target: null,
    grant: { kind: "anonymous" },
    signal: fixture.hold.signal,
    method: "GET",
    path: `/big?bytes=${bytes}`,
    headers: [],
    body: null,
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function clientsIdle(fixture: Fixture): boolean {
  return fixture.sessions.every(
    (session) => session.snapshot(Date.now()).openHttpStreams === 0,
  );
}

async function bodyLength(response: Response): Promise<number> {
  return (await response.arrayBuffer()).byteLength;
}

beforeAll(async () => {
  origin = startOrigin();
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const address = origin.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  originPort = address.port;
});

afterAll(async () => {
  for (const socket of tunnels) socket.terminate();

  for (const fixture of fixtures) {
    fixture.hold.abort();
    fixture.registry.closeAll(1012, "relay restarting");
    await fixture.harness.close();
    fixture.database.close();
  }

  origin.closeAllConnections();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

describe("buffered response data at the global budget", () => {
  it("lets a third owner in when two heavy owners fill the budget, and keeps its data while they refill", async () => {
    const fixture = await createFixture({
      maxBufferedBytes: GLOBAL_BUDGET,
      userBufferLimitBytes: 8 * MIB,
    });

    await dial(fixture, "ta");
    await dial(fixture, "tb");
    await dial(fixture, "tc");

    const heavy = await Promise.all([
      openUnread(fixture, "ta", "ua", 6 * MIB),
      openUnread(fixture, "tb", "ub", 6 * MIB),
    ]);

    expect(heavy.map((response) => response.status)).toEqual([200, 200]);
    await waitFor(
      () => fixture.registry.stats().bufferedBytes >= GLOBAL_BUDGET,
      5000,
    );

    const newcomer = await openUnread(fixture, "tc", "uc", 2 * MIB);

    expect(newcomer.status).toBe(200);
    expect(
      fixture.logs.some(
        (entry) =>
          entry.event === "tunnel.stream_overflow" &&
          entry.fields.cause === "share",
      ),
    ).toBe(true);
    expect(fixture.registry.stats().bufferedBytes).toBeLessThan(GLOBAL_BUDGET);
    await waitFor(() => clientsIdle(fixture), 5000);

    const refills = await Promise.all([
      openUnread(fixture, "ta", "ua", 6 * MIB),
      openUnread(fixture, "tb", "ub", 6 * MIB),
    ]);

    expect(refills.map((response) => response.status)).toEqual([200, 200]);
    await waitFor(() => clientsIdle(fixture), 5000);
    expect(fixture.registry.stats().bufferedBytes).toBeLessThanOrEqual(
      GLOBAL_BUDGET,
    );
    expect(await bodyLength(newcomer)).toBe(2 * MIB);
  });

  it("still refuses an owner that already holds its fair share, so the budget stays a hard limit", async () => {
    const fixture = await createFixture({
      maxBufferedBytes: GLOBAL_BUDGET,
      userBufferLimitBytes: 8 * MIB,
    });

    await dial(fixture, "ta");
    await dial(fixture, "tb");

    await Promise.all([
      openUnread(fixture, "ta", "ua", 6 * MIB),
      openUnread(fixture, "tb", "ub", 6 * MIB),
    ]);
    await waitFor(
      () => fixture.registry.stats().bufferedBytes >= GLOBAL_BUDGET,
      5000,
    );

    const again = await openUnread(fixture, "ta", "ua", 1024);

    expect(again.status).toBe(503);
    expect(await again.text()).toContain("the relay is busy");
    expect(fixture.registry.stats()).toMatchObject({
      bufferedBytes: GLOBAL_BUDGET,
      visitorStreams: 2,
    });
  });

  it("returns an owner's buffered count to zero when the visitor leaves, so the owner is not refused later", async () => {
    const fixture = await createFixture({
      maxBufferedBytes: 192 * MIB,
      userBufferLimitBytes: 4 * MIB,
    });

    await dial(fixture, "solo");

    const buffered = await openUnread(fixture, "solo", "owner", 2 * MIB);

    expect(buffered.status).toBe(200);
    await waitFor(
      () => fixture.registry.stats().bufferedBytes >= 2 * MIB,
      5000,
    );

    fixture.hold.abort();
    await waitFor(() => fixture.registry.stats().bufferedBytes === 0, 5000);
    fixture.hold = new AbortController();

    const recovered = await openUnread(fixture, "solo", "owner", 1024);

    expect(recovered.status).toBe(200);
    expect(await bodyLength(recovered)).toBe(1024);
  });
});
