import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  type ClientHttp2Session,
  type IncomingHttpHeaders as Http2Headers,
  type OutgoingHttpHeaders as Http2RequestHeaders,
  createServer as createHttp2Server,
  connect as http2Connect,
} from "node:http2";
import { type AddressInfo, type Socket, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { getRequestListener } from "@hono/node-server";
import {
  profile,
  server as pairedServer,
  session,
  user,
} from "@omnyo/connect-db";
import { TunnelSession } from "@omnyo/tunnel-client";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
} from "@omnyo/tunnel-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  CERTIFICATE_CHAIN_FILE,
  CERTIFICATE_DIRECTORY,
  CertificateIssuanceError,
  DIRECTORY_URL_FILE,
  PRIVATE_KEY_FILE,
  createFileCertificateStore,
} from "./acme.js";
import {
  type LogFieldValue,
  RELAY_RATE_LIMITS,
  RELAY_STRICT_TRANSPORT_SECURITY,
  type RelayLogger,
} from "./contracts.js";
import { RelayServerResponse, type RunningRelay, startRelay } from "./main.js";
import { openRelayDatabase } from "./db.js";
import { issueGateCookie } from "./gate/gate-cookie.js";
import {
  GATE_KEY_LABEL,
  derivePurposeKey,
  randomToken,
  sha256HexOf,
} from "./gate/signed-token.js";
import { sourceMigrationDirectories } from "./migrations.js";
import {
  type ConnectionBounds,
  DEFAULT_CONNECTION_BOUNDS,
} from "./net/connection-bounds.js";
import {
  HTTP2_FORBIDDEN_RESPONSE_HEADERS,
  RelayHttp2ServerResponse,
} from "./net/edge-responses.js";
import { PROXY_V2_SIGNATURE } from "./net/proxy-protocol.js";

const run = promisify(execFile);

const BASE_DOMAIN = "omnyo.localhost";

const ACME_DIRECTORY_URL = "https://acme.invalid/directory";

const LONG_MS = 10_000;

const OBSERVE_MS = 2_000;

let directory: string;

let relay: RunningRelay | null;

const events: string[] = [];

const rejections: Array<Record<string, LogFieldValue>> = [];

const clients: Socket[] = [];

const timers: NodeJS.Timeout[] = [];

const closers: Array<() => void> = [];

const capture = (event: string, fields?: Record<string, LogFieldValue>) => {
  events.push(event);

  if (event === "edge.connection_rejected" && fields !== undefined)
    rejections.push(fields);
};

const log: RelayLogger = { info: capture, warn: capture, error: capture };

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, "close");

  return port;
}

function proxyV2Header(source: string, sourcePort: number): Buffer {
  const block = Buffer.alloc(12);
  Buffer.from(source.split(".").map(Number)).copy(block, 0);
  Buffer.from([127, 0, 0, 1]).copy(block, 4);
  block.writeUInt16BE(sourcePort, 8);
  block.writeUInt16BE(443, 10);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(block.length);

  return Buffer.concat([
    PROXY_V2_SIGNATURE,
    Buffer.from([0x21, 0x11]),
    length,
    block,
  ]);
}

function proxyV2Ipv6Header(groups: readonly number[]): Buffer {
  const block = Buffer.alloc(36);

  for (const [index, group] of groups.entries())
    block.writeUInt16BE(group, index * 2);
  block.writeUInt16BE(1, 30);
  block.writeUInt16BE(50_000, 32);
  block.writeUInt16BE(443, 34);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(block.length);

  return Buffer.concat([
    PROXY_V2_SIGNATURE,
    Buffer.from([0x21, 0x21]),
    length,
    block,
  ]);
}

function environment(port: number): Record<string, string> {
  return {
    BASE_DOMAIN,
    APP_URL: `https://${BASE_DOMAIN}:${port}`,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    GITHUB_CLIENT_ID: "relay-edge-client",
    GITHUB_CLIENT_SECRET: randomBytes(16).toString("hex"),
    DATABASE_PATH: join(directory, "relay.sqlite"),
    PORT: String(port),
    HEALTH_PORT: "0",
    RELAY_CLIENT_IP_SOURCE: "proxy-protocol",
    RELAY_PROXY_CIDR: "127.0.0.1/32",
    ACME_DIRECTORY_URL,
    ACME_ACCOUNT_EMAIL: "relay@example.com",
    CLOUDFLARE_DNS_TOKEN: "unused-in-local-tests",
    CLOUDFLARE_ZONE_ID: "0123456789abcdef0123456789abcdef",
  };
}

async function writeSelfSignedCertificate(): Promise<void> {
  const target = join(directory, CERTIFICATE_DIRECTORY);
  mkdirSync(target, { recursive: true });
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "90",
    "-subj",
    `/CN=${BASE_DOMAIN}`,
    "-addext",
    `subjectAltName=DNS:${BASE_DOMAIN},DNS:*.${BASE_DOMAIN}`,
    "-keyout",
    join(target, PRIVATE_KEY_FILE),
    "-out",
    join(target, CERTIFICATE_CHAIN_FILE),
  ]);
  writeFileSync(join(target, DIRECTORY_URL_FILE), ACME_DIRECTORY_URL);
}

function directEnvironment(port: number): Record<string, string> {
  return {
    BASE_DOMAIN,
    APP_URL: `https://${BASE_DOMAIN}:${port}`,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    GITHUB_CLIENT_ID: "relay-edge-client",
    GITHUB_CLIENT_SECRET: randomBytes(16).toString("hex"),
    DATABASE_PATH: join(directory, "relay.sqlite"),
    PORT: String(port),
    HEALTH_PORT: "0",
    RELAY_CLIENT_IP_SOURCE: "xff-rightmost",
  };
}

function start(
  port: number,
  bounds: Partial<ConnectionBounds> = {},
  env: Record<string, string> = environment(port),
): Promise<RunningRelay> {
  return startRelay({
    env,
    connectionBounds: { ...DEFAULT_CONNECTION_BOUNDS, ...bounds },
    migrations: sourceMigrationDirectories(),
    lock: () => ({ verify: async () => {} }),
    certificates: createFileCertificateStore,
    certificateIssuer: () => ({
      issue: () =>
        Promise.reject(new Error("the ACME directory is unreachable")),
    }),
    log,
  });
}

function httpsGetThroughProxy(
  port: number,
  host: string,
  path: string,
  options: { proxyHeader?: Buffer; extraHeaders?: readonly string[] } = {},
): Promise<{ status: number; body: string; hsts: string | null }> {
  return new Promise((resolve, reject) => {
    const raw = connect(port, "127.0.0.1", () => {
      raw.write(options.proxyHeader ?? proxyV2Header("198.51.100.9", 50_000));

      const secure = tlsConnect({
        socket: raw,
        servername: host.split(":")[0],
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
      });

      let response = "";
      secure.on("data", (chunk: Buffer) => (response += chunk.toString()));
      secure.on("end", () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1] ?? 0);
        const [head = "", body = ""] = response.split("\r\n\r\n");

        const hsts =
          /^strict-transport-security: (.*)$/imu.exec(head)?.[1] ?? null;

        resolve({ status, body, hsts });
      });
      secure.on("error", reject);
      secure.on("secureConnect", () => {
        secure.write(
          [
            `GET ${path} HTTP/1.1`,
            `host: ${host}`,
            "accept: text/html",
            ...(options.extraHeaders ?? []),
            "connection: close",
            "",
            "",
          ].join("\r\n"),
        );
      });
    });

    raw.on("error", reject);
  });
}

async function openRaw(port: number): Promise<Socket> {
  const raw = connect(port, "127.0.0.1");
  raw.on("error", () => {});
  clients.push(raw);
  await once(raw, "connect");

  return raw;
}

async function tlsThroughProxy(
  port: number,
  proxyHeader: Buffer,
  servername = BASE_DOMAIN,
): Promise<TLSSocket> {
  const raw = await openRaw(port);
  raw.write(proxyHeader);

  const secure = tlsConnect({
    socket: raw,
    servername,
    rejectUnauthorized: false,
    ALPNProtocols: ["http/1.1"],
  });

  secure.on("error", () => {});
  clients.push(secure);
  await once(secure, "secureConnect");

  return secure;
}

async function admittedThroughProxy(
  port: number,
  proxyHeader: Buffer,
): Promise<boolean> {
  try {
    await tlsThroughProxy(port, proxyHeader);

    return true;
  } catch {
    return false;
  }
}

async function refusedAfterProxyHeader(
  port: number,
  proxyHeader: Buffer,
): Promise<boolean> {
  const raw = await openRaw(port);
  raw.resume();
  raw.write(proxyHeader);

  return closedWithin(raw, OBSERVE_MS);
}

function closedWithin(socket: Socket, ms: number): Promise<boolean> {
  if (socket.destroyed) return Promise.resolve(true);

  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };

    const timer = setTimeout(() => {
      socket.off("close", onClose);
      resolve(false);
    }, ms);

    socket.once("close", onClose);
  });
}

function clientHelloBytes(): Promise<Buffer> {
  const [left, right] = duplexPair();

  const client = tlsConnect({
    socket: left,
    servername: BASE_DOMAIN,
    rejectUnauthorized: false,
    ALPNProtocols: ["http/1.1"],
  });

  client.on("error", () => {});

  return new Promise((resolve) => {
    right.once("data", (chunk: Buffer) => {
      client.destroy();
      right.destroy();
      resolve(Buffer.from(chunk));
    });
  });
}

function trickle(socket: Socket, everyMs: number): void {
  timers.push(
    setInterval(() => {
      if (socket.writable) socket.write("a");
    }, everyMs),
  );
}

const partialRequest = `GET / HTTP/1.1\r\nhost: healthcheck.${BASE_DOMAIN}\r\n`;

const OWNER_LABEL = "alice";

const DAY_MS = 24 * 60 * 60 * 1000;

interface SeededOwner {
  userId: string;
  sessionId: string;
  credential: string;
}

function seedOwner(databasePath: string): SeededOwner {
  const seeded = openRelayDatabase(databasePath, sourceMigrationDirectories());

  const owner = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    credential: randomToken(),
  };

  const at = new Date();

  try {
    seeded.db
      .insert(user)
      .values({
        id: owner.userId,
        name: "owner",
        email: "owner@example.test",
        emailVerified: true,
        image: null,
        githubLogin: "owner",
        createdAt: at,
        updatedAt: at,
      })
      .run();
    seeded.db
      .insert(profile)
      .values({ userId: owner.userId, handle: "owner", createdAt: at })
      .run();
    seeded.db
      .insert(pairedServer)
      .values({
        id: randomUUID(),
        userId: owner.userId,
        name: OWNER_LABEL,
        subdomain: OWNER_LABEL,
        credentialHash: sha256HexOf(owner.credential),
        version: null,
        lastSeenAt: null,
        createdAt: at,
        revokedAt: null,
      })
      .run();
    seeded.db
      .insert(session)
      .values({
        id: owner.sessionId,
        token: randomToken(),
        expiresAt: new Date(at.getTime() + DAY_MS),
        ipAddress: null,
        userAgent: null,
        userId: owner.userId,
        createdAt: at,
        updatedAt: at,
      })
      .run();
  } finally {
    seeded.close();
  }

  return owner;
}

function egressBytes(databasePath: string, userId: string): number {
  const reopened = openRelayDatabase(
    databasePath,
    sourceMigrationDirectories(),
  );

  try {
    const row = reopened.sqlite
      .prepare(
        "SELECT SUM(bytes) AS bytes FROM relay_egress_month WHERE user_id = ?",
      )
      .get(userId) as { bytes: number | null };

    return row.bytes ?? 0;
  } finally {
    reopened.close();
  }
}

function gateCookieFor(
  secret: string,
  owner: SeededOwner,
  host: string,
): string {
  const now = Date.now();

  const { setCookie } = issueGateCookie(
    derivePurposeKey(secret, GATE_KEY_LABEL),
    {
      userId: owner.userId,
      host,
      sessionId: owner.sessionId,
      sessionExpiresAt: now + DAY_MS,
    },
    now,
  );

  return setCookie.slice(0, setCookie.indexOf(";"));
}

async function tlsFactoryThroughProxy(
  port: number,
  proxyHeader: Buffer,
  servername: string,
  ALPNProtocols?: string[],
): Promise<() => TLSSocket> {
  const raw = await openRaw(port);
  raw.write(proxyHeader);

  return () =>
    tlsConnect({
      socket: raw,
      servername,
      rejectUnauthorized: false,
      ...(ALPNProtocols === undefined ? {} : { ALPNProtocols }),
    });
}

async function http2ThroughProxy(
  port: number,
  proxyHeader: Buffer,
  servername = BASE_DOMAIN,
): Promise<ClientHttp2Session> {
  const createConnection = await tlsFactoryThroughProxy(
    port,
    proxyHeader,
    servername,
    ["h2", "http/1.1"],
  );

  const client = http2Connect(`https://${servername}:${port}`, {
    createConnection,
  });

  client.on("error", () => {});
  closers.push(() => client.destroy());
  await once(client, "remoteSettings");

  return client;
}

interface Http2Result {
  status: number;
  headers: Http2Headers;
  body: string;
}

function http2Request(
  client: ClientHttp2Session,
  headers: Http2RequestHeaders,
  onChunk: (chunk: string) => void = () => {},
): Promise<Http2Result> {
  return new Promise((resolve, reject) => {
    const stream = client.request(headers);
    let received: Http2Headers = {};
    let body = "";

    stream.setEncoding("utf8");
    stream.on("response", (head) => (received = head));
    stream.on("data", (chunk: string) => {
      body += chunk;
      onChunk(chunk);
    });
    stream.on("end", () =>
      resolve({ status: Number(received[":status"]), headers: received, body }),
    );
    stream.on("error", reject);
  });
}

function sessionClosedWithin(
  client: ClientHttp2Session,
  ms: number,
): Promise<boolean> {
  if (client.closed || client.destroyed) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    client.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function forbiddenHeaderNames(headers: Http2Headers): string[] {
  return Object.keys(headers).filter((name) =>
    HTTP2_FORBIDDEN_RESPONSE_HEADERS.has(name),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "relay-edge-"));
  relay = null;
  events.length = 0;
  rejections.length = 0;
});

afterEach(async () => {
  for (const timer of timers.splice(0)) clearInterval(timer);

  for (const close of closers.splice(0).reverse()) close();

  for (const socket of clients.splice(0).reverse()) socket.destroy();
  await relay?.shutdown();
  rmSync(directory, { recursive: true, force: true });
});

describe("option P listener", () => {
  it("terminates TLS after a PROXY v2 header and derives the client address", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port);

    const tenant = await httpsGetThroughProxy(
      port,
      `healthcheck.${BASE_DOMAIN}:${port}`,
      "/",
    );

    expect(tenant).toEqual({
      status: 200,
      body: "ok\n",
      hsts: RELAY_STRICT_TRANSPORT_SECURITY,
    });

    const apex = await httpsGetThroughProxy(
      port,
      `${BASE_DOMAIN}:${port}`,
      "/dashboard",
    );

    expect(apex.status).toBe(200);
    expect(apex.hsts).toBe(RELAY_STRICT_TRANSPORT_SECURITY);
    expect(apex.body).toContain("Continue with GitHub");
    expect(events).not.toContain("apex.client_ip_missing");
    expect(events).not.toContain("gate.client_ip_missing");
  });

  it("closes a connection that sends no PROXY header", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port);

    const socket: Socket = connect(port, "127.0.0.1", () => {
      socket.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    });

    socket.resume();
    await once(socket, "close");

    expect(events).toContain("edge.connection_rejected");
  });

  it("refuses to start when it cannot obtain a certificate after migrations succeed", async () => {
    const port = await freePort();

    await expect(start(port)).rejects.toBeInstanceOf(CertificateIssuanceError);

    expect(events).toContain("relay.migrations_applied");
    expect(events).not.toContain("relay.live");
  });
});

describe("option P connection bounds", () => {
  it("closes a connection whose TLS handshake stalls after the ClientHello", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port, {
      tlsHandshakeTimeoutMs: 200,
      requestHeadersTimeoutMs: LONG_MS,
      idleTimeoutMs: LONG_MS,
    });

    const raw = await openRaw(port);
    raw.resume();
    raw.write(
      Buffer.concat([
        proxyV2Header("198.51.100.20", 50_000),
        await clientHelloBytes(),
      ]),
    );

    expect(await closedWithin(raw, OBSERVE_MS)).toBe(true);
  });

  it("closes a connection that completes TLS and then stalls its request headers", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port, {
      requestHeadersTimeoutMs: 300,
      idleTimeoutMs: LONG_MS,
    });

    const secure = await tlsThroughProxy(
      port,
      proxyV2Header("198.51.100.21", 50_000),
    );

    secure.resume();
    secure.write(partialRequest);

    expect(await closedWithin(secure, OBSERVE_MS)).toBe(true);
  });

  it("closes a client that trickles header bytes, on the first request and on a kept-alive one", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port, {
      requestHeadersTimeoutMs: 400,
      idleTimeoutMs: 200,
    });

    const first = await tlsThroughProxy(
      port,
      proxyV2Header("198.51.100.22", 50_000),
    );

    first.resume();
    first.write(`${partialRequest}x-slow: `);
    trickle(first, 50);

    const kept = await tlsThroughProxy(
      port,
      proxyV2Header("198.51.100.23", 50_000),
      `healthcheck.${BASE_DOMAIN}`,
    );

    let response = "";
    kept.on("data", (chunk: Buffer) => (response += chunk.toString()));
    kept.write(
      `GET / HTTP/1.1\r\nhost: healthcheck.${BASE_DOMAIN}:${port}\r\n\r\n`,
    );
    await expect.poll(() => response).toMatch(/\r\n\r\nok\n$/u);
    kept.write(`${partialRequest}x-slow: `);
    trickle(kept, 50);

    expect({
      first: await closedWithin(first, OBSERVE_MS),
      kept: await closedWithin(kept, OBSERVE_MS),
    }).toEqual({ first: true, kept: true });
  });

  it("admits a bounded number of connections per PROXY source and counts an IPv6 /64 as one source", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port, { maxConnectionsPerClient: 2 });
    const busy = proxyV2Header("198.51.100.30", 50_000);
    const held = await tlsThroughProxy(port, busy);
    await tlsThroughProxy(port, busy);

    expect(await refusedAfterProxyHeader(port, busy)).toBe(true);
    expect(
      await admittedThroughProxy(port, proxyV2Header("198.51.100.31", 50_000)),
    ).toBe(true);

    const network = [0x2001, 0x0db8, 0x0001, 0x0002];
    await tlsThroughProxy(port, proxyV2Ipv6Header([...network, 0, 0, 0, 1]));
    await tlsThroughProxy(port, proxyV2Ipv6Header([...network, 0, 0, 0, 2]));

    expect(
      await refusedAfterProxyHeader(
        port,
        proxyV2Ipv6Header([...network, 0xffff, 0, 0, 3]),
      ),
    ).toBe(true);
    expect(
      await admittedThroughProxy(
        port,
        proxyV2Ipv6Header([0x2001, 0x0db8, 0x0001, 0x0003, 0, 0, 0, 1]),
      ),
    ).toBe(true);

    held.destroy();
    await expect.poll(() => admittedThroughProxy(port, busy)).toBe(true);
    expect(rejections).toContainEqual({
      reason: "client-connection-limit",
      refused: 1,
    });
  });

  it("refuses connections above the overall connection limit", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port, { maxConnections: 2 });

    const held = await tlsThroughProxy(
      port,
      proxyV2Header("198.51.100.40", 50_000),
    );

    await tlsThroughProxy(port, proxyV2Header("198.51.100.41", 50_000));

    expect(
      await refusedAfterProxyHeader(
        port,
        proxyV2Header("198.51.100.43", 50_000),
      ),
    ).toBe(true);
    expect(rejections).toContainEqual({
      reason: "connection-limit",
      refused: 1,
    });

    held.destroy();
    await expect
      .poll(() =>
        admittedThroughProxy(port, proxyV2Header("198.51.100.42", 50_000)),
      )
      .toBe(true);
  });

  it("closes an idle connection of the source holding the most when a new source arrives at the overall limit", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port, { maxConnections: 2 });
    const heavy = proxyV2Header("198.51.100.44", 50_000);
    const oldest = await tlsThroughProxy(port, heavy);
    const newer = await tlsThroughProxy(port, heavy);

    expect(
      await admittedThroughProxy(port, proxyV2Header("198.51.100.45", 50_000)),
    ).toBe(true);
    expect({
      oldest: await closedWithin(oldest, OBSERVE_MS),
      newer: newer.destroyed,
    }).toEqual({ oldest: true, newer: false });
  });

  it("shares the per-IP rate limit across an IPv6 /64 whatever forwarding headers the client adds", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port);
    const host = `${BASE_DOMAIN}:${port}`;
    const { limit } = RELAY_RATE_LIMITS.gateHandshake;
    const statuses: number[] = [];

    for (let index = 0; index <= limit; index += 1) {
      const response = await httpsGetThroughProxy(
        port,
        host,
        "/relay/authorize",
        {
          proxyHeader: proxyV2Ipv6Header([
            0x2001,
            0x0db8,
            0x0001,
            0x0002,
            index,
            0,
            0,
            1,
          ]),
          extraHeaders: [
            `x-forwarded-for: 6.6.${index}.1`,
            `x-real-ip: 7.7.${index}.1`,
            `forwarded: for=8.8.${index}.1`,
            `x-omnyo-client-ip: 9.9.${index}.1`,
          ],
        },
      );

      statuses.push(response.status);
    }

    const otherNetwork = await httpsGetThroughProxy(
      port,
      host,
      "/relay/authorize",
      {
        proxyHeader: proxyV2Ipv6Header([
          0x2001, 0x0db8, 0x0001, 0x0003, 0, 0, 0, 1,
        ]),
      },
    );

    expect(statuses.slice(0, limit)).not.toContain(429);
    expect(statuses[limit]).toBe(429);
    expect(otherNetwork.status).not.toBe(429);
  });
});

describe("direct listener connection bounds", () => {
  it("closes a stalled request and refuses connections above the overall limit", async () => {
    const port = await freePort();
    relay = await start(
      port,
      { requestHeadersTimeoutMs: 300, maxConnections: 2 },
      directEnvironment(port),
    );

    const stalled = await openRaw(port);
    stalled.resume();
    stalled.write(partialRequest);
    await openRaw(port);
    const refused = await openRaw(port);
    refused.resume();

    expect({
      refused: await closedWithin(refused, OBSERVE_MS),
      stalled: await closedWithin(stalled, OBSERVE_MS),
    }).toEqual({ refused: true, stalled: true });
  });
});

describe("refused upgrades and held reserved addresses", () => {
  it("closes a refused WebSocket upgrade that the client holds half-open, freeing its connection slot", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port, { maxConnectionsPerClient: 2 });
    const source = proxyV2Header("198.51.100.44", 50_000);

    for (let index = 0; index < 2; index += 1) {
      const raw = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
      raw.on("error", () => {});
      clients.push(raw);
      await once(raw, "connect");
      raw.write(source);

      const secure = tlsConnect({
        socket: raw,
        servername: BASE_DOMAIN,
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
      });

      secure.on("error", () => {});
      clients.push(secure);
      await once(secure, "secureConnect");
      secure.resume();
      secure.write(
        `GET / HTTP/1.1\r\nhost: ${BASE_DOMAIN}\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n`,
      );
      await once(secure, "end");
    }

    await expect
      .poll(() => admittedThroughProxy(port, source), { timeout: OBSERVE_MS })
      .toBe(true);
  });

  it("warns at startup about held addresses that the reserved list now redirects", async () => {
    const port = await freePort();
    const env = directEnvironment(port);

    const seeded = openRelayDatabase(
      env.DATABASE_PATH ?? "",
      sourceMigrationDirectories(),
    );

    try {
      const now = Date.now();
      seeded.sqlite
        .prepare(
          "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('greeter', 'greeter', 'greeter@example.com', 1, ?, ?)",
        )
        .run(now, now);
      seeded.sqlite
        .prepare(
          "INSERT INTO profile (user_id, handle, created_at) VALUES ('greeter', 'hello', ?)",
        )
        .run(now);
    } finally {
      seeded.close();
    }

    relay = await start(port, {}, env);

    expect(events).toContain("relay.reserved_labels_held");
  });
});

describe("relay Strict-Transport-Security", () => {
  it("keeps the relay's value whatever a handler sets, appends or removes", async () => {
    const handlers: Array<(response: RelayServerResponse) => void> = [
      (response) => {
        response.writeHead(200, { "Strict-Transport-Security": "max-age=0" });
        response.end();
      },
      (response) => {
        response.writeHead(200, ["strict-transport-security", "max-age=0"]);
        response.end();
      },
      (response) => {
        response.appendHeader("strict-transport-security", "max-age=0");
        response.removeHeader("Strict-Transport-Security");
        response.end();
      },
    ];

    const upstream = getRequestListener(
      () =>
        new Response("owner", {
          headers: [
            ["strict-transport-security", "max-age=0"],
            ["strict-transport-security", "max-age=1; preload"],
          ],
        }),
    );

    const server = createServer(
      { ServerResponse: RelayServerResponse },
      (request, response) => {
        const index = Number((request.url ?? "/").slice(1));
        const handler = handlers[index];

        if (handler === undefined) void upstream(request, response);
        else handler(response);
      },
    );

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    try {
      const values = await Promise.all(
        [0, 1, 2, 3].map(async (index) => {
          const response = await fetch(`http://127.0.0.1:${port}/${index}`);
          await response.arrayBuffer();

          return response.headers.get("strict-transport-security");
        }),
      );

      expect(values).toEqual(
        Array.from({ length: 4 }, () => RELAY_STRICT_TRANSPORT_SECURITY),
      );
    } finally {
      server.close();
    }
  });

  it("keeps the relay's value and drops connection-specific headers over HTTP/2", async () => {
    const forbidden = Object.fromEntries(
      [...HTTP2_FORBIDDEN_RESPONSE_HEADERS].map((name) => [name, "x"]),
    );

    const handlers: Array<(response: RelayHttp2ServerResponse) => void> = [
      (response) => {
        response.writeHead(200, {
          ...forbidden,
          "Strict-Transport-Security": "max-age=0",
          "x-kept": "yes",
        });
        response.end("0");
      },
      (response) => {
        for (const name of Object.keys(forbidden)) {
          response.setHeader(name, "x");
        }

        response.setHeader("strict-transport-security", "max-age=0");
        response.setHeader("x-kept", "yes");
        response.end("1");
      },
      (response) => {
        for (const name of Object.keys(forbidden)) {
          response.appendHeader(name, "x");
        }

        response.appendHeader("strict-transport-security", "max-age=0");
        response.removeHeader("Strict-Transport-Security");
        response.appendHeader("x-kept", "yes");
        response.end("2");
      },
    ];

    const upstream = getRequestListener(
      () =>
        new Response("3", {
          headers: [
            ...Object.entries(forbidden),
            ["strict-transport-security", "max-age=0"],
            ["x-kept", "yes"],
          ],
        }),
    );

    const h2c = createHttp2Server(
      { Http2ServerResponse: RelayHttp2ServerResponse },
      (request, response) => {
        const index = Number((request.url ?? "/").slice(1));
        const handler = handlers[index];

        if (handler === undefined) void upstream(request, response);
        else handler(response);
      },
    );

    h2c.listen(0, "127.0.0.1");
    await once(h2c, "listening");
    const { port } = h2c.address() as AddressInfo;
    const client = http2Connect(`http://127.0.0.1:${port}`);
    client.on("error", () => {});

    try {
      const results = await Promise.all(
        [0, 1, 2, 3].map((index) =>
          http2Request(client, { ":path": `/${index}` }),
        ),
      );

      expect(
        results.map((result) => ({
          status: result.status,
          body: result.body,
          kept: result.headers["x-kept"],
          hsts: result.headers["strict-transport-security"],
          forbidden: forbiddenHeaderNames(result.headers),
        })),
      ).toEqual(
        [0, 1, 2, 3].map((index) => ({
          status: 200,
          body: String(index),
          kept: "yes",
          hsts: RELAY_STRICT_TRANSPORT_SECURITY,
          forbidden: [],
        })),
      );
    } finally {
      client.destroy();
      h2c.close();
    }
  });
});

describe("HTTP/2 edge", () => {
  it("negotiates h2 when the client offers it and keeps HTTP/1.1 for clients that do not", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port);

    const negotiated = async (offered?: string[]) => {
      const secure = (
        await tlsFactoryThroughProxy(
          port,
          proxyV2Header("198.51.100.50", 50_000),
          BASE_DOMAIN,
          offered,
        )
      )();

      secure.on("error", () => {});
      clients.push(secure);
      await once(secure, "secureConnect");

      return secure.alpnProtocol;
    };

    expect({
      both: await negotiated(["h2", "http/1.1"]),
      http1: await negotiated(["http/1.1"]),
      none: await negotiated(),
    }).toEqual({ both: "h2", http1: "http/1.1", none: false });

    const client = await http2ThroughProxy(
      port,
      proxyV2Header("198.51.100.51", 50_000),
    );

    const tenant = await http2Request(client, {
      ":path": "/",
      ":authority": `healthcheck.${BASE_DOMAIN}:${port}`,
    });

    const apex = await http2Request(client, {
      ":path": "/dashboard",
      ":authority": `${BASE_DOMAIN}:${port}`,
      accept: "text/html",
    });

    const http1 = await httpsGetThroughProxy(
      port,
      `healthcheck.${BASE_DOMAIN}:${port}`,
      "/",
    );

    expect(client.remoteSettings.enableConnectProtocol).toBe(false);
    expect({
      status: tenant.status,
      body: tenant.body,
      hsts: tenant.headers["strict-transport-security"],
    }).toEqual({
      status: 200,
      body: "ok\n",
      hsts: RELAY_STRICT_TRANSPORT_SECURITY,
    });
    expect(apex.status).toBe(200);
    expect(apex.headers["strict-transport-security"]).toBe(
      RELAY_STRICT_TRANSPORT_SECURITY,
    );
    expect(apex.body).toContain("Continue with GitHub");
    expect(http1).toEqual({
      status: 200,
      body: "ok\n",
      hsts: RELAY_STRICT_TRANSPORT_SECURITY,
    });
    expect(events).not.toContain("apex.client_ip_missing");
    expect(events).not.toContain("gate.client_ip_missing");
  });

  it("rate-limits each PROXY source separately over HTTP/2", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port);
    const authority = `${BASE_DOMAIN}:${port}`;
    const { limit } = RELAY_RATE_LIMITS.gateHandshake;

    const busy = await http2ThroughProxy(
      port,
      proxyV2Header("198.51.100.52", 50_000),
    );

    const statuses: number[] = [];

    for (let index = 0; index <= limit; index += 1) {
      const response = await http2Request(busy, {
        ":path": "/relay/authorize",
        ":authority": authority,
        "x-forwarded-for": `6.6.${index}.1`,
      });

      statuses.push(response.status);
    }

    const other = await http2ThroughProxy(
      port,
      proxyV2Header("198.51.100.53", 50_000),
    );

    const otherSource = await http2Request(other, {
      ":path": "/relay/authorize",
      ":authority": authority,
    });

    expect(statuses.slice(0, limit)).not.toContain(429);
    expect(statuses[limit]).toBe(429);
    expect(otherSource.status).not.toBe(429);
  });

  it("streams an h2 request through a tunnel attached over HTTP/1.1, drops connection-specific origin headers and serves a WebSocket over HTTP/1.1", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    const env = environment(port);
    const databasePath = env.DATABASE_PATH ?? "";
    const owner = seedOwner(databasePath);
    relay = await start(port, {}, env);
    const servername = `${OWNER_LABEL}.${BASE_DOMAIN}`;
    const authority = `${servername}:${port}`;
    let originCookie: string | undefined;
    let releaseOrigin = () => {};

    const released = new Promise<void>((resolve) => {
      releaseOrigin = resolve;
    });

    const origin = createServer((request, response) => {
      originCookie = request.headers.cookie;
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "proxy-connection": "keep-alive",
        "http2-settings": "origin-value",
        te: "trailers",
        "strict-transport-security": "max-age=0",
        "x-origin": "streamed",
      });
      response.write("first chunk\n");
      void released.then(() => response.end("second chunk\n"));
    });

    const originSockets = new WebSocketServer({ noServer: true });
    originSockets.on("connection", (socket) =>
      socket.on("message", (data) => socket.send(`echo:${String(data)}`)),
    );
    origin.on("upgrade", (request, socket, head) =>
      originSockets.handleUpgrade(request, socket, head, (socket) =>
        originSockets.emit("connection", socket, request),
      ),
    );
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const originPort = (origin.address() as AddressInfo).port;
    closers.push(() => {
      originSockets.close();
      origin.closeAllConnections();
      origin.close();
    });

    const tunnel = new WebSocket(
      `wss://${authority}/__tunnel?${TUNNEL_PROTOCOL_QUERY_PARAM}=${PROTOCOL_VERSION}`,
      {
        headers: { authorization: `Bearer ${owner.credential}` },
        createConnection: await tlsFactoryThroughProxy(
          port,
          proxyV2Header("198.51.100.60", 50_000),
          servername,
        ),
      },
    );

    tunnel.on("error", () => {});
    closers.push(() => tunnel.terminate());

    const tunnelSession = new TunnelSession({
      tunnel,
      log: { warn: () => {}, info: () => {} },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: {
          origin: `http://127.0.0.1:${originPort}`,
          publicOrigin: `https://${authority}`,
        },
      }),
    });

    tunnel.once("open", () => tunnelSession.start());
    await once(tunnel, "open");

    const cookie = gateCookieFor(
      env.BETTER_AUTH_SECRET ?? "",
      owner,
      authority,
    );

    const visitor = await http2ThroughProxy(
      port,
      proxyV2Header("198.51.100.61", 50_000),
      servername,
    );

    const chunks: string[] = [];

    const streamed = await http2Request(
      visitor,
      {
        ":path": "/stream",
        ":authority": authority,
        cookie: [cookie, "theme=dark"],
      },
      (chunk) => {
        chunks.push(chunk);
        releaseOrigin();
      },
    );

    const visitorSocket = new WebSocket(`wss://${authority}/socket`, {
      headers: { cookie },
      createConnection: await tlsFactoryThroughProxy(
        port,
        proxyV2Header("198.51.100.62", 50_000),
        servername,
        ["http/1.1"],
      ),
    });

    visitorSocket.on("error", () => {});
    closers.push(() => visitorSocket.terminate());
    await once(visitorSocket, "open");
    visitorSocket.send("ping");
    const [reply] = await once(visitorSocket, "message");

    expect({
      status: streamed.status,
      body: streamed.body,
      firstChunk: chunks[0],
      origin: streamed.headers["x-origin"],
      hsts: streamed.headers["strict-transport-security"],
      forbidden: forbiddenHeaderNames(streamed.headers),
      originCookie,
    }).toEqual({
      status: 200,
      body: "first chunk\nsecond chunk\n",
      firstChunk: "first chunk\n",
      origin: "streamed",
      hsts: RELAY_STRICT_TRANSPORT_SECURITY,
      forbidden: [],
      originCookie: "theme=dark",
    });
    expect(String(reply)).toBe("echo:ping");
    expect(events).not.toContain("gate.failure");

    await relay.shutdown();
    relay = null;

    expect(egressBytes(databasePath, owner.userId)).toBeGreaterThanOrEqual(
      streamed.body.length,
    );
  });

  it("closes an h2 connection that holds no stream past the header deadline", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port, {
      requestHeadersTimeoutMs: 300,
      idleTimeoutMs: LONG_MS,
    });

    const silent = await http2ThroughProxy(
      port,
      proxyV2Header("198.51.100.70", 50_000),
    );

    const served = await http2ThroughProxy(
      port,
      proxyV2Header("198.51.100.71", 50_000),
    );

    const response = await http2Request(served, {
      ":path": "/",
      ":authority": `healthcheck.${BASE_DOMAIN}:${port}`,
    });

    expect(response.status).toBe(200);
    expect({
      silent: await sessionClosedWithin(silent, OBSERVE_MS),
      served: await sessionClosedWithin(served, OBSERVE_MS),
    }).toEqual({ silent: true, served: true });
  });

  it("sends GOAWAY to open h2 connections on shutdown", async () => {
    await writeSelfSignedCertificate();
    const port = await freePort();
    relay = await start(port);

    const client = await http2ThroughProxy(
      port,
      proxyV2Header("198.51.100.72", 50_000),
    );

    await http2Request(client, {
      ":path": "/",
      ":authority": `healthcheck.${BASE_DOMAIN}:${port}`,
    });

    const goaway = once(client, "goaway");
    await relay.shutdown();
    relay = null;
    const [code] = await goaway;

    expect(code).toBe(0);
    expect(await sessionClosedWithin(client, OBSERVE_MS)).toBe(true);
  });
});
