import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type {
  LogFieldValue,
  RelayLogger,
  TunnelRegistry,
} from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { createTunnelRegistry } from "./registry.js";

const KIB = 1024;

const BUDGET = 2048 * KIB;

const UPLOAD = 512 * KIB;

interface LogEntry {
  event: string;
  fields: Readonly<Record<string, LogFieldValue>>;
}

interface StalledTunnel {
  client: WebSocket;
  framesSent: () => number;
}

interface Fixture {
  database: RelayDatabase;
  logs: LogEntry[];
  registry: TunnelRegistry;
  server: WebSocketServer;
  port: number;
  clients: WebSocket[];
  hold: AbortController;
}

const fixtures: Fixture[] = [];

function capturingLogger(entries: LogEntry[]): RelayLogger {
  const record = (event: string, fields = {}) =>
    entries.push({ event, fields });

  return { info: record, warn: record, error: record };
}

async function createFixture(): Promise<Fixture> {
  const database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  const logs: LogEntry[] = [];

  const registry = createTunnelRegistry({
    database,
    log: capturingLogger(logs),
    maxBufferedBytes: BUDGET,
  });

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  const fixture = {
    database,
    logs,
    registry,
    server,
    port: address.port,
    clients: [],
    hold: new AbortController(),
  };

  fixtures.push(fixture);

  return fixture;
}

async function attachStalledTunnel(
  fixture: Fixture,
  routingKey: string,
): Promise<StalledTunnel> {
  let frames = 0;

  fixture.server.once("connection", (socket) => {
    socket.send = (_data: unknown, _options?: unknown, _done?: unknown) => {
      frames += 1;
    };

    fixture.registry.attach({
      routingKey,
      owner: { kind: "server", serverId: routingKey },
      protocolVersion: 1,
      socket,
    });
  });

  const client = new WebSocket(`ws://127.0.0.1:${fixture.port}`);
  fixture.clients.push(client);
  await once(client, "open");
  await waitFor(() => fixture.registry.has(routingKey));

  return { client, framesSent: () => frames };
}

function openUpload(
  fixture: Fixture,
  routingKey: string,
  ownerUserId: string,
): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(UPLOAD));
    },
  });

  return fixture.registry.openHttpStream({
    routingKey,
    ownerUserId,
    expectedOwner: null,
    target: null,
    grant: { kind: "anonymous" },
    signal: fixture.hold.signal,
    method: "POST",
    path: "/upload",
    headers: [],
    body,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settledWithin(
  response: Promise<Response>,
  ms: number,
): Promise<Response | null> {
  return Promise.race([
    response,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.hold.abort();
    fixture.registry.closeAll(1001, "test over");

    for (const client of fixture.clients) client.terminate();
    fixture.server.close();
    fixture.database.close();
  }
});

describe("tunnel write backlog at the global budget", () => {
  it("lets a new owner in when one owner's stalled uploads fill the budget, and drops that owner's stalled tunnel", async () => {
    const fixture = await createFixture();
    const heavy = await attachStalledTunnel(fixture, "heavy");
    const newcomer = await attachStalledTunnel(fixture, "newcomer");

    for (let index = 1; index <= BUDGET / UPLOAD; index += 1) {
      void openUpload(fixture, "heavy", "heavy-user");
      await waitFor(
        () => fixture.registry.stats().tunnelBacklogBytes > index * UPLOAD,
      );
    }

    expect(fixture.registry.stats().bufferedBytes).toBe(0);
    expect(fixture.registry.stats().tunnelBacklogBytes).toBeGreaterThan(BUDGET);

    const heavyClosed = once(heavy.client, "close");
    const framesBefore = newcomer.framesSent();
    const admitted = openUpload(fixture, "newcomer", "newcomer-user");

    await waitFor(() => newcomer.framesSent() > framesBefore);
    expect(await settledWithin(admitted, 50)).toBeNull();
    await heavyClosed;

    expect(
      fixture.logs.some(
        (entry) =>
          entry.event === "tunnel.write_backlog" &&
          entry.fields.cause === "share" &&
          entry.fields.routingKey === "heavy",
      ),
    ).toBe(true);
  });

  it("still refuses the owner whose stalled uploads already hold the whole budget", async () => {
    const fixture = await createFixture();
    await attachStalledTunnel(fixture, "heavy");

    for (let index = 1; index <= BUDGET / UPLOAD; index += 1) {
      void openUpload(fixture, "heavy", "heavy-user");
      await waitFor(
        () => fixture.registry.stats().tunnelBacklogBytes > index * UPLOAD,
      );
    }

    const refused = await openUpload(fixture, "heavy", "heavy-user");

    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain("the relay is busy");
    expect(fixture.registry.stats().tunnelBacklogBytes).toBeGreaterThan(BUDGET);
  });
});
