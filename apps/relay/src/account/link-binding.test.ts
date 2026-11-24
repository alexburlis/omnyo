import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_CREDENTIAL_HEADER,
  machine,
  server,
  user,
} from "@omnyo/connect-db";
import {
  createGitHubOAuthStub,
  type GitHubOAuthStub,
  isExpiredSetCookie,
  parseSetCookie,
} from "../auth/github-oauth-stub.js";
import { createRelayAuth } from "../auth/index.js";
import { parseRelayConfig, type RelayConfig } from "../config.js";
import { CLIENT_IP_HEADER, type RelayLogger } from "../contracts.js";
import { type RelayDatabase, openRelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { createRelayRateLimiters } from "../rate-limit.js";
import { createTunnelRegistry } from "../tunnel/registry.js";
import { deleteUserRows } from "../user-blocks.js";
import { ACCOUNT_RATE_LIMITS, createAccountApp } from "./routes.js";

const APP_URL = "https://relay.test";

const BASE_DOMAIN = "relay.test";

const VICTIM_IP = "198.51.100.30";

const silent: RelayLogger = { info() {}, warn() {}, error() {} };

let database: RelayDatabase;

let config: RelayConfig;

let account: ReturnType<typeof createAccountApp>;

let github: GitHubOAuthStub;

let clock: number;

beforeEach(() => {
  clock = Date.now();
  config = parseRelayConfig({
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
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  github = createGitHubOAuthStub({
    id: 777002,
    login: "victim-user",
    name: "Victim",
    email: "victim@example.com",
  });
  vi.stubGlobal("fetch", github.fetch);
  const now = () => clock;

  account = createAccountApp({
    config,
    database,
    tunnels: createTunnelRegistry({
      database,
      log: silent,
      maxBufferedBytes: config.maxBufferedBytes,
      now,
    }),
    revocations: { record() {} },
    rateLimits: createRelayRateLimiters(now),
    auth: createRelayAuth(config, database).service,
    log: silent,
    now,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
});

async function hit(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    ip?: string;
  } = {},
): Promise<Response> {
  return account.fetch(
    new Request(`${APP_URL}${path}`, {
      method: init.method ?? "GET",
      headers: new Headers({
        [CLIENT_IP_HEADER]: init.ip ?? VICTIM_IP,
        ...init.headers,
      }),
      body: init.body,
    }),
  );
}

function jar(responses: Response[]): string {
  const cookies = new Map<string, string>();

  for (const response of responses) {
    for (const raw of response.headers.getSetCookie()) {
      const parsed = parseSetCookie(raw);

      if (isExpiredSetCookie(parsed)) cookies.delete(parsed.name);
      else cookies.set(parsed.name, parsed.value);
    }
  }

  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function signIn(): Promise<string> {
  const start = await hit("/sign-in", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ next: "/dashboard" }).toString(),
  });

  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") ?? "");
  const callback = new URL(`${APP_URL}/api/auth/callback/github`);
  callback.searchParams.set("code", github.issueCode());
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");

  const done = await account.fetch(
    new Request(callback, {
      headers: new Headers({
        [CLIENT_IP_HEADER]: VICTIM_IP,
        cookie: jar([start]),
      }),
    }),
  );

  expect(done.status).toBe(302);

  return jar([start, done]);
}

function postForm(
  cookie: string,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return hit(path, {
    method: "POST",
    headers: {
      cookie,
      origin: APP_URL,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function signedInWithHandle(): Promise<string> {
  const cookie = await signIn();

  const claimed = await postForm(cookie, "/dashboard/claim-handle", {
    handle: "victim-user",
  });

  expect(claimed.headers.get("location")).toContain("server-claimed");

  return cookie;
}

async function dashboardText(cookie: string): Promise<string> {
  return (await hit("/dashboard", { headers: { cookie } })).text();
}

async function serverIdFor(cookie: string, label: string): Promise<string> {
  const page = await dashboardText(cookie);

  const row = page
    .split("<li>")
    .find((part) => part.includes(`<strong>${label}</strong>`));

  const id = /action="\/dashboard\/servers\/([^/"]+)\/code"/u.exec(
    row ?? "",
  )?.[1];

  if (id === undefined) throw new Error(`no server ${label} on the dashboard`);

  return decodeURIComponent(id);
}

async function addServer(cookie: string, label: string): Promise<string> {
  const added = await postForm(cookie, "/dashboard/servers", { label });

  expect(added.headers.get("location")).toContain("server-added");

  return serverIdFor(cookie, label);
}

async function connect(cookie: string, serverId: string): Promise<string> {
  const page = await (
    await postForm(cookie, `/dashboard/servers/${serverId}/code`, {})
  ).text();

  const code = /<p class="code">([A-Z0-9-]+)<\/p>/u.exec(page)?.[1];

  if (code === undefined) throw new Error("no connect code");

  const redeemed = await hit("/api/connect/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });

  const body: unknown = await redeemed.json();

  if (
    typeof body !== "object" ||
    body === null ||
    !("credential" in body) ||
    typeof body.credential !== "string"
  ) {
    throw new Error("redeem returned no credential");
  }

  return body.credential;
}

async function startLink(
  clientName: string,
  ip: string,
): Promise<{ userCode: string; deviceCode: string }> {
  const response = await hit("/api/account/link/start", {
    method: "POST",
    ip,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientName }),
  });

  const body: unknown = await response.json();

  if (
    typeof body !== "object" ||
    body === null ||
    !("userCode" in body) ||
    !("deviceCode" in body) ||
    typeof body.userCode !== "string" ||
    typeof body.deviceCode !== "string"
  ) {
    throw new Error("link start failed");
  }

  return { userCode: body.userCode, deviceCode: body.deviceCode };
}

async function poll(deviceCode: string): Promise<unknown> {
  const response = await hit("/api/account/link/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });

  return response.json();
}

function visibleText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function suggestedLabel(page: string): string | undefined {
  return /name="label"[^>]*value="([^"]*)"/u.exec(page)?.[1];
}

function victimId(): string {
  const row = database.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.githubLogin, "victim-user"))
    .get();

  if (row === undefined) throw new Error("no victim account");

  return row.id;
}

function setServerCreatedAt(serverId: string, at: number): void {
  database.db
    .update(server)
    .set({ createdAt: new Date(at) })
    .where(eq(server.id, serverId))
    .run();
}

function addPreBindingDevice(createdAt: number, revoked = false): string {
  const id = crypto.randomUUID();

  database.db
    .insert(machine)
    .values({
      id,
      name: "phone",
      userId: victimId(),
      credentialHash: randomBytes(32).toString("hex"),
      createdAt: new Date(createdAt),
      revokedAt: revoked ? new Date(createdAt + 1) : null,
    })
    .run();

  return id;
}

function revokeMachineRoute(credential: string, machineId: string) {
  return hit("/api/connect/revoke-machine", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SERVER_CREDENTIAL_HEADER]: credential,
    },
    body: JSON.stringify({ machineId }),
  });
}

describe("viewing a link request", () => {
  it("allows an account 20 views a minute and then refuses until the minute passes", async () => {
    const cookie = await signedInWithHandle();
    const link = await startLink("MacBook Pro", "203.0.113.66");
    const limit = ACCOUNT_RATE_LIMITS.linkViewPerAccount.limit;
    const statuses: number[] = [];

    for (let index = 0; index <= limit; index += 1) {
      const response = await hit(`/link?code=${link.userCode}`, {
        headers: { cookie },
      });

      statuses.push(response.status);
    }

    expect(statuses.slice(0, limit).every((status) => status === 200)).toBe(
      true,
    );
    expect(statuses.at(-1)).toBe(429);

    clock += 60_000;

    expect(
      (await hit(`/link?code=${link.userCode}`, { headers: { cookie } }))
        .status,
    ).toBe(200);
  });

  it("refuses probing that spreads across accounts from one address", async () => {
    const cookies: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      github.setProfile({
        id: 881_000 + index,
        login: `prober-${index}`,
        name: "Prober",
        email: `prober-${index}@example.com`,
      });
      cookies.push(await signIn());
    }

    const perAccount = ACCOUNT_RATE_LIMITS.linkViewPerAccount.limit;
    const perIp = ACCOUNT_RATE_LIMITS.linkViewPerIp.limit;
    const statuses: number[] = [];

    expect(perAccount * cookies.length).toBeGreaterThan(perIp);

    for (let index = 0; index <= perIp; index += 1) {
      const response = await hit("/link?code=ZZZZ-ZZZZ", {
        headers: { cookie: cookies[Math.floor(index / perAccount)] ?? "" },
      });

      statuses.push(response.status);
    }

    expect(statuses.slice(0, perIp).every((status) => status === 200)).toBe(
      true,
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it("does not count or reveal anything for a visitor who is not signed in", async () => {
    const link = await startLink("MacBook Pro", "203.0.113.66");

    for (let index = 0; index < 80; index += 1) {
      const response = await hit(`/link?code=${link.userCode}`);

      expect(response.status).toBe(200);
      expect(visibleText(await response.text())).not.toContain("MacBook Pro");
    }
  });
});

describe("naming a server from a link request", () => {
  it("never offers or accepts a label that a removed server released", async () => {
    const cookie = await signedInWithHandle();
    const laptopId = await addServer(cookie, "victim-user-laptop");

    const removed = await postForm(
      cookie,
      `/dashboard/servers/${laptopId}/remove`,
      {},
    );

    expect(removed.headers.get("location")).toContain("server-removed");

    const link = await startLink("laptop", "203.0.113.66");

    const page = await (
      await hit(`/link?code=${link.userCode}`, { headers: { cookie } })
    ).text();

    expect(suggestedLabel(page)).toMatch(/^victim-user-laptop-[a-z0-9]{4}$/u);

    const approved = await postForm(cookie, "/link/approve", {
      code: link.userCode,
      kind: "new",
      label: "victim-user-laptop",
    });

    expect(approved.status).toBe(200);
    expect(visibleText(await approved.text())).toContain(
      "You used that name before. Add it from your dashboard first, then connect.",
    );
    expect(await poll(link.deviceCode)).toEqual({ status: "pending" });
    expect(await serverIdFor(cookie, "victim-user")).not.toBe(laptopId);

    const reclaimed = await postForm(cookie, "/dashboard/servers", {
      label: "victim-user-laptop",
    });

    expect(reclaimed.headers.get("location")).toContain("server-added");
  });

  it("does not offer the label of a server the account already has", async () => {
    const cookie = await signedInWithHandle();
    await addServer(cookie, "victim-user-laptop");
    const link = await startLink("laptop", "203.0.113.66");

    const page = await (
      await hit(`/link?code=${link.userCode}`, { headers: { cookie } })
    ).text();

    expect(suggestedLabel(page)).toMatch(/^victim-user-laptop-[a-z0-9]{4}$/u);
  });

  it("still offers the plain label when it is free", async () => {
    const cookie = await signedInWithHandle();
    const link = await startLink("laptop", "203.0.113.66");

    const page = await (
      await hit(`/link?code=${link.userCode}`, { headers: { cookie } })
    ).text();

    expect(suggestedLabel(page)).toBe("victim-user-laptop");
  });
});

describe("choosing an existing server from a link request", () => {
  async function refusesExisting(cookie: string, serverId: string) {
    const link = await startLink("work", "203.0.113.67");

    const page = await (
      await hit(`/link?code=${link.userCode}`, { headers: { cookie } })
    ).text();

    expect(page).not.toContain(`value="${serverId}"`);

    const approved = await postForm(cookie, "/link/approve", {
      code: link.userCode,
      kind: "existing",
      serverId,
    });

    expect(approved.status).toBe(200);
    expect(visibleText(await approved.text())).toContain(
      "Reconnect that server from your dashboard.",
    );
    expect(await poll(link.deviceCode)).toEqual({ status: "pending" });
  }

  it("offers a never-connected server whose address was never released", async () => {
    const cookie = await signedInWithHandle();
    const workId = await addServer(cookie, "victim-user-work");
    const link = await startLink("work", "203.0.113.67");

    const page = await (
      await hit(`/link?code=${link.userCode}`, { headers: { cookie } })
    ).text();

    expect(page).toContain(`value="${workId}"`);
  });

  it("refuses a server recreated on an address a removed server released", async () => {
    const cookie = await signedInWithHandle();
    const firstId = await addServer(cookie, "victim-user-work");
    await connect(cookie, firstId);
    await postForm(cookie, `/dashboard/servers/${firstId}/disconnect`, {});

    const removed = await postForm(
      cookie,
      `/dashboard/servers/${firstId}/remove`,
      {},
    );

    expect(removed.headers.get("location")).toContain("server-removed");
    const recreatedId = await addServer(cookie, "victim-user-work");

    await refusesExisting(cookie, recreatedId);
  });

  it("refuses the default server of a handle reclaimed after the account was deleted", async () => {
    const first = await signedInWithHandle();
    await connect(first, await serverIdFor(first, "victim-user"));
    deleteUserRows(database.db, { userId: victimId(), at: clock });

    const cookie = await signIn();

    const claimed = await postForm(cookie, "/dashboard/claim-handle", {
      handle: "victim-user",
    });

    expect(claimed.headers.get("location")).toContain("server-claimed");

    await refusesExisting(cookie, await serverIdFor(cookie, "victim-user"));
  });
});

describe("the Connect plugin revoking a device with its server credential", () => {
  it("revokes a device paired before binding, but not from a server created after it", async () => {
    const cookie = await signedInWithHandle();
    const homeId = await serverIdFor(cookie, "victim-user");
    const homeCredential = await connect(cookie, homeId);
    const lateId = await addServer(cookie, "victim-user-late");
    const lateCredential = await connect(cookie, lateId);
    const base = Date.now() - 60 * 60 * 1000;

    setServerCreatedAt(homeId, base);
    const legacy = addPreBindingDevice(base + 1_000);
    setServerCreatedAt(lateId, base + 2_000);

    const refused = await revokeMachineRoute(lateCredential, legacy);

    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "not-found" });

    const revoked = await revokeMachineRoute(homeCredential, legacy);

    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });

    expect(
      database.db
        .select({ revokedAt: machine.revokedAt })
        .from(machine)
        .where(eq(machine.id, legacy))
        .get()?.revokedAt,
    ).not.toBeNull();
  });
});

describe("a connect code for a disconnected server that still has devices", () => {
  it("says that the code takes over the address and counts the devices", async () => {
    const cookie = await signedInWithHandle();
    const homeId = await serverIdFor(cookie, "victim-user");
    await connect(cookie, homeId);
    const base = Date.now() - 60 * 60 * 1000;

    setServerCreatedAt(homeId, base);
    addPreBindingDevice(base + 1_000);
    addPreBindingDevice(base + 2_000);
    addPreBindingDevice(base + 3_000, true);

    expect(
      (
        await postForm(cookie, `/dashboard/servers/${homeId}/disconnect`, {})
      ).headers.get("location"),
    ).toContain("server-disconnected");

    const page = visibleText(
      await (
        await postForm(cookie, `/dashboard/servers/${homeId}/code`, {})
      ).text(),
    );

    expect(page).toContain(
      "It takes over this server's address and the 2 devices paired with it. Revoke any device you don't recognize first.",
    );
    expect(page).not.toContain("takes over this connected server");
  });

  it("stays quiet for a server nothing was ever paired to", async () => {
    const cookie = await signedInWithHandle();
    const homeId = await serverIdFor(cookie, "victim-user");
    const base = Date.now() - 60 * 60 * 1000;

    setServerCreatedAt(homeId, base);
    const lateId = await addServer(cookie, "victim-user-late");
    setServerCreatedAt(lateId, base + 2_000);
    addPreBindingDevice(base + 1_000);

    const page = visibleText(
      await (
        await postForm(cookie, `/dashboard/servers/${lateId}/code`, {})
      ).text(),
    );

    expect(page).toContain("Connect code");
    expect(page).not.toContain("takes over");
  });
});
