import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  MAX_CONTROL_FRAME_PAYLOAD_BYTES,
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
  REQUEST_HEADERS_TOO_LARGE_MESSAGE,
  createTunnelRegistry,
  type TunnelRegistryOptions,
} from "./registry.js";

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
  bytesSent: () => number;
  completeWrites: () => void;
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

async function createFixture(
  options: Partial<TunnelRegistryOptions> = {},
): Promise<Fixture> {
  const database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  const logs: LogEntry[] = [];

  const registry = createTunnelRegistry({
    database,
    log: capturingLogger(logs),
    maxBufferedBytes: BUDGET,
    ...options,
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
  options: { pauseClient: boolean } = { pauseClient: false },
): Promise<StalledTunnel> {
  let frames = 0;
  let bytes = 0;
  const pending: ((error?: Error) => void)[] = [];

  fixture.server.once("connection", (socket) => {
    socket.send = (data: unknown, done?: unknown) => {
      frames += 1;
      bytes += (data as Uint8Array).byteLength;

      if (typeof done === "function") {
        pending.push(done as (error?: Error) => void);
      }
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

  if (options.pauseClient) client.pause();

  return {
    client,
    framesSent: () => frames,
    bytesSent: () => bytes,
    completeWrites: () => {
      for (const done of pending.splice(0)) done();
    },
  };
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

function openGet(
  fixture: Fixture,
  routingKey: string,
  ownerUserId: string,
  headers: [string, string][] = [],
  signal: AbortSignal = fixture.hold.signal,
): Promise<Response> {
  return fixture.registry.openHttpStream({
    routingKey,
    ownerUserId,
    expectedOwner: null,
    target: null,
    grant: { kind: "anonymous" },
    signal,
    method: "GET",
    path: "/page",
    headers,
    body: null,
  });
}

async function fillBudgetWithStalledUploads(
  fixture: Fixture,
  routingKey: string,
  ownerUserId: string,
): Promise<void> {
  for (let index = 1; index <= BUDGET / UPLOAD; index += 1) {
    void openUpload(fixture, routingKey, ownerUserId);
    await waitFor(
      () => fixture.registry.stats().tunnelBacklogBytes > index * UPLOAD,
    );
  }
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

describe("a retired tunnel's write backlog", () => {
  const retirements: [string, (fixture: Fixture) => Promise<void>][] = [
    [
      "replaced by a reconnect",
      async (fixture) => {
        await attachStalledTunnel(fixture, "heavy");
      },
    ],
    [
      "closed by the relay",
      async (fixture) => {
        fixture.registry.close("heavy", "revoked by owner");
      },
    ],
    [
      "closed by a relay shutdown",
      async (fixture) => {
        fixture.registry.closeAll(1001, "shutting down");
      },
    ],
  ];

  it.each(retirements)(
    "is released at once and its socket terminated when the tunnel is %s",
    async (_name, retire) => {
      const fixture = await createFixture();

      const heavy = await attachStalledTunnel(fixture, "heavy", {
        pauseClient: true,
      });

      await fillBudgetWithStalledUploads(fixture, "heavy", "heavy-user");
      expect(fixture.registry.stats().tunnelBacklogBytes).toBeGreaterThan(
        BUDGET,
      );

      const heavyClosed = once(heavy.client, "close");
      await retire(fixture);

      expect(fixture.registry.stats().tunnelBacklogBytes).toBe(0);
      const [code] = await heavyClosed;
      expect(code).toBe(1006);
    },
  );

  it("lets a newcomer in after the owner reconnects its tunnel while it holds backlog", async () => {
    const fixture = await createFixture();

    const heavy = await attachStalledTunnel(fixture, "heavy", {
      pauseClient: true,
    });

    await fillBudgetWithStalledUploads(fixture, "heavy", "heavy-user");
    const heavyClosed = once(heavy.client, "close");
    const replacement = await attachStalledTunnel(fixture, "heavy");
    expect(fixture.registry.stats().tunnelBacklogBytes).toBe(0);
    await heavyClosed;

    const framesBefore = replacement.framesSent();
    const admitted = openGet(fixture, "heavy", "other-user");

    await waitFor(() => replacement.framesSent() > framesBefore);
    expect(await settledWithin(admitted, 50)).toBeNull();
    expect(
      fixture.logs.some(
        (entry) =>
          entry.event === "tunnel.write_backlog" &&
          entry.fields.cause === "retired",
      ),
    ).toBe(true);
  });

  it("keeps the graceful replaced close when the old tunnel holds no backlog", async () => {
    const fixture = await createFixture();
    const old = await attachStalledTunnel(fixture, "calm");
    const closed = once(old.client, "close");

    await attachStalledTunnel(fixture, "calm");
    const [code, reason] = await closed;

    expect(code).toBe(1000);
    expect(String(reason)).toBe(TUNNEL_REPLACED_CLOSE_REASON);
  });
});

describe("a retired tunnel with only a few frames in flight", () => {
  it.each([
    [
      "replaced by a reconnect",
      1000,
      TUNNEL_REPLACED_CLOSE_REASON,
      async (fixture: Fixture) => {
        await attachStalledTunnel(fixture, "calm");
      },
    ],
    [
      "closed by the relay",
      1000,
      "revoked by owner",
      async (fixture: Fixture) => {
        fixture.registry.close("calm", "revoked by owner");
      },
    ],
  ])(
    "keeps its graceful close and releases its accounting when %s",
    async (_name, expectedCode, expectedReason, retire) => {
      const fixture = await createFixture();
      const tunnel = await attachStalledTunnel(fixture, "calm");

      void openGet(fixture, "calm", "user");
      await waitFor(() => tunnel.framesSent() === 1);
      expect(fixture.registry.stats().tunnelBacklogBytes).toBeGreaterThan(0);

      const closed = once(tunnel.client, "close");
      await retire(fixture);

      expect(fixture.registry.stats().tunnelBacklogBytes).toBe(0);
      const [code, reason] = await closed;
      expect(code).toBe(expectedCode);
      expect(String(reason)).toBe(expectedReason);
      tunnel.completeWrites();
      expect(fixture.registry.stats().tunnelBacklogBytes).toBe(0);
    },
  );
});

describe("heartbeat acknowledgements to a tunnel that is not reading", () => {
  async function attachWithBuffered(fixture: Fixture, buffered: () => number) {
    fixture.server.once("connection", (socket) => {
      Object.defineProperty(socket, "bufferedAmount", { get: buffered });

      fixture.registry.attach({
        routingKey: "silent",
        owner: { kind: "server", serverId: "silent" },
        protocolVersion: 1,
        socket,
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${fixture.port}`);
    fixture.clients.push(client);
    await once(client, "open");
    await waitFor(() => fixture.registry.has("silent"));

    return client;
  }

  it("are answered while the socket buffer is small and stop the tunnel once it passes the backlog limit", async () => {
    const fixture = await createFixture({ tunnelBacklogLimitBytes: 4 * KIB });
    let buffered = 0;
    const client = await attachWithBuffered(fixture, () => buffered);

    const ack = once(client, "message");
    client.send(HEARTBEAT_REQUEST);
    const [data] = await ack;
    expect(String(data)).toBe(HEARTBEAT_RESPONSE);

    buffered = 5 * KIB;
    const closed = once(client, "close");
    client.send(HEARTBEAT_REQUEST);
    const [code] = await closed;

    expect(code).toBe(1006);
    expect(fixture.registry.has("silent")).toBe(false);
    expect(
      fixture.logs.some(
        (entry) =>
          entry.event === "tunnel.write_backlog" &&
          entry.fields.cause === "tunnel",
      ),
    ).toBe(true);
  });
});

describe("the global budget is a ceiling for upload backlog added after admission", () => {
  it("sheds the heaviest owner's tunnel while every tunnel stays under the stream limit", async () => {
    const fixture = await createFixture({
      maxBufferedBytes: 256 * KIB,
      streamBufferLimitBytes: 512 * KIB,
    });

    const feeds: ReadableStreamDefaultController<Uint8Array>[] = [];

    for (let index = 0; index < 4; index += 1) {
      const routingKey = `owner-${index}`;
      await attachStalledTunnel(fixture, routingKey);

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          feeds.push(controller);
        },
      });

      void fixture.registry.openHttpStream({
        routingKey,
        ownerUserId: `user-${index}`,
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

    await waitFor(() => fixture.registry.stats().tunnelBacklogBytes > 0);

    for (const feed of feeds) {
      feed.enqueue(new Uint8Array(100 * KIB));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const stats = fixture.registry.stats();
    expect(stats.tunnelBacklogBytes + stats.bufferedBytes).toBeLessThanOrEqual(
      256 * KIB,
    );

    expect(
      fixture.logs.some(
        (entry) =>
          entry.event === "tunnel.write_backlog" &&
          entry.fields.cause === "share",
      ),
    ).toBe(true);
  });
});

describe("relay-to-tunnel control frames count toward the write backlog", () => {
  it("charges an open-http frame until the tunnel socket has written it", async () => {
    const fixture = await createFixture();
    const tunnel = await attachStalledTunnel(fixture, "calm");

    void openGet(fixture, "calm", "user");
    await waitFor(() => tunnel.framesSent() === 1);

    expect(tunnel.bytesSent()).toBeGreaterThan(0);
    expect(fixture.registry.stats().tunnelBacklogBytes).toBe(
      tunnel.bytesSent(),
    );

    tunnel.completeWrites();
    expect(fixture.registry.stats().tunnelBacklogBytes).toBe(0);
  });

  it("charges the close-stream frame of a canceled request", async () => {
    const fixture = await createFixture();
    const tunnel = await attachStalledTunnel(fixture, "calm");
    const cancel = new AbortController();

    void openGet(fixture, "calm", "user", [], cancel.signal);
    await waitFor(() => tunnel.framesSent() === 1);
    const openBytes = tunnel.bytesSent();
    tunnel.completeWrites();
    expect(fixture.registry.stats().tunnelBacklogBytes).toBe(0);

    cancel.abort();
    expect(tunnel.framesSent()).toBe(2);
    expect(fixture.registry.stats().tunnelBacklogBytes).toBe(
      tunnel.bytesSent() - openBytes,
    );
    expect(tunnel.bytesSent() - openBytes).toBeGreaterThan(0);
  });

  it("drops a tunnel that is not reading once its queued control frames pass the backlog limit", async () => {
    const fixture = await createFixture({ tunnelBacklogLimitBytes: 4 * KIB });
    const tunnel = await attachStalledTunnel(fixture, "silent");
    const closed = once(tunnel.client, "close");
    const padding = "a".repeat(KIB);

    for (let index = 0; index < 8; index += 1) {
      void openGet(fixture, "silent", "user", [["x-pad", padding]]);
    }

    await closed;
    expect(fixture.registry.stats().tunnelBacklogBytes).toBe(0);
    expect(
      fixture.logs.some(
        (entry) =>
          entry.event === "tunnel.write_backlog" &&
          entry.fields.cause === "tunnel",
      ),
    ).toBe(true);
  });
});

describe("request headers above the control frame limit", () => {
  const oversized: [string, string][] = [
    ["x-pad", "a".repeat(MAX_CONTROL_FRAME_PAYLOAD_BYTES)],
  ];

  it("get a 431 from the relay for an HTTP request and send nothing to the tunnel", async () => {
    const fixture = await createFixture();
    const tunnel = await attachStalledTunnel(fixture, "calm");

    const response = await openGet(fixture, "calm", "user", oversized);

    expect(response.status).toBe(431);
    expect(await response.text()).toContain(REQUEST_HEADERS_TOO_LARGE_MESSAGE);
    expect(tunnel.framesSent()).toBe(0);
    expect(fixture.registry.stats().visitorStreams).toBe(0);
  });

  it("get a 431 from the relay for a WebSocket upgrade and send nothing to the tunnel", async () => {
    const fixture = await createFixture();
    const tunnel = await attachStalledTunnel(fixture, "calm");

    const result = await fixture.registry.openWsStream({
      routingKey: "calm",
      ownerUserId: "user",
      expectedOwner: null,
      target: null,
      grant: { kind: "anonymous" },
      signal: fixture.hold.signal,
      path: "/socket",
      headers: oversized,
      protocols: [],
    });

    expect(result.kind).toBe("refused");

    if (result.kind === "refused") {
      expect(result.response.status).toBe(431);
    }

    expect(tunnel.framesSent()).toBe(0);
    expect(fixture.registry.stats().visitorStreams).toBe(0);
  });
});
