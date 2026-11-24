import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  type IncomingHttpHeaders,
  type Server,
  createServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { SERVER_CREDENTIAL_HEADER } from "@omnyo/connect-db";
import { TunnelSession, type StreamOriginResult } from "@omnyo/tunnel-client";
import {
  PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_QUERY_PARAM,
} from "@omnyo/tunnel-contract";
import { createFileCertificateStore } from "./acme.js";
import {
  type GitHubOAuthStub,
  createGitHubOAuthStub,
  parseSetCookie,
  isExpiredSetCookie,
} from "./auth/github-oauth-stub.js";
import {
  RELAY_RESTART_CLOSE_CODE,
  type LogFieldValue,
  type RelayLogger,
} from "./contracts.js";
import {
  REVOCATION_JOURNAL_FILE,
  type RunningRelay,
  startRelay,
} from "./main.js";
import { sourceMigrationDirectories } from "./migrations.js";

const BASE_DOMAIN = "omnyo.localhost";

const CLIENT_IP = "203.0.113.7";

const OWNER_HANDLE = "sawyer";

const OWNER_PROFILE = {
  id: 1001,
  login: OWNER_HANDLE,
  email: "sawyer@example.com",
};

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface LogRecord {
  level: string;
  event: string;
  fields: Readonly<Record<string, LogFieldValue>>;
}

let directory: string;

let relayPort: number;

let relay: RunningRelay;

let origin: Server;

let originPort: number;

let github: GitHubOAuthStub;

const logs: LogRecord[] = [];

const originSeen: IncomingHttpHeaders[] = [];

const tunnels: WebSocket[] = [];

const capture =
  (level: string) =>
  (event: string, fields: Readonly<Record<string, LogFieldValue>> = {}) => {
    logs.push({ level, event, fields });
  };

const log: RelayLogger = {
  info: capture("info"),
  warn: capture("warn"),
  error: capture("error"),
};

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, "close");

  return port;
}

function appOrigin(): string {
  return `http://${BASE_DOMAIN}:${relayPort}`;
}

function tenantOrigin(label: string): string {
  return `http://${label}.${BASE_DOMAIN}:${relayPort}`;
}

function send(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<HttpResult> {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: relayPort,
        method: options.method ?? "GET",
        path: `${target.pathname}${target.search}`,
        headers: {
          host: target.host,
          "x-forwarded-for": CLIENT_IP,
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
          }),
        );
        response.on("error", reject);
      },
    );

    request.on("error", reject);
    request.end(options.body);
  });
}

class Browser {
  private readonly jar = new Map<string, Map<string, string>>();

  readonly values: string[] = [];

  cookieHeader(host: string): string | null {
    const cookies = this.jar.get(host);

    if (cookies === undefined || cookies.size === 0) return null;

    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async fetch(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<HttpResult> {
    const host = new URL(url).host;
    const cookie = this.cookieHeader(host);

    const result = await send(url, {
      ...options,
      headers: {
        accept: "text/html",
        ...(cookie === null ? {} : { cookie }),
        ...options.headers,
      },
    });

    const raw = result.headers["set-cookie"] ?? [];

    for (const line of raw) {
      const parsed = parseSetCookie(line);
      const cookies = this.jar.get(host) ?? new Map<string, string>();
      this.jar.set(host, cookies);

      if (isExpiredSetCookie(parsed)) cookies.delete(parsed.name);
      else {
        cookies.set(parsed.name, parsed.value);
        this.values.push(parsed.value);
      }
    }

    return result;
  }
}

function locationOf(result: HttpResult, base: string): string {
  const location = result.headers.location;

  if (typeof location !== "string") {
    throw new Error(`expected a redirect, got ${result.status}`);
  }

  return new URL(location, base).toString();
}

interface Profile {
  id: number;
  login: string;
  email: string;
}

async function signIn(
  browser: Browser,
  next: string,
  profile: Profile,
): Promise<string> {
  const page = await browser.fetch(
    `${appOrigin()}/sign-in?next=${encodeURIComponent(next)}`,
  );

  expect(page.status).toBe(200);

  const start = await browser.fetch(`${appOrigin()}/sign-in`, {
    method: "POST",
    headers: {
      origin: appOrigin(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ next }).toString(),
  });

  expect(start.status).toBe(302);
  const githubUrl = new URL(locationOf(start, appOrigin()));
  expect(githubUrl.hostname).toBe("github.com");
  const state = githubUrl.searchParams.get("state") ?? "";

  github.setProfile({ ...profile, name: profile.login });
  const code = github.issueCode();

  const callback = await browser.fetch(
    `${appOrigin()}/api/auth/callback/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );

  expect(callback.status).toBe(302);

  return locationOf(callback, appOrigin());
}

async function openTenant(
  browser: Browser,
  label: string,
  path: string,
  profile: Profile,
): Promise<HttpResult> {
  const tenant = tenantOrigin(label);
  const first = await browser.fetch(`${tenant}${path}`);
  expect(first.status).toBe(302);
  const authorizeUrl = locationOf(first, tenant);
  expect(new URL(authorizeUrl).pathname).toBe("/relay/authorize");

  let granted = await browser.fetch(authorizeUrl);

  if (
    granted.status === 302 &&
    new URL(locationOf(granted, appOrigin())).pathname === "/sign-in"
  ) {
    const signInUrl = new URL(locationOf(granted, appOrigin()));

    const back = await signIn(
      browser,
      signInUrl.searchParams.get("next") ?? "",
      profile,
    );

    expect(new URL(back).pathname).toBe("/relay/authorize");
    granted = await browser.fetch(back);
  }

  if (granted.status !== 302) return granted;
  const gateCallback = locationOf(granted, appOrigin());
  expect(new URL(gateCallback).origin).toBe(tenant);
  const landed = await browser.fetch(gateCallback);
  expect(landed.status).toBe(302);
  expect(locationOf(landed, tenant)).toBe(`${tenant}${path}`);

  return browser.fetch(locationOf(landed, tenant));
}

function resolveOrigin(): StreamOriginResult {
  return {
    kind: "ok",
    resolved: {
      origin: `http://127.0.0.1:${originPort}`,
      publicOrigin: tenantOrigin(OWNER_HANDLE),
    },
  };
}

async function pairServer(owner: Browser): Promise<string> {
  const claim = await owner.fetch(`${appOrigin()}/dashboard/claim-handle`, {
    method: "POST",
    headers: {
      origin: appOrigin(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ handle: OWNER_HANDLE }).toString(),
  });

  expect(claim.status).toBe(303);
  expect(locationOf(claim, appOrigin())).toContain("notice=server-claimed");

  const dashboard = await owner.fetch(`${appOrigin()}/dashboard`);

  const codePath = /action="(\/dashboard\/servers\/[^/"]+\/code)"/u.exec(
    dashboard.body,
  )?.[1];

  expect(codePath).toBeDefined();

  const issued = await owner.fetch(`${appOrigin()}${codePath ?? ""}`, {
    method: "POST",
    headers: {
      origin: appOrigin(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
  });

  const connectCode = /<p class="code">([A-Z0-9-]+)<\/p>/u.exec(
    issued.body,
  )?.[1];

  expect(connectCode).toBeDefined();

  const redeemed = await send(`${appOrigin()}/api/connect/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: connectCode }),
  });

  expect(redeemed.status).toBe(200);

  const credential = (JSON.parse(redeemed.body) as { credential?: unknown })
    .credential;

  if (typeof credential !== "string") throw new Error("no credential");

  return credential;
}

async function dialTunnel(
  credential: string,
  label: string = OWNER_HANDLE,
): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${relayPort}/__tunnel?${TUNNEL_PROTOCOL_QUERY_PARAM}=${PROTOCOL_VERSION}`,
    {
      headers: {
        host: `${label}.${BASE_DOMAIN}:${relayPort}`,
        authorization: `Bearer ${credential}`,
        "x-forwarded-for": CLIENT_IP,
      },
    },
  );

  tunnels.push(socket);

  const session = new TunnelSession({
    tunnel: socket,
    log: { warn: () => {}, info: () => {} },
    resolveOrigin,
  });

  socket.once("open", () => session.start());
  await once(socket, "open");

  return socket;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "relay-e2e-"));
  relayPort = await freePort();

  origin = createServer((request, response) => {
    originSeen.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, path: request.url }));
  });
  const originSockets = new WebSocketServer({ noServer: true });
  originSockets.on("connection", (socket) =>
    socket.on("message", (data, isBinary) =>
      socket.send(data, { binary: isBinary }),
    ),
  );
  origin.on("upgrade", (request, socket, head) =>
    originSockets.handleUpgrade(request, socket, head, (ws) =>
      originSockets.emit("connection", ws, request),
    ),
  );
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  originPort = (origin.address() as AddressInfo).port;

  github = createGitHubOAuthStub({
    id: 1001,
    login: OWNER_HANDLE,
    name: OWNER_HANDLE,
    email: "sawyer@example.com",
  });
  vi.stubGlobal("fetch", github.fetch);

  relay = await startRelay({
    env: {
      BASE_DOMAIN,
      APP_URL: `http://${BASE_DOMAIN}:${relayPort}`,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      GITHUB_CLIENT_ID: "relay-e2e-client",
      GITHUB_CLIENT_SECRET: randomBytes(16).toString("hex"),
      DATABASE_PATH: join(directory, "relay.sqlite"),
      PORT: String(relayPort),
      HEALTH_PORT: "0",
      RELAY_CLIENT_IP_SOURCE: "xff-rightmost",
    },
    migrations: sourceMigrationDirectories(),
    lock: () => ({ verify: async () => {} }),
    certificates: createFileCertificateStore,
    log,
  });
});

afterAll(async () => {
  for (const socket of tunnels) socket.terminate();
  await relay?.shutdown();
  origin?.close();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe("relay end to end", () => {
  let ownerCredential = "";

  let ownerBrowser: Browser;

  let ownerTunnel: WebSocket;

  it("reports live on the container-local health listener", async () => {
    const health = await new Promise<HttpResult>((resolve, reject) => {
      httpRequest(
        { host: "127.0.0.1", port: relay.healthPort, path: "/healthz" },
        (response) => {
          let body = "";
          response.on("data", (chunk: Buffer) => (body += chunk.toString()));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body,
            }),
          );
        },
      )
        .on("error", reject)
        .end();
    });

    expect(health.status).toBe(200);
    expect(health.body).toBe("live\n");
    expect(relay.state()).toBe("live");
  });

  it("pairs a server, dials its tunnel and serves the owner through the gate", async () => {
    const owner = new Browser();
    ownerBrowser = owner;

    const landing = await signIn(owner, "/dashboard", OWNER_PROFILE);
    expect(new URL(landing).pathname).toBe("/dashboard");

    ownerCredential = await pairServer(owner);
    ownerTunnel = await dialTunnel(ownerCredential);

    const served = await openTenant(
      owner,
      OWNER_HANDLE,
      "/hello?from=e2e",
      OWNER_PROFILE,
    );

    expect(served.status).toBe(200);
    expect(JSON.parse(served.body)).toEqual({
      method: "GET",
      path: "/hello?from=e2e",
    });

    const seen = originSeen.at(-1);
    expect(seen?.["x-omnyo-gate-auth"]).toBe("session");
    expect(seen?.["x-omnyo-client-ip"]).toBe(CLIENT_IP);
    expect(seen?.cookie ?? "").not.toMatch(/omnyo/u);

    const logText = JSON.stringify(logs);
    expect(logText).not.toContain(ownerCredential);

    for (const value of owner.values) {
      if (value.length >= 16) expect(logText).not.toContain(value);
    }
  });

  it("refuses a second signed-in user with 403", async () => {
    const stranger = new Browser();
    const before = originSeen.length;

    const refused = await openTenant(stranger, OWNER_HANDLE, "/", {
      id: 2002,
      login: "mallory",
      email: "mallory@example.com",
    });

    expect(refused.status).toBe(403);
    expect(refused.body).toContain("isn't your server");
    expect(originSeen.length).toBe(before);

    const direct = await stranger.fetch(`${tenantOrigin(OWNER_HANDLE)}/`);
    expect(direct.status).toBe(302);
    expect(originSeen.length).toBe(before);
  });

  it("revokes a machine from the dashboard: journals it, closes its tunnel and its open visitor socket (P3)", async () => {
    const minted = await send(`${appOrigin()}/api/connect/machine-code`, {
      method: "POST",
      headers: { [SERVER_CREDENTIAL_HEADER]: ownerCredential },
    });

    expect(minted.status).toBe(200);
    const { code } = JSON.parse(minted.body) as { code: string };

    const redeemed = await send(`${appOrigin()}/api/connect/redeem-machine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "laptop" }),
    });

    expect(redeemed.status).toBe(200);

    const device = JSON.parse(redeemed.body) as {
      credential: string;
      machineId: string;
    };

    const labelled = await send(
      `${tenantOrigin(OWNER_HANDLE)}/api/connect/machine-label`,
      {
        method: "POST",
        headers: {
          "x-omnyo-connect-machine": device.credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({ desiredName: "laptop" }),
      },
    );

    expect(labelled.status).toBe(200);
    const { label } = JSON.parse(labelled.body) as { label: string };
    const machineTunnel = await dialTunnel(device.credential, label);
    const tunnelClosed = once(machineTunnel, "close");
    const shareLabel = `${label}--8000`;

    const shared = await openTenant(
      ownerBrowser,
      shareLabel,
      "/shared",
      OWNER_PROFILE,
    );

    expect(shared.status).toBe(200);
    const shareHost = new URL(tenantOrigin(shareLabel)).host;

    const visitor = new WebSocket(`ws://127.0.0.1:${relayPort}/socket`, {
      headers: {
        host: shareHost,
        cookie: ownerBrowser.cookieHeader(shareHost) ?? "",
        "x-forwarded-for": CLIENT_IP,
      },
    });

    await once(visitor, "open");
    visitor.send("before revoke");
    const [echo] = (await once(visitor, "message")) as [Buffer];
    expect(echo.toString()).toBe("before revoke");
    const visitorClosed = once(visitor, "close");
    const startedAt = performance.now();

    const revoked = await ownerBrowser.fetch(
      `${appOrigin()}/dashboard/machines/${device.machineId}/revoke`,
      {
        method: "POST",
        headers: {
          origin: appOrigin(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
      },
    );

    expect(revoked.status).toBe(303);
    expect(locationOf(revoked, appOrigin())).toContain(
      "notice=machine-revoked",
    );

    const [tunnelCode, tunnelReason] = (await tunnelClosed) as [number, Buffer];
    expect(tunnelCode).toBe(1000);
    expect(tunnelReason.toString()).toBe("revoked by owner");

    const [visitorCode] = (await visitorClosed) as [number, Buffer];
    expect(visitorCode).toBe(1001);
    expect(performance.now() - startedAt).toBeLessThan(1000);

    const machineApi = await send(
      `${tenantOrigin(OWNER_HANDLE)}/api/v1/hosts`,
      {
        headers: { "x-omnyo-connect-machine": device.credential },
      },
    );

    expect(machineApi.status).toBe(403);

    const journal = readFileSync(
      join(directory, REVOCATION_JOURNAL_FILE),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(journal).toContainEqual(
      expect.objectContaining({ v: 1, kind: "machine", id: device.machineId }),
    );
  });

  it("closes tunnels with 1012 on shutdown and stops reporting live", async () => {
    const closed = once(ownerTunnel, "close");
    await relay.shutdown();
    const [code] = (await closed) as [number, Buffer];

    expect(code).toBe(RELAY_RESTART_CLOSE_CODE);
    expect(relay.state()).toBe("stopping");
    expect(
      github.requests.every((url) => url.hostname.endsWith("github.com")),
    ).toBe(true);
  });
});
