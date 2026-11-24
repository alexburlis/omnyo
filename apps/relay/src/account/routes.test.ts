import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectCode, labelClaim, machine, server } from "@omnyo/connect-db";
import { CLIENT_IP_HEADER, type LogFieldValue } from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { createRelayRateLimiters } from "../rate-limit.js";
import { SESSION_COOKIE_NAME, STATE_COOKIE_NAME } from "../auth/cookies.js";
import {
  createGitHubOAuthStub,
  GITHUB_ALLOWED_HOSTS,
  type GitHubOAuthStub,
  parseSetCookie,
} from "../auth/github-oauth-stub.js";
import { createRelayAuth } from "../auth/index.js";
import { OWNER_REVOKED_CLOSE_REASON } from "./deps.js";
import { createAccountApp } from "./routes.js";
import { weeklyCatalogShareId } from "./catalog-workflow.js";

const APP_URL = "https://relay.example";

const ROOT_KEY_MATERIAL = "routes-root-key-material-for-tests-0123456789";

const OWNER_IP = "198.51.100.20";

interface LogEntry {
  level: string;
  event: string;
  fields: Readonly<Record<string, LogFieldValue>> | undefined;
}

let database: RelayDatabase;

let github: GitHubOAuthStub;

let app: ReturnType<typeof createAccountApp>;

let connected: Set<string>;

let closed: Array<[string, string]>;

let logs: LogEntry[];

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  github = createGitHubOAuthStub({
    id: 4242,
    login: "Sawyer",
    name: "Sawyer",
    email: "sawyer@example.com",
  });
  vi.stubGlobal("fetch", github.fetch);
  connected = new Set();
  closed = [];
  logs = [];

  const relayAuth = createRelayAuth(
    {
      appUrl: APP_URL,
      betterAuthSecret: ROOT_KEY_MATERIAL,
      github: {
        clientId: "relay-test-client",
        clientSecret: "relay-test-oauth",
      },
    },
    database,
  );

  const capture =
    (level: string) =>
    (event: string, fields?: Readonly<Record<string, LogFieldValue>>) => {
      logs.push({ level, event, fields });
    };

  app = createAccountApp({
    revocations: { record: () => {} },
    recordShareRevocation: () => {},
    config: {
      appUrl: APP_URL,
      baseDomain: "relay.example",
      securityContact: "abuse@relay.example",
    },
    database,
    tunnels: {
      has: (key) => connected.has(key),
      close: (key, reason) => {
        closed.push([key, reason]);
        connected.delete(key);
      },
    },
    rateLimits: createRelayRateLimiters(),
    auth: relayAuth.service,
    log: {
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
    },
    now: Date.now,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
});

interface Browser {
  cookies: Map<string, string>;
  ip: string;
}

function browser(ip = OWNER_IP): Browser {
  return { cookies: new Map(), ip };
}

function cookieHeader(client: Browser): string | null {
  if (client.cookies.size === 0) return null;

  return [...client.cookies]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function absorb(client: Browser, response: Response): void {
  for (const raw of response.headers.getSetCookie()) {
    const cookie = parseSetCookie(raw);
    const maxAge = cookie.attributes.get("max-age");

    if (maxAge !== undefined && Number(maxAge) <= 0)
      client.cookies.delete(cookie.name);
    else client.cookies.set(cookie.name, cookie.value);
  }
}

async function send(
  client: Browser,
  path: string,
  init: RequestInit & { form?: Record<string, string>; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(CLIENT_IP_HEADER, client.ip);
  const cookie = cookieHeader(client);

  if (cookie !== null) headers.set("cookie", cookie);
  let body = init.body;

  if (init.form !== undefined) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    headers.set("origin", APP_URL);
    headers.set(
      "sec-fetch-site",
      headers.get("sec-fetch-site") ?? "same-origin",
    );
    body = new URLSearchParams(init.form).toString();
  }

  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }

  const response = await app.fetch(
    new Request(`${APP_URL}${path}`, {
      method: init.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
    }),
  );

  absorb(client, response);

  return response;
}

async function signIn(client: Browser, next = "/dashboard"): Promise<Response> {
  const started = await send(client, "/sign-in", { form: { next } });
  expect(started.status).toBe(302);
  expect(client.cookies.has(STATE_COOKIE_NAME)).toBe(true);
  const authorize = new URL(started.headers.get("location") ?? "");
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  expect(callback.origin).toBe(APP_URL);
  callback.searchParams.set("code", github.issueCode());
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");

  const finished = await send(
    client,
    `${callback.pathname}${callback.search}`,
    {
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" },
    },
  );

  expect(finished.status).toBe(302);
  expect(client.cookies.has(SESSION_COOKIE_NAME)).toBe(true);
  expect(client.cookies.has(STATE_COOKIE_NAME)).toBe(false);

  return finished;
}

async function claim(client: Browser, handle: string): Promise<void> {
  const claimed = await send(client, "/dashboard/claim-handle", {
    form: { handle },
  });

  expect(claimed.status).toBe(303);
  expect(claimed.headers.get("location")).toBe(
    "/dashboard?notice=server-claimed",
  );
}

function serverId(subdomain: string): string {
  const row = database.db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.subdomain, subdomain))
    .get();

  if (row === undefined) throw new Error(`no server ${subdomain}`);

  return row.id;
}

function connectCodeFrom(html: string): string {
  const match = /class="code">([A-Z2-9]{4}-[A-Z2-9]{4})</u.exec(html);

  if (match?.[1] === undefined) throw new Error("no code on page");

  return match[1];
}

describe("account app: dashboard journey", () => {
  it("signs in with GitHub, claims a handle, mints a code and pairs a server", async () => {
    const owner = browser();
    const signedOut = await send(owner, "/dashboard");
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain("Continue with GitHub");

    const landed = await signIn(owner);
    expect(landed.headers.get("location")).toBe("/dashboard");

    const fresh = await send(owner, "/dashboard");
    const freshHtml = await fresh.text();
    expect(freshHtml).toContain("Signed in as @Sawyer");
    expect(freshHtml).toContain('value="sawyer"');

    await claim(owner, "sawyer");

    const codePage = await send(
      owner,
      `/dashboard/servers/${serverId("sawyer")}/code`,
      {
        form: {},
      },
    );

    expect(codePage.status).toBe(200);
    const code = connectCodeFrom(await codePage.text());

    const redeemed = await send(browser("203.0.113.9"), "/api/connect/redeem", {
      json: { code },
    });

    expect(redeemed.status).toBe(200);

    const pairing = (await redeemed.json()) as {
      credential: string;
      handle: string;
    };

    expect(pairing.handle).toBe("sawyer");

    const me = await send(browser("203.0.113.9"), "/api/account/me", {
      headers: { authorization: `Bearer ${pairing.credential}` },
    });

    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      githubLogin: "Sawyer",
      serverLabel: "sawyer",
      serverUrl: "https://sawyer.relay.example",
    });

    connected.add("sawyer");
    const servers = await send(owner, "/api/connect/servers");
    expect(await servers.json()).toEqual({
      servers: [{ handle: "sawyer", name: "default", live: true }],
    });

    const disconnected = await send(
      owner,
      `/dashboard/servers/${serverId("sawyer")}/disconnect`,
      { form: {} },
    );

    expect(disconnected.headers.get("location")).toBe(
      "/dashboard?notice=server-disconnected",
    );
    expect(closed).toEqual([["sawyer", OWNER_REVOKED_CLOSE_REASON]]);

    const refused = await send(browser("203.0.113.9"), "/api/account/me", {
      headers: { authorization: `Bearer ${pairing.credential}` },
    });

    expect(refused.status).toBe(401);

    const signedOutAgain = await send(owner, "/sign-out", { form: {} });
    expect(signedOutAgain.status).toBe(302);
    expect(owner.cookies.has(SESSION_COOKIE_NAME)).toBe(false);
    expect((await send(owner, "/api/connect/servers")).status).toBe(401);

    for (const request of github.requests) {
      expect(GITHUB_ALLOWED_HOSTS.has(request.hostname)).toBe(true);
    }

    const sessionValue = [...owner.cookies.values()].join("|");
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(pairing.credential);
    expect(sessionValue === "" || !logged.includes(sessionValue)).toBe(true);
    expect(logs.some((entry) => entry.event === "apex.request")).toBe(true);
  });

  it("revokes a paired device and closes its tunnel with the owner reason", async () => {
    const owner = browser();
    await signIn(owner);
    await claim(owner, "sawyer");

    const serverCredential = (await (
      await send(browser(), "/api/connect/redeem", {
        json: {
          code: connectCodeFrom(
            await (
              await send(
                owner,
                `/dashboard/servers/${serverId("sawyer")}/code`,
                {
                  form: {},
                },
              )
            ).text(),
          ),
        },
      })
    ).json()) as { credential: string };

    const minted = await send(browser(), "/api/connect/machine-code", {
      method: "POST",
      headers: { "x-omnyo-connect-machine": serverCredential.credential },
    });

    expect(minted.status).toBe(200);
    const { code } = (await minted.json()) as { code: string };

    const device = await send(
      browser("192.0.2.44"),
      "/api/connect/redeem-machine",
      {
        json: { code, deviceName: "Phone" },
      },
    );

    expect(device.status).toBe(200);
    const { machineId } = (await device.json()) as { machineId: string };
    database.db
      .insert(labelClaim)
      .values({
        label: "sawyer-phone",
        kind: "machine",
        ownerId: machineId,
        userId: database.db.select().from(machine).get()?.userId ?? "",
        generation: "g1",
        createdAt: new Date(),
      })
      .run();

    const dashboard = await (await send(owner, "/dashboard")).text();
    expect(dashboard).toContain("Phone");

    const revoked = await send(
      owner,
      `/dashboard/machines/${machineId}/revoke`,
      {
        form: {},
      },
    );

    expect(revoked.headers.get("location")).toBe(
      "/dashboard?notice=machine-revoked",
    );
    expect(closed).toContainEqual([
      "sawyer-phone:g1",
      OWNER_REVOKED_CLOSE_REASON,
    ]);
    expect(
      database.db.select().from(machine).where(eq(machine.id, machineId)).get()
        ?.revokedAt,
    ).toBeInstanceOf(Date);
  });

  it("ignores a returnTo to an address the user does not hold", async () => {
    const owner = browser();

    const page = await (
      await send(
        owner,
        "/dashboard?returnTo=https%3A%2F%2Fsawyer.relay.example%2Fchat",
      )
    ).text();

    expect(page).toContain(
      'value="/dashboard?returnTo=https%3A%2F%2Fsawyer.relay.example%2Fchat"',
    );

    const landed = await signIn(
      owner,
      "/dashboard?returnTo=https%3A%2F%2Fsawyer.relay.example%2Fchat",
    );

    const bounced = await send(owner, landed.headers.get("location") ?? "");
    expect(bounced.status).toBe(200);
    expect(bounced.headers.get("location")).toBeNull();

    for (const foreign of [
      "https://evil.test/",
      "https://a.b.relay.example/",
      "http://sawyer.relay.example/",
    ]) {
      const response = await send(
        owner,
        `/dashboard?returnTo=${encodeURIComponent(foreign)}`,
      );

      expect(response.status, foreign).toBe(200);
    }
  });

  it("refuses an unsafe sign-in next path", async () => {
    for (const next of [
      "https://evil.test/",
      "//evil.test",
      "/%09/evil.test",
      "/\\evil.test",
    ]) {
      const response = await send(browser(), "/sign-in", { form: { next } });

      expect(response.status, next).toBe(400);
      expect(response.headers.getSetCookie(), next).toEqual([]);
    }
  });
});

describe("account app: same-origin and framing", () => {
  it("rejects cross-site and same-site form posts and foreign origins", async () => {
    const owner = browser();
    await signIn(owner);

    for (const site of ["same-site", "cross-site"]) {
      const response = await send(owner, "/dashboard/claim-handle", {
        form: { handle: "sawyer" },
        headers: { "sec-fetch-site": site },
      });

      expect(response.status, site).toBe(403);
    }

    const foreign = await app.fetch(
      new Request(`${APP_URL}/dashboard/claim-handle`, {
        method: "POST",
        headers: {
          [CLIENT_IP_HEADER]: OWNER_IP,
          cookie: cookieHeader(owner) ?? "",
          origin: "https://sawyer.relay.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "handle=sawyer",
      }),
    );

    expect(foreign.status).toBe(403);
    expect(database.db.select().from(server).all()).toHaveLength(0);
  });

  it("refuses to be framed by a sibling tenant and sets framing headers", async () => {
    const framed = await send(browser(), "/dashboard", {
      headers: { "sec-fetch-site": "same-site", "sec-fetch-dest": "iframe" },
    });

    expect(framed.status).toBe(403);

    const page = await send(browser(), "/dashboard");
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(page.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("does not accept bearer credentials on the cookie-only servers route", async () => {
    const response = await send(browser(), "/api/connect/servers", {
      headers: { authorization: "Bearer bbcred_nothing" },
    });

    expect(response.status).toBe(401);
  });
});

describe("account app: link flow", () => {
  it("links a computer through start, approval and poll", async () => {
    const computer = browser("203.0.113.30");

    const started = await send(computer, "/api/account/link/start", {
      json: { clientName: "Sawyer MacBook" },
    });

    expect(started.status).toBe(200);

    const link = (await started.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUrl: string;
    };

    const verification = new URL(link.verificationUrl);
    expect(verification.origin).toBe(APP_URL);

    const owner = browser();

    const gated = await (
      await send(owner, `${verification.pathname}${verification.search}`)
    ).text();

    expect(gated).toContain("Continue with GitHub");
    await signIn(owner, `${verification.pathname}${verification.search}`);

    const claimView = await (
      await send(owner, `/link?code=${link.userCode}`)
    ).text();

    expect(claimView).toContain("First, pick your address");
    expect(claimView).toContain("203.0.113.30");

    const claimed = await send(owner, "/link/claim-handle", {
      form: { code: link.userCode, handle: "sawyer" },
    });

    expect(claimed.headers.get("location")).toBe(`/link?code=${link.userCode}`);

    const chooseView = await (
      await send(owner, `/link?code=${link.userCode}`)
    ).text();

    expect(chooseView).toContain("Where should this Omnyo live?");

    const pending = await send(computer, "/api/account/link/poll", {
      json: { deviceCode: link.deviceCode },
    });

    expect(await pending.json()).toEqual({ status: "pending" });

    const approved = await send(owner, "/link/approve", {
      form: { code: link.userCode, kind: "new", label: "sawyer-mac" },
    });

    expect(approved.status).toBe(303);

    const done = await (
      await send(owner, `/link?code=${link.userCode}`)
    ).text();

    expect(done).toContain("https://sawyer-mac.relay.example");

    database.db
      .update(connectCode)
      .set({ polledAt: new Date(0) })
      .where(eq(connectCode.code, link.userCode))
      .run();

    const delivered = await send(computer, "/api/account/link/poll", {
      json: { deviceCode: link.deviceCode },
    });

    expect(await delivered.json()).toMatchObject({
      status: "approved",
      handle: "sawyer-mac",
      serverUrl: "https://sawyer-mac.relay.example",
      tunnelUrl: "wss://sawyer-mac.relay.example/__tunnel",
    });
  });

  it("denies a link request from the approval page", async () => {
    const started = (await (
      await send(browser("203.0.113.31"), "/api/account/link/start", {
        json: { clientName: "Unknown" },
      })
    ).json()) as { userCode: string };

    const owner = browser();
    await signIn(owner);

    const denied = await send(owner, "/link/deny", {
      form: { code: started.userCode },
    });

    expect(denied.status).toBe(200);
    expect(await denied.text()).toContain("Request denied.");
  });

  it("refuses link start without a derived client IP", async () => {
    const response = await app.fetch(
      new Request(`${APP_URL}/api/account/link/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.30",
        },
        body: JSON.stringify({ clientName: "Mac" }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "client-ip-unavailable" });
    expect(logs.some((entry) => entry.event === "apex.client-ip-missing")).toBe(
      true,
    );
  });
});

describe("account app: rate limits use the derived client IP", () => {
  it("limits code redemption per derived IP and ignores forged forwarding headers", async () => {
    const attacker = browser("203.0.113.66");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await send(attacker, "/api/connect/redeem", {
        json: { code: "AAAA-AAAA" },
        headers: { "x-forwarded-for": `192.0.2.${attempt}` },
      });

      expect(response.status).toBe(404);
    }

    const limited = await send(attacker, "/api/connect/redeem", {
      json: { code: "AAAA-AAAA" },
      headers: { "x-forwarded-for": "192.0.2.200" },
    });

    expect(limited.status).toBe(429);

    const machineLimited = await send(attacker, "/api/connect/redeem-machine", {
      json: { code: "AAAA-AAAA" },
    });

    expect(machineLimited.status).toBe(429);

    const other = await send(browser("203.0.113.67"), "/api/connect/redeem", {
      json: { code: "AAAA-AAAA" },
    });

    expect(other.status).toBe(404);
  });

  it("limits sign-in starts to 20 per minute per IP", async () => {
    const client = browser("203.0.113.70");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        (await send(client, "/sign-in", { form: { next: "/dashboard" } }))
          .status,
      ).toBe(302);
    }

    expect(
      (await send(client, "/sign-in", { form: { next: "/dashboard" } })).status,
    ).toBe(429);
    expect(
      (
        await send(browser("203.0.113.71"), "/sign-in", {
          form: { next: "/dashboard" },
        })
      ).status,
    ).toBe(302);
  });
});

it("requires the owning server credential to list paired devices", async () => {
  const owner = browser();
  await signIn(owner);
  await claim(owner, "sawyer");

  const page = await send(
    owner,
    `/dashboard/servers/${serverId("sawyer")}/code`,
    { form: {} },
  );

  const redeemed = await send(browser(), "/api/connect/redeem", {
    json: { code: connectCodeFrom(await page.text()) },
  });

  const credentials: { credential: string } = await redeemed.json();
  const unauthorized = await send(browser(), "/api/connect/devices");
  expect(unauthorized.status).toBe(401);

  const response = await send(browser(), "/api/connect/devices", {
    headers: { "x-omnyo-connect-machine": credentials.credential },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ devices: [] });
});

describe("workflow distribution", () => {
  const file = JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    title: "Synthetic workflow",
    description: "Fictional inputs only",
    inputs: [],
    trigger: { kind: "manual" },
    flow: { kind: "prompt", prompt: "Write fictional text." },
    skills: [],
  });

  it("refuses new workflow links for a signed-in account", async () => {
    const owner = browser();
    await signIn(owner);
    const origin = { origin: APP_URL };
    const form = new FormData();
    form.set("file", new File([file], "workflow.omnyoworkflow"));

    expect(
      (
        await send(owner, "/api/workflow-shares", {
          body: file,
          headers: origin,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(owner, "/dashboard/workflows", {
          body: form,
          headers: origin,
        })
      ).status,
    ).toBe(404);
    const dashboard = await send(owner, "/dashboard/workflows");
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).not.toContain('type="file"');
    expect(
      database.db.get(sql`SELECT 1 FROM relay_workflow_share`),
    ).toBeUndefined();
  });

  it("serves and revokes a legacy link without disclosing its ID in logs", async () => {
    const owner = browser();
    await signIn(owner);
    const user = database.db.get<{ id: string }>(sql`SELECT id FROM user`);

    if (!user) throw new Error("Expected the signed-in fixture owner.");
    const id = "a".repeat(32);
    const expiresAt = Date.now() + 86_400_000;

    const metadata = JSON.stringify({
      id,
      title: "Synthetic workflow",
      description: "Fictional inputs only",
      revision: 1,
      packageDigest: "a".repeat(64),
      executionDigest: "b".repeat(64),
      capabilities: ["model-text"],
      expiresAt,
    });

    database.db.run(
      sql`INSERT INTO relay_workflow_share (id, user_id, package, metadata, created_at, expires_at)
      VALUES (${id}, ${user.id}, ${Buffer.from(file)}, ${metadata}, ${Date.now()}, ${expiresAt})`,
    );
    const download = await send(browser(), `/api/workflow-shares/${id}/file`);
    expect(download.status).toBe(200);
    expect(download.headers.get("referrer-policy")).toBe("no-referrer");
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe(file);
    expect(JSON.stringify(logs)).not.toContain(id);
    expect(
      (
        await send(owner, `/api/workflow-shares/${id}/revoke`, {
          method: "POST",
          headers: { origin: APP_URL },
        })
      ).status,
    ).toBe(200);
    expect((await send(browser(), `/api/workflow-shares/${id}`)).status).toBe(
      404,
    );
  });

  it("keeps the official catalog package downloadable by its existing installer URL", async () => {
    const bytes = await readFile(
      new URL(
        "../../../web/src/workflow-catalog/weekly-content-feed.omnyoworkflow",
        import.meta.url,
      ),
    );

    const fetchPublished = vi.fn(
      async () => new Response(Uint8Array.from(bytes)),
    );

    vi.stubGlobal("fetch", fetchPublished);

    const download = await send(
      browser(),
      `/api/workflow-shares/${weeklyCatalogShareId}/file`,
    );

    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    expect(fetchPublished).toHaveBeenCalledWith(
      expect.stringContaining(
        `/workflows/weekly-content-feed/file/${weeklyCatalogShareId}`,
      ),
      expect.anything(),
    );
  });

  it("limits reads at the anonymous metadata and download entry points", async () => {
    const anonymous = browser("198.51.100.99");
    const url = "/api/workflow-shares/" + "a".repeat(32);

    for (let n = 0; n < 60; n++)
      expect((await send(anonymous, n % 2 ? url : url + "/file")).status).toBe(
        404,
      );
    expect((await send(anonymous, url)).status).toBe(429);
  });
});
