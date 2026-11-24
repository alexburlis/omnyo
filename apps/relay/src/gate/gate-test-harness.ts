import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  type IncomingHttpHeaders,
  type Server,
  createServer,
  request as httpRequest,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, gt } from "drizzle-orm";
import { machine, profile, server, session, user } from "@omnyo/connect-db";
import { WebSocket } from "ws";
import { createRelayAuth } from "../auth/index.js";
import { type RelayConfig, parseRelayConfig } from "../config.js";
import type {
  AuthService,
  LogFieldValue,
  RelayDeps,
  RelayLogger,
  RelaySession,
  TunnelAttachment,
  TunnelHttpRequest,
  TunnelRegistry,
  TunnelWsOpenResult,
  TunnelWsRequest,
} from "../contracts.js";
import { type RelayDatabase, openRelayDatabase } from "../db.js";
import { createEgressCounter } from "../egress.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { createClientIpSource } from "../net/client-ip.js";
import { createRelayRateLimiters } from "../rate-limit.js";
import { readCookie } from "./cookies.js";
import { type Gate, createGate } from "./gate.js";
import { createGateNodeHandlers } from "./node.js";
import { TUNNEL_OFFLINE_HEADER } from "./protocol-headers.js";
import {
  type RevocationJournal,
  createRevocationJournal,
} from "./revocation.js";
import { randomToken, sha256HexOf } from "./signed-token.js";

export const BASE_DOMAIN = "relay.test";

export const APP_URL = `https://${BASE_DOMAIN}`;

export const SESSION_COOKIE = "__Host-omnyo.session_token";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class TestClock {
  value: number;

  constructor(start: number) {
    this.value = start;
  }

  now = (): number => this.value;

  advance(ms: number): void {
    this.value += ms;
  }
}

export interface LogRecord {
  level: "info" | "warn" | "error";
  event: string;
  fields: Readonly<Record<string, LogFieldValue>>;
}

export function captureLogger(): { logger: RelayLogger; records: LogRecord[] } {
  const records: LogRecord[] = [];

  const write =
    (level: LogRecord["level"]) =>
    (event: string, fields: Readonly<Record<string, LogFieldValue>> = {}) =>
      records.push({ level, event, fields });

  return {
    records,
    logger: { info: write("info"), warn: write("warn"), error: write("error") },
  };
}

export type OriginHandler = (
  request: TunnelHttpRequest,
) => Response | Promise<Response>;

export async function echoOrigin(
  request: TunnelHttpRequest,
): Promise<Response> {
  const body =
    request.body === null ? "" : await new Response(request.body).text();

  return Response.json({
    method: request.method,
    path: request.path,
    target: request.target,
    grant: request.grant.kind,
    headers: Object.fromEntries(request.headers),
    body,
  });
}

export class FakeTunnels implements TunnelRegistry {
  readonly attachments: TunnelAttachment[] = [];
  readonly httpRequests: TunnelHttpRequest[] = [];
  readonly wsRequests: TunnelWsRequest[] = [];
  readonly closed: Array<{ routingKey: string; reason: string }> = [];
  readonly connected = new Set<string>();
  readonly boundVisitors = new Map<string, Set<WebSocket>>();
  readonly canceledWs: string[] = [];
  origin: OriginHandler = echoOrigin;
  wsHold: Promise<void> | null = null;

  attach(attachment: TunnelAttachment): void {
    this.attachments.push(attachment);
    this.connected.add(attachment.routingKey);
  }

  connect(routingKey: string): void {
    this.connected.add(routingKey);
  }

  has(routingKey: string): boolean {
    return this.connected.has(routingKey);
  }

  async openHttpStream(request: TunnelHttpRequest): Promise<Response> {
    if (!this.connected.has(request.routingKey)) {
      return new Response("offline\n", {
        status: 503,
        headers: { [TUNNEL_OFFLINE_HEADER]: "1" },
      });
    }

    this.httpRequests.push(request);

    return this.origin(request);
  }

  async openWsStream(request: TunnelWsRequest): Promise<TunnelWsOpenResult> {
    if (!this.connected.has(request.routingKey)) {
      return {
        kind: "refused",
        response: new Response("offline\n", {
          status: 503,
          headers: { [TUNNEL_OFFLINE_HEADER]: "1" },
        }),
      };
    }

    this.wsRequests.push(request);

    if (this.wsHold !== null) await this.wsHold;

    const bound =
      this.boundVisitors.get(request.routingKey) ?? new Set<WebSocket>();

    this.boundVisitors.set(request.routingKey, bound);

    const canceled = this.canceledWs;

    return {
      kind: "accepted",
      protocol: request.protocols[0] ?? null,
      bind(visitor: WebSocket) {
        bound.add(visitor);
        visitor.on("message", (data, isBinary) =>
          visitor.send(data, { binary: isBinary }),
        );
        visitor.on("close", () => bound.delete(visitor));
      },
      cancel(reason: string) {
        canceled.push(reason);
      },
    };
  }

  close(routingKey: string, reason: string): void {
    this.closed.push({ routingKey, reason });
    this.connected.delete(routingKey);

    for (const visitor of this.boundVisitors.get(routingKey) ?? [])
      visitor.close(1012, reason);
  }

  visitorStreams() {
    return [];
  }

  closeAll(): void {
    for (const key of [...this.connected]) this.close(key, "closing");
  }

  stats() {
    return {
      tunnels: this.connected.size,
      visitorStreams: 0,
      bufferedBytes: 0,
      tunnelBacklogBytes: 0,
    };
  }
}

function toSession(row: {
  id: string;
  userId: string;
  expiresAt: Date;
  updatedAt: Date;
}): RelaySession {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}

export function sqliteAuthService(
  database: RelayDatabase,
  clock: TestClock,
): AuthService {
  const db = database.db;

  const findUser = (userId: string) => {
    const row = db.select().from(user).where(eq(user.id, userId)).get();

    return row === undefined
      ? null
      : {
          id: row.id,
          name: row.name,
          email: row.email,
          image: row.image,
          githubLogin: row.githubLogin,
        };
  };

  return {
    handler: () => Promise.resolve(new Response("not found", { status: 404 })),
    getSession(headers) {
      const token = readCookie(headers.get("cookie"), SESSION_COOKIE);

      if (token === null) return Promise.resolve(null);

      const row = db
        .select()
        .from(session)
        .where(
          and(
            eq(session.token, token),
            gt(session.expiresAt, new Date(clock.now())),
          ),
        )
        .get();

      if (row === undefined) return Promise.resolve(null);
      const owner = findUser(row.userId);

      return Promise.resolve(
        owner === null ? null : { session: toSession(row), user: owner },
      );
    },
    findLiveSession(sessionId, now) {
      const row = db
        .select()
        .from(session)
        .where(
          and(eq(session.id, sessionId), gt(session.expiresAt, new Date(now))),
        )
        .get();

      return row === undefined ? null : toSession(row);
    },
    findUser,
    renewSession(sessionId, now) {
      const row = db
        .update(session)
        .set({ expiresAt: new Date(now + WEEK_MS), updatedAt: new Date(now) })
        .where(
          and(eq(session.id, sessionId), gt(session.expiresAt, new Date(now))),
        )
        .returning()
        .get();

      return row === undefined ? null : toSession(row);
    },
  };
}

export interface TestUser {
  id: string;
  handle: string;
  sessionId: string;
  sessionToken: string;
}

export interface TestServer {
  id: string;
  label: string;
  credential: string;
}

export interface TestMachine {
  id: string;
  label: string | null;
  credential: string;
}

export interface Harness {
  config: RelayConfig;
  clock: TestClock;
  database: RelayDatabase;
  tunnels: FakeTunnels;
  gate: Gate;
  deps: RelayDeps;
  journal: RevocationJournal;
  journalPath: string;
  logs: LogRecord[];
  port: number;
  addUser(handle: string): TestUser;
  addSession(userId: string): { sessionId: string; sessionToken: string };
  addServer(userId: string, label: string): TestServer;
  addMachine(userId: string, label: string | null): TestMachine;
  close(): Promise<void>;
}

export async function startHarness(
  options: {
    start?: number;
    productionAuth?: boolean;
    env?: Readonly<Record<string, string>>;
  } = {},
): Promise<Harness> {
  const clock = new TestClock(options.start ?? Date.UTC(2026, 10, 8, 12, 0, 0));

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
    ...options.env,
  });

  const database = openRelayDatabase(
    ":memory:",
    sourceMigrationDirectories(),
    clock.now,
  );

  const tunnels = new FakeTunnels();
  const { logger, records } = captureLogger();
  const directory = mkdtempSync(join(tmpdir(), "relay-gate-"));
  const journalPath = join(directory, "revocations.jsonl");
  const journal = createRevocationJournal(journalPath);

  const deps: RelayDeps = {
    config,
    database,
    tunnels,
    clientIp: createClientIpSource(config.edge),
    rateLimits: createRelayRateLimiters(clock.now),
    egress: createEgressCounter({
      sqlite: database.sqlite,
      capBytes: config.userEgressBytesPerMonth,
      now: clock.now,
    }),
    auth:
      options.productionAuth === true
        ? createRelayAuth(config, database).service
        : sqliteAuthService(database, clock),
    log: logger,
    now: clock.now,
  };

  const gate = createGate({
    deps,
    journal,
    signInUrl: (returnTo) =>
      `${APP_URL}/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
  });

  const handlers = createGateNodeHandlers(gate, deps.clientIp, logger);
  const httpServer: Server = createServer(handlers.request);
  httpServer.on("upgrade", handlers.upgrade);
  const openSockets = new Set<import("node:net").Socket>();
  httpServer.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();

  if (address === null || typeof address === "string")
    throw new Error("no listener port");
  const db = database.db;

  const addSession = (userId: string) => {
    const sessionId = randomUUID();
    const sessionToken = randomToken();
    const at = clock.now();

    db.insert(session)
      .values({
        id: sessionId,
        token: sessionToken,
        expiresAt: new Date(at + WEEK_MS),
        ipAddress: null,
        userAgent: null,
        userId,
        createdAt: new Date(at),
        updatedAt: new Date(at),
      })
      .run();

    return { sessionId, sessionToken };
  };

  return {
    config,
    clock,
    database,
    tunnels,
    gate,
    deps,
    journal,
    journalPath,
    logs: records,
    port: address.port,
    addUser(handle) {
      const id = randomUUID();
      const at = new Date(clock.now());

      db.insert(user)
        .values({
          id,
          name: handle,
          email: `${handle}@example.test`,
          emailVerified: true,
          image: null,
          githubLogin: handle,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      db.insert(profile).values({ userId: id, handle, createdAt: at }).run();

      return { id, handle, ...addSession(id) };
    },
    addSession,
    addServer(userId, label) {
      const id = randomUUID();
      const credential = randomToken();

      db.insert(server)
        .values({
          id,
          userId,
          name: label,
          subdomain: label,
          credentialHash: sha256HexOf(credential),
          version: null,
          lastSeenAt: null,
          createdAt: new Date(clock.now()),
          revokedAt: null,
        })
        .run();

      return { id, label, credential };
    },
    addMachine(userId, label) {
      const id = randomUUID();
      const credential = randomToken();

      db.insert(machine)
        .values({
          id,
          userId,
          name: label ?? "phone",
          subdomain: label,
          credentialHash: sha256HexOf(credential),
          lastSeenAt: null,
          createdAt: new Date(clock.now()),
          revokedAt: null,
        })
        .run();

      return { id, label, credential };
    },
    async close() {
      tunnels.closeAll();
      httpServer.closeAllConnections();

      for (const socket of openSockets) socket.destroy();
      await new Promise((resolve) => httpServer.close(resolve));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  setCookies: string[];
}

export interface SendOptions {
  host: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  forwardedFor?: string;
}

export function send(port: number, options: SendOptions): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: {
          host: options.host,
          "x-forwarded-for": options.forwardedFor ?? "198.51.100.7",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            setCookies: response.headers["set-cookie"] ?? [],
          }),
        );
        response.on("error", reject);
      },
    );

    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

export function cookiePair(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(";"));
}

export function cookieValue(
  setCookies: readonly string[],
  name: string,
): string | null {
  const match = setCookies.find((cookie) => cookie.startsWith(`${name}=`));

  return match === undefined ? null : cookiePair(match).slice(name.length + 1);
}

export interface WsResult {
  kind: "open" | "refused";
  status: number;
  socket: WebSocket | null;
}

export function openWs(
  port: number,
  options: {
    host: string;
    path: string;
    headers?: Record<string, string>;
    protocols?: string[];
  },
): Promise<WsResult> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${options.path}`,
      options.protocols ?? [],
      {
        headers: {
          host: options.host,
          "x-forwarded-for": "198.51.100.7",
          ...options.headers,
        },
      },
    );

    socket.once("open", () => resolve({ kind: "open", status: 101, socket }));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({
        kind: "refused",
        status: response.statusCode ?? 0,
        socket: null,
      });
    });
    socket.once("error", (error) => reject(error));
  });
}
