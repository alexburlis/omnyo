import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { profile, server, user } from "@omnyo/connect-db";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
  decodeFrame,
  encodeFrame,
} from "@omnyo/tunnel-contract";
import { parseRelayConfig } from "../config.js";
import type { RelayDeps, TunnelRegistry } from "../contracts.js";
import { type RelayDatabase, openRelayDatabase } from "../db.js";
import { createEgressCounter } from "../egress.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { createClientIpSource } from "../net/client-ip.js";
import { createRelayRateLimiters } from "../rate-limit.js";
import { createTunnelRegistry } from "../tunnel/registry.js";
import { suspendUser, unsuspendUser } from "../user-blocks.js";
import { type Gate, createGate } from "./gate.js";
import {
  APP_URL,
  BASE_DOMAIN,
  TestClock,
  captureLogger,
  send,
  sqliteAuthService,
} from "./gate-test-harness.js";
import { createGateNodeHandlers } from "./node.js";
import { createRevocationJournal } from "./revocation.js";
import { randomToken, sha256HexOf } from "./signed-token.js";

const LABEL = "victim";

const HOST = `${LABEL}.${BASE_DOMAIN}`;

const PREVIEW_PATH = "/preview-content/p1/cap1/index.html";

const STALE_BODY = "served-by-the-old-tunnel";

interface Stack {
  port: number;
  database: RelayDatabase;
  tunnels: TunnelRegistry;
  gate: Gate;
  httpServer: Server;
  directory: string;
  userId: string;
  credential: string;
}

let stack: Stack;

const sockets: WebSocket[] = [];

async function buildStack(): Promise<Stack> {
  const clock = new TestClock(Date.now());

  const config = parseRelayConfig({
    BASE_DOMAIN,
    APP_URL,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: randomBytes(16).toString("hex"),
    DATABASE_PATH: ":memory:",
    PORT: "0",
    HEALTH_PORT: "0",
    RELAY_CLIENT_IP_SOURCE: "xff-rightmost",
  });

  const database = openRelayDatabase(
    ":memory:",
    sourceMigrationDirectories(),
    Date.now,
  );

  const { logger } = captureLogger();

  const tunnels = createTunnelRegistry({
    database,
    log: logger,
    maxBufferedBytes: config.maxBufferedBytes,
  });

  const directory = mkdtempSync(join(tmpdir(), "relay-revoked-tunnels-"));

  const deps: RelayDeps = {
    config,
    database,
    tunnels,
    clientIp: createClientIpSource(config.edge),
    rateLimits: createRelayRateLimiters(Date.now),
    egress: createEgressCounter({
      sqlite: database.sqlite,
      capBytes: config.userEgressBytesPerMonth,
      now: Date.now,
    }),
    auth: sqliteAuthService(database, clock),
    log: logger,
    now: Date.now,
  };

  const gate = createGate({
    deps,
    journal: createRevocationJournal(join(directory, "revocations.jsonl")),
    signInUrl: (returnTo) =>
      `${APP_URL}/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
  });

  const handlers = createGateNodeHandlers(gate, deps.clientIp, logger);
  const httpServer = createServer(handlers.request);
  httpServer.on("upgrade", handlers.upgrade);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();

  if (address === null || typeof address === "string")
    throw new Error("no listener port");
  const at = new Date();
  const credential = randomToken();
  const userId = randomUUID();

  database.db
    .insert(user)
    .values({
      id: userId,
      name: LABEL,
      email: `${LABEL}@example.test`,
      emailVerified: true,
      image: null,
      githubLogin: LABEL,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  database.db
    .insert(profile)
    .values({ userId, handle: LABEL, createdAt: at })
    .run();
  database.db
    .insert(server)
    .values({
      id: randomUUID(),
      userId,
      name: LABEL,
      subdomain: LABEL,
      credentialHash: sha256HexOf(credential),
      version: null,
      lastSeenAt: null,
      createdAt: at,
      revokedAt: null,
    })
    .run();

  return {
    port: address.port,
    database,
    tunnels,
    gate,
    httpServer,
    directory,
    userId,
    credential,
  };
}

function dial(credential: string): Promise<{
  status: number;
  socket: WebSocket | null;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${stack.port}/__tunnel?${TUNNEL_PROTOCOL_QUERY_PARAM}=${PROTOCOL_VERSION}`,
      {
        headers: {
          host: HOST,
          "x-forwarded-for": "198.51.100.40",
          authorization: `Bearer ${credential}`,
        },
      },
    );

    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = decodeFrame(new Uint8Array(data as Buffer));

      if (frame.type !== "open-http") return;
      socket.send(
        encodeFrame({
          type: "resp-head",
          streamId: frame.streamId,
          status: 200,
          headers: [["content-type", "text/plain"]],
        }),
      );
      socket.send(
        encodeFrame({
          type: "body-chunk",
          streamId: frame.streamId,
          data: Buffer.from(STALE_BODY),
        }),
      );
      socket.send(encodeFrame({ type: "body-end", streamId: frame.streamId }));
    });
    socket.once("open", () => {
      sockets.push(socket);
      resolve({ status: 101, socket });
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, socket: null });
    });
    socket.once("error", reject);
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;

  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("tunnel socket stayed open")),
      2000,
    );

    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function preview() {
  return send(stack.port, {
    host: HOST,
    path: PREVIEW_PATH,
    forwardedFor: "203.0.113.9",
  });
}

beforeEach(async () => {
  stack = await buildStack();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  stack.tunnels.closeAll(1001, "test done");
  stack.httpServer.closeAllConnections();
  await new Promise((resolve) => stack.httpServer.close(resolve));
  stack.database.close();
  rmSync(stack.directory, { recursive: true, force: true });
});

describe("suspension with the real tunnel registry", () => {
  it("closes the suspended owner's tunnel socket at the next sweep", async () => {
    const dialed = await dial(stack.credential);

    if (dialed.socket === null) throw new Error("tunnel refused");
    await waitFor(() => stack.tunnels.has(LABEL));
    expect((await preview()).body).toBe(STALE_BODY);

    suspendUser(stack.database.db, {
      userId: stack.userId,
      reason: "account takeover",
      now: Date.now(),
    });
    stack.gate.sweep();

    await closed(dialed.socket);
    expect(stack.tunnels.stats().tunnels).toBe(0);
    expect((await preview()).status).toBe(404);
    expect((await dial(stack.credential)).status).toBe(404);
  });

  it("never serves the address through the old tunnel after unsuspend, even before a sweep", async () => {
    const dialed = await dial(stack.credential);

    if (dialed.socket === null) throw new Error("tunnel refused");
    await waitFor(() => stack.tunnels.has(LABEL));

    suspendUser(stack.database.db, {
      userId: stack.userId,
      reason: "account takeover",
      now: Date.now(),
    });
    unsuspendUser(stack.database.db, { userId: stack.userId, now: Date.now() });

    const served = await preview();

    expect(served.status).toBe(503);
    expect(served.body).not.toBe(STALE_BODY);
    expect((await dial(stack.credential)).status).toBe(403);

    stack.gate.sweep();
    await closed(dialed.socket);
    expect(stack.tunnels.stats().tunnels).toBe(0);
  });
});
