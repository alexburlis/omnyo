import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_CREDENTIAL_HEADER, machine, user } from "@omnyo/connect-db";
import { AuthFlowError, type RelayAuthService } from "../auth/auth-service.js";
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
import { accountDepsFrom } from "./deps.js";
import { MAX_DEVICE_PAIRINGS_PER_DAY, claimHandle } from "./api.js";
import { ACCOUNT_RATE_LIMITS, createAccountApp } from "./routes.js";

const APP_URL = "https://relay.test";

const BASE_DOMAIN = "relay.test";

const VICTIM_IP = "198.51.100.30";

const VICTIM_PROFILE = {
  id: 777001,
  login: "victim-user",
  name: "Victim",
  email: "victim@example.com",
};

const DOT_SEGMENT_ESCAPES = [
  "/.//evil.test/phish",
  "/..//evil.test/phish",
  "/%2e//evil.test/phish",
  "/.%2e//evil.test/phish",
  "/dashboard/..//evil.test/phish?x=1",
] as const;

const silent: RelayLogger = { info() {}, warn() {}, error() {} };

let database: RelayDatabase;

let config: RelayConfig;

let account: ReturnType<typeof createAccountApp>;

let github: GitHubOAuthStub;

let clock: number;

function buildApp(
  wrap: (service: RelayAuthService) => RelayAuthService = (service) => service,
): ReturnType<typeof createAccountApp> {
  const now = () => clock;

  return createAccountApp({
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
    auth: wrap(createRelayAuth(config, database).service),
    log: silent,
    now,
  });
}

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
  github = createGitHubOAuthStub(VICTIM_PROFILE);
  vi.stubGlobal("fetch", github.fetch);
  account = buildApp();
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

async function signIn(
  next = "/dashboard",
): Promise<{ cookie: string; landing: string }> {
  const start = await hit("/sign-in", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ next }).toString(),
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

  return {
    cookie: jar([start, done]),
    landing: done.headers.get("location") ?? "",
  };
}

async function signInAs(githubId: number): Promise<string> {
  github.setProfile({
    id: githubId,
    login: `neighbour-${githubId}`,
    name: "Neighbour",
    email: `neighbour-${githubId}@example.com`,
  });

  return (await signIn()).cookie;
}

function postForm(
  cookie: string,
  path: string,
  fields: Record<string, string>,
  ip = VICTIM_IP,
): Promise<Response> {
  return hit(path, {
    method: "POST",
    ip,
    headers: {
      cookie,
      origin: APP_URL,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function signedInWithHandle(handle = "victim-user"): Promise<string> {
  const { cookie } = await signIn();
  const claimed = await postForm(cookie, "/dashboard/claim-handle", { handle });

  expect(claimed.headers.get("location")).toContain("server-claimed");

  return cookie;
}

async function primaryServerId(cookie: string): Promise<string> {
  const page = await (await hit("/dashboard", { headers: { cookie } })).text();
  const id = /action="\/dashboard\/servers\/([^/"]+)\/code"/u.exec(page)?.[1];

  if (id === undefined) throw new Error("no server on the dashboard");

  return decodeURIComponent(id);
}

async function connectFromDashboard(
  cookie: string,
  serverId: string,
): Promise<string> {
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
  ip: string,
): Promise<{ userCode: string; deviceCode: string }> {
  const response = await hit("/api/account/link/start", {
    method: "POST",
    ip,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientName: "MacBook Pro" }),
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

async function seedOtherAccount(handle: string): Promise<void> {
  const at = new Date(clock);

  database.db
    .insert(user)
    .values({
      id: `user-${handle}`,
      name: handle,
      email: `${handle}@example.test`,
      emailVerified: true,
      image: null,
      githubLogin: handle,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  const claimed = await claimHandle(
    accountDepsFrom({
      config,
      database,
      tunnels: { has: () => false, close: () => {} },
      revocations: { record() {} },
    }),
    `user-${handle}`,
    handle,
  );

  if ("error" in claimed) throw new Error(claimed.error);
}

describe("sign-in next", () => {
  it("keeps a signed-in visitor on the account site for dot-segment paths", async () => {
    const { cookie } = await signIn();

    for (const next of DOT_SEGMENT_ESCAPES) {
      const response = await hit(`/sign-in?next=${encodeURIComponent(next)}`, {
        headers: { cookie },
      });

      expect(response.status, next).toBe(400);
      expect(response.headers.get("location"), next).toBeNull();
    }
  });

  it("refuses a dot-segment path at the sign-in form post", async () => {
    const response = await hit("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ next: "/.//evil.test/phish" }).toString(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("dashboard returnTo", () => {
  const foreign = `https://mallory.${BASE_DOMAIN}/preview-content/p1/cap1/`;

  it("does not send a freshly signed-in user to an address another account owns", async () => {
    await seedOtherAccount("mallory");
    const next = `/dashboard?returnTo=${encodeURIComponent(foreign)}`;
    const { cookie, landing } = await signIn(next);
    const target = new URL(landing, APP_URL);

    const landed = await hit(`${target.pathname}${target.search}`, {
      headers: { cookie },
    });

    expect(landed.status).toBe(200);
    expect(landed.headers.get("location")).toBeNull();
  });

  it("does not bounce a signed-in user to another account's address in one click", async () => {
    await seedOtherAccount("mallory");
    const { cookie } = await signIn();

    const bounced = await hit(
      `/dashboard?returnTo=${encodeURIComponent(foreign)}`,
      { headers: { cookie } },
    );

    expect(bounced.status).toBe(200);
    expect(bounced.headers.get("location")).toBeNull();
  });

  it("returns a signed-in user to an address they own", async () => {
    const cookie = await signedInWithHandle();
    const own = `https://victim-user.${BASE_DOMAIN}/chat`;

    const returned = await hit(
      `/dashboard?returnTo=${encodeURIComponent(own)}`,
      { headers: { cookie } },
    );

    expect(returned.status).toBe(303);
    expect(returned.headers.get("location")).toBe(own);
  });
});

describe("security.txt", () => {
  it("names this relay's own domain and keeps one expiry for the life of the process", async () => {
    const first = await (await hit("/.well-known/security.txt")).text();

    clock += 24 * 60 * 60 * 1000;
    const later = await (await hit("/.well-known/security.txt")).text();

    expect(first).toContain(`Contact: mailto:abuse@${BASE_DOMAIN}`);
    expect(first).toContain(`Canonical: ${APP_URL}/.well-known/security.txt`);
    expect(first).not.toContain("omnyo.link");
    expect(later).toBe(first);
  });

  it("names the configured contact instead of this relay's domain", async () => {
    config = { ...config, securityContact: "abuse@omnyo.link" };
    account = buildApp();

    const text = await (await hit("/.well-known/security.txt")).text();

    expect(text).toContain("Contact: mailto:abuse@omnyo.link");
    expect(text).not.toContain(`abuse@${BASE_DOMAIN}`);
  });
});

describe("/link page", () => {
  it("says what approval gives and leaves a connected server to the dashboard", async () => {
    const cookie = await signedInWithHandle();
    const serverId = await primaryServerId(cookie);
    const credential = await connectFromDashboard(cookie, serverId);
    const link = await startLink("203.0.113.66");

    const page = await (
      await hit(`/link?code=${link.userCode}`, { headers: { cookie } })
    ).text();

    expect(page).toContain(
      `Only approve if your own computer shows <span class="code">${link.userCode}</span>, because it gets an address in your account.`,
    );
    expect(visibleText(page)).not.toContain("Replace");
    expect(page).not.toContain('name="typedCode"');
    expect(page).not.toContain(`name="serverId" value="${serverId}"`);
    expect(page).toContain(
      'Reconnect a server you used before from your <a href="/dashboard">dashboard</a>.',
    );

    const replace = await postForm(cookie, "/link/approve", {
      code: link.userCode,
      kind: "replace",
      serverId,
      typedCode: link.userCode,
    });

    expect(replace.status).toBe(200);

    const existing = await postForm(cookie, "/link/approve", {
      code: link.userCode,
      kind: "existing",
      serverId,
    });

    expect(existing.status).toBe(200);
    expect(await existing.text()).toContain(
      "Reconnect that server from your dashboard.",
    );

    expect(await poll(link.deviceCode)).toEqual({ status: "pending" });

    const me = await hit("/api/account/me", {
      headers: { [SERVER_CREDENTIAL_HEADER]: credential },
    });

    expect(me.status).toBe(200);
  });

  it("offers a server that was never connected with one click", async () => {
    const cookie = await signedInWithHandle();
    const serverId = await primaryServerId(cookie);
    const link = await startLink("203.0.113.66");

    const page = await (
      await hit(`/link?code=${link.userCode}`, { headers: { cookie } })
    ).text();

    expect(page).toContain(`name="serverId" value="${serverId}"`);
    expect(page).not.toContain("Reconnect a server you used before");

    const approved = await postForm(cookie, "/link/approve", {
      code: link.userCode,
      kind: "existing",
      serverId,
    });

    expect(approved.status).toBe(303);
    expect(await poll(link.deviceCode)).toMatchObject({
      status: "approved",
      handle: "victim-user",
    });
  });
});

describe("connect codes for a connected server", () => {
  it("warns only when the code would take over a server that is already connected", async () => {
    const cookie = await signedInWithHandle();
    const serverId = await primaryServerId(cookie);
    const warning = "takes over this connected server";

    const first = await (
      await postForm(cookie, `/dashboard/servers/${serverId}/code`, {})
    ).text();

    expect(visibleText(first)).not.toContain(warning);
    await connectFromDashboard(cookie, serverId);

    const again = await (
      await postForm(cookie, `/dashboard/servers/${serverId}/code`, {})
    ).text();

    expect(visibleText(again)).toContain(warning);
  });
});

describe("rate limits on account decisions and codes", () => {
  it("refuses an eleventh link decision from one account within a minute", async () => {
    const cookie = await signedInWithHandle();
    const statuses: number[] = [];
    const limit = ACCOUNT_RATE_LIMITS.linkDecisionPerAccount.limit;

    for (let index = 0; index <= limit; index += 1) {
      const path = index % 2 === 0 ? "/link/deny" : "/link/approve";

      const response = await postForm(cookie, path, {
        code: "ZZZZ-ZZZZ",
        kind: "new",
        label: "victim-user-box",
      });

      statuses.push(response.status);
    }

    expect(statuses.slice(0, limit).every((status) => status !== 429)).toBe(
      true,
    );
    expect(statuses.at(-1)).toBe(429);

    clock += 60_000;
    const later = await postForm(cookie, "/link/deny", { code: "ZZZZ-ZZZZ" });

    expect(later.status).toBe(200);
  });

  it("refuses link decisions on unknown codes from one address once its accounts together pass the limit", async () => {
    const perAccount = ACCOUNT_RATE_LIMITS.linkDecisionPerAccount.limit;
    const perIp = ACCOUNT_RATE_LIMITS.linkDecisionPerIp.limit;
    const cookies: string[] = [];

    for (let index = 0; index <= Math.ceil(perIp / perAccount); index += 1) {
      cookies.push(await signInAs(880_000 + index));
    }

    const statuses: number[] = [];

    for (let index = 0; index <= perIp; index += 1) {
      const cookie = cookies[Math.floor(index / perAccount)] ?? "";

      const response = await postForm(cookie, "/link/deny", {
        code: "ZZZZ-ZZZZ",
      });

      statuses.push(response.status);
    }

    expect(statuses.slice(0, perIp).every((status) => status !== 429)).toBe(
      true,
    );
    expect(statuses.at(-1)).toBe(429);

    const elsewhere = await postForm(
      cookies.at(-1) ?? "",
      "/link/deny",
      { code: "ZZZZ-ZZZZ" },
      "198.51.100.99",
    );

    expect(elsewhere.status).toBe(200);
  });

  it("lets an account view and approve its own link request after neighbours at its address used up the address's limit", async () => {
    const perAccount = ACCOUNT_RATE_LIMITS.linkDecisionPerAccount.limit;
    const perIp = ACCOUNT_RATE_LIMITS.linkDecisionPerIp.limit;

    for (let index = 0; index < Math.ceil(perIp / perAccount); index += 1) {
      const neighbour = await signInAs(890_000 + index);

      for (let attempt = 0; attempt < perAccount; attempt += 1) {
        await postForm(neighbour, "/link/deny", { code: "ZZZZ-ZZZZ" });
      }
    }

    const probe = await signInAs(899_999);

    expect(
      (await postForm(probe, "/link/deny", { code: "ZZZZ-ZZZZ" })).status,
    ).toBe(429);

    github.setProfile(VICTIM_PROFILE);
    const cookie = await signedInWithHandle();
    const link = await startLink("203.0.113.66");

    expect(
      (await hit(`/link?code=${link.userCode}`, { headers: { cookie } }))
        .status,
    ).toBe(200);

    const approved = await postForm(cookie, "/link/approve", {
      code: link.userCode,
      kind: "new",
      label: "victim-user-mac",
    });

    expect(approved.status).toBe(303);
  });

  it("refuses an eleventh connect code from one account within a minute", async () => {
    const cookie = await signedInWithHandle();
    const serverId = await primaryServerId(cookie);
    const limit = ACCOUNT_RATE_LIMITS.codeMintPerAccount.limit;
    const statuses: number[] = [];

    for (let index = 0; index <= limit; index += 1) {
      const response = await postForm(
        cookie,
        `/dashboard/servers/${serverId}/code`,
        {},
      );

      statuses.push(response.status);
    }

    expect(statuses.slice(0, limit)).toEqual(
      Array.from({ length: limit }, () => 200),
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it("refuses failed device-code minting from one address past its limit", async () => {
    const limit = ACCOUNT_RATE_LIMITS.machineCodeFailurePerIp.limit;
    const statuses: number[] = [];

    for (let index = 0; index <= limit; index += 1) {
      const response = await hit("/api/connect/machine-code", {
        method: "POST",
        headers: { [SERVER_CREDENTIAL_HEADER]: "omnyocred_unknown" },
      });

      statuses.push(response.status);
    }

    expect(statuses.slice(0, limit)).toEqual(
      Array.from({ length: limit }, () => 401),
    );
    expect(statuses.at(-1)).toBe(429);

    const elsewhere = await hit("/api/connect/machine-code", {
      method: "POST",
      ip: "198.51.100.99",
      headers: { [SERVER_CREDENTIAL_HEADER]: "omnyocred_unknown" },
    });

    expect(elsewhere.status).toBe(401);
  });

  it("keeps the owner's server minting device codes and the dashboard minting connect codes after junk credentials from the same address", async () => {
    const cookie = await signedInWithHandle();
    const serverId = await primaryServerId(cookie);
    const credential = await connectFromDashboard(cookie, serverId);
    const limit = ACCOUNT_RATE_LIMITS.machineCodeFailurePerIp.limit;

    for (let index = 0; index <= limit; index += 1) {
      await hit("/api/connect/machine-code", {
        method: "POST",
        headers: { [SERVER_CREDENTIAL_HEADER]: "omnyocred_unknown" },
      });
    }

    const minted = await hit("/api/connect/machine-code", {
      method: "POST",
      headers: { [SERVER_CREDENTIAL_HEADER]: credential },
    });

    expect(minted.status).toBe(200);
    expect(
      (await postForm(cookie, `/dashboard/servers/${serverId}/code`, {}))
        .status,
    ).toBe(200);
  });

  it("refuses an eleventh device code from one account within a minute, wherever the requests come from", async () => {
    const cookie = await signedInWithHandle();

    const credential = await connectFromDashboard(
      cookie,
      await primaryServerId(cookie),
    );

    const limit = ACCOUNT_RATE_LIMITS.machineCodeMintPerAccount.limit;
    const statuses: number[] = [];

    for (let index = 0; index <= limit; index += 1) {
      const response = await hit("/api/connect/machine-code", {
        method: "POST",
        ip: `198.51.100.${100 + index}`,
        headers: { [SERVER_CREDENTIAL_HEADER]: credential },
      });

      statuses.push(response.status);
    }

    expect(statuses.slice(0, limit)).toEqual(
      Array.from({ length: limit }, () => 200),
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it("refuses a device code once the account has paired its daily allowance of devices", async () => {
    const cookie = await signedInWithHandle();

    const credential = await connectFromDashboard(
      cookie,
      await primaryServerId(cookie),
    );

    const owner = database.db.select({ id: user.id }).from(user).get();

    if (owner === undefined) throw new Error("no user");
    const now = new Date(Date.now());

    database.db
      .insert(machine)
      .values(
        Array.from({ length: MAX_DEVICE_PAIRINGS_PER_DAY }, (_, index) => ({
          id: `churned-${index}`,
          userId: owner.id,
          credentialHash: `churned-hash-${index}`,
          createdAt: now,
          revokedAt: now,
        })),
      )
      .run();

    const refused = await hit("/api/connect/machine-code", {
      method: "POST",
      headers: { [SERVER_CREDENTIAL_HEADER]: credential },
    });

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "pairing-limit" });
  });

  it("does not let one account's refused link decisions use up its address's limit", async () => {
    const perIp = ACCOUNT_RATE_LIMITS.linkDecisionPerIp.limit;
    const noisy = await signInAs(870_001);
    const victim = await signInAs(870_002);

    for (let index = 0; index < perIp; index += 1) {
      await postForm(noisy, "/link/deny", { code: "ZZZZ-ZZZZ" });
    }

    const own = await postForm(victim, "/link/deny", { code: "ZZZZ-ZZZZ" });

    expect(own.status).toBe(200);
  });
});

describe("auth refusals", () => {
  it("shows a 429 page when the session lookup is refused for too many requests", async () => {
    account = buildApp((service) => ({
      ...service,
      resolveSession: async () => {
        throw new AuthFlowError("session lookup failed (429)", 429);
      },
    }));

    const response = await hit("/dashboard", { headers: { cookie: "a=b" } });

    expect(response.status).toBe(429);
    expect(await response.text()).toContain(
      "Too many attempts. Wait a minute and try again.",
    );
  });
});

const HOSTILE = `"'><script>alert(1)</script><img src=x onerror=alert(2)>`;

function expectApexHeaders(response: Response, label: string): void {
  const csp = response.headers.get("content-security-policy") ?? "";

  expect(csp, label).toContain("frame-ancestors 'self'");
  expect(csp, label).toContain("default-src 'none'");
  expect(csp, label).toContain("base-uri 'none'");
  expect(response.headers.get("x-frame-options"), label).toBe("SAMEORIGIN");
  expect(response.headers.get("referrer-policy"), label).toBe(
    "strict-origin-when-cross-origin",
  );
  expect(response.headers.get("x-content-type-options"), label).toBe("nosniff");
}

describe("account site responses", () => {
  it("puts the anti-framing, referrer and nosniff headers on every response", async () => {
    const { cookie } = await signIn();

    const cases: Array<[string, Promise<Response>]> = [
      ["anonymous dashboard", hit("/dashboard")],
      ["sign-in page", hit("/sign-in")],
      ["anonymous link page", hit("/link?code=ABCD-EFGH")],
      ["signed-in dashboard", hit("/dashboard", { headers: { cookie } })],
      [
        "signed-in link page",
        hit("/link?code=ABCD-EFGH", { headers: { cookie } }),
      ],
      ["not found", hit("/nope")],
      ["api not found", hit("/api/nope")],
      ["security.txt", hit("/.well-known/security.txt")],
      [
        "auth error page",
        hit(
          `/api/auth/error?error=X&error_description=${encodeURIComponent(HOSTILE)}`,
        ),
      ],
      ["servers json", hit("/api/connect/servers", { headers: { cookie } })],
      [
        "cross-site mutation refusal",
        hit("/dashboard/servers", {
          method: "POST",
          headers: {
            cookie,
            "sec-fetch-site": "same-site",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "label=abcdef",
        }),
      ],
      [
        "body too large",
        hit("/api/account/link/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientName: "x".repeat(70 * 1024) }),
        }),
      ],
    ];

    for (const [label, pending] of cases)
      expectApexHeaders(await pending, label);
  });

  it("refuses state changes posted from a sandboxed preview page or a sibling address", async () => {
    const { cookie } = await signIn();
    const form = { "content-type": "application/x-www-form-urlencoded" };

    const attempts: Array<Record<string, string>> = [
      { origin: "null", "sec-fetch-site": "cross-site" },
      { origin: `https://evil.${BASE_DOMAIN}`, "sec-fetch-site": "same-site" },
      { origin: `https://evil.${BASE_DOMAIN}` },
      { origin: "null" },
    ];

    for (const extra of attempts) {
      for (const path of [
        "/link/approve",
        "/link/deny",
        "/dashboard/servers",
        "/dashboard/claim-handle",
        "/sign-out",
      ]) {
        const response = await hit(path, {
          method: "POST",
          headers: { cookie, ...form, ...extra },
          body: "code=ABCD-EFGH&kind=new&label=abcdef&handle=abcdef",
        });

        expect(response.status, `${path} ${JSON.stringify(extra)}`).toBe(403);
      }
    }
  });

  it("does not reflect query parameters into pages", async () => {
    const { cookie } = await signIn();
    const payload = encodeURIComponent(HOSTILE);

    for (const response of [
      await hit(`/dashboard?error=${payload}`),
      await hit(`/dashboard?notice=${payload}`, { headers: { cookie } }),
      await hit(`/link?code=${payload}&error=${payload}`, {
        headers: { cookie },
      }),
    ]) {
      const body = await response.text();

      expect(body).not.toContain("<script>");
      expect(body).not.toContain("<img");
    }
  });

  it("answers 404 to better-auth endpoints outside the allowlist, whatever the path spelling", async () => {
    for (const path of [
      "/api/auth/update-user",
      "/api/auth/update-user/",
      "/API/AUTH/update-user",
      "/api/auth/get-session/../update-user",
      "/api/auth/get-session%2F..%2Fupdate-user",
      "/api/auth/change-email",
      "/api/auth/link-social",
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email",
      "/api/auth/delete-user",
      "/api/auth/revoke-sessions",
    ]) {
      const response = await hit(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_URL },
        body: JSON.stringify({ githubLogin: "someone-else", name: "x" }),
      });

      expect(response.status, path).toBe(404);
    }
  });
});
