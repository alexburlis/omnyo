import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "production";
  process.env.TEST = "false";
});

import { session } from "@omnyo/connect-db";
import { createAccountApp } from "../account/routes.js";
import { CLIENT_IP_HEADER, type RelayLogger } from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { createRelayRateLimiters } from "../rate-limit.js";
import { createTunnelRegistry } from "../tunnel/registry.js";
import { SESSION_COOKIE_NAME, STATE_COOKIE_NAME } from "./cookies.js";
import {
  createGitHubOAuthStub,
  type GitHubOAuthStub,
  isExpiredSetCookie,
  parseSetCookie,
} from "./github-oauth-stub.js";
import { createRelayAuth, type RelayAuth } from "./index.js";

const APP_URL = "https://relay.example";

const silent: RelayLogger = { info() {}, warn() {}, error() {} };

let database: RelayDatabase;

let relayAuth: RelayAuth;

let github: GitHubOAuthStub;

let ipCounter = 0;

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  github = createGitHubOAuthStub({
    id: 4242,
    login: "sawyer",
    name: "Sawyer",
    email: "sawyer@example.com",
  });
  vi.stubGlobal("fetch", github.fetch);
  relayAuth = createRelayAuth(
    {
      appUrl: APP_URL,
      betterAuthSecret: "production-auth-root-key-material-0123456789",
      github: {
        clientId: "relay-production-client",
        clientSecret: "relay-production-oauth",
        openSignUp: true,
      },
    },
    database,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
});

function sharedIp(): string {
  ipCounter += 1;

  return `203.0.113.${ipCounter}`;
}

function headersFrom(ip: string, cookie?: string): Headers {
  const headers = new Headers({ [CLIENT_IP_HEADER]: ip });

  if (cookie !== undefined) headers.set("cookie", cookie);

  return headers;
}

async function startSignIn(ip: string) {
  const started = await relayAuth.service.startGitHubSignIn(
    headersFrom(ip),
    "/dashboard",
  );

  const state = new URL(started.headers.get("location") ?? "").searchParams.get(
    "state",
  );

  const stateCookie = started.headers
    .getSetCookie()
    .map(parseSetCookie)
    .find((cookie) => cookie.name === STATE_COOKIE_NAME);

  if (state === null || stateCookie === undefined)
    throw new Error("sign-in did not start");

  return { state, cookie: `${stateCookie.name}=${stateCookie.value}` };
}

function callback(ip: string, state: string, cookie: string) {
  const url = new URL(`${APP_URL}/api/auth/callback/github`);
  url.searchParams.set("code", github.issueCode());
  url.searchParams.set("state", state);

  return relayAuth.service.handler(
    new Request(url, { headers: headersFrom(ip, cookie) }),
  );
}

function sessionCookieOf(response: Response): string | null {
  const cookie = response.headers
    .getSetCookie()
    .map(parseSetCookie)
    .find((entry) => entry.name === SESSION_COOKIE_NAME);

  return cookie === undefined || isExpiredSetCookie(cookie)
    ? null
    : `${cookie.name}=${cookie.value}`;
}

async function signedInCookie(ip: string): Promise<string> {
  const started = await startSignIn(ip);

  const cookie = sessionCookieOf(
    await callback(ip, started.state, started.cookie),
  );

  if (cookie === null) throw new Error("no session cookie");

  return cookie;
}

function accountApp() {
  const now = Date.now;

  return createAccountApp({
    config: {
      appUrl: APP_URL,
      baseDomain: "relay.example",
      securityContact: "abuse@relay.example",
    },
    database,
    tunnels: createTunnelRegistry({
      database,
      log: silent,
      maxBufferedBytes: 192 * 1024 * 1024,
      now,
    }),
    revocations: { record() {} },
    rateLimits: createRelayRateLimiters(now),
    auth: relayAuth.service,
    log: silent,
    now,
  });
}

describe("better-auth under NODE_ENV=production", () => {
  it("leaves rate limiting to the relay's own limiters", async () => {
    const context = await relayAuth.betterAuth.$context;

    expect(context.rateLimit.enabled).toBe(false);
  });

  it("keeps answering one address's session lookups however many arrive", async () => {
    const ip = sharedIp();
    const cookie = await signedInCookie(ip);
    let signedIn = 0;

    for (let request = 0; request < 101; request += 1) {
      const resolved = await relayAuth.service.resolveSession(
        headersFrom(ip, cookie),
      );

      if (resolved !== null) signedIn += 1;
    }

    expect(signedIn).toBe(101);
  });

  it("lets the victim finish the GitHub callback after a neighbour sends junk callbacks", async () => {
    const ip = sharedIp();
    const started = await startSignIn(ip);

    for (let request = 0; request < 100; request += 1) {
      await relayAuth.service.handler(
        new Request(`${APP_URL}/api/auth/callback/github`, {
          headers: headersFrom(ip),
        }),
      );
    }

    const completed = await callback(ip, started.state, started.cookie);

    expect(completed.status).toBe(302);
    expect(sessionCookieOf(completed)).not.toBeNull();
  });
});

describe("an anonymous client sharing the victim's address", () => {
  it("cannot stop the victim starting GitHub sign-in by sending three starts first", async () => {
    const app = accountApp();
    const shared = sharedIp();
    const statuses: number[] = [];

    for (let request = 0; request < 4; request += 1) {
      const response = await app.fetch(
        new Request(`${APP_URL}/sign-in`, {
          method: "POST",
          headers: headersFrom(shared),
        }),
      );

      statuses.push(response.status);
    }

    expect(statuses).toEqual([302, 302, 302, 302]);
  });

  it("cannot stop a signed-in victim opening the dashboard with junk-cookie requests", async () => {
    const app = accountApp();
    const cookie = await signedInCookie(sharedIp());
    const shared = sharedIp();

    for (let request = 0; request < 100; request += 1) {
      const anonymous = await app.fetch(
        new Request(`${APP_URL}/dashboard`, {
          headers: headersFrom(shared, "junk=1"),
        }),
      );

      expect(anonymous.status).toBe(200);
    }

    const victim = await app.fetch(
      new Request(`${APP_URL}/dashboard`, {
        headers: headersFrom(shared, cookie),
      }),
    );

    expect(victim.status).toBe(200);
  });

  it("cannot stop the victim signing out by sending sign-outs first", async () => {
    const app = accountApp();
    const shared = sharedIp();
    const cookie = await signedInCookie(shared);

    for (let request = 0; request < 100; request += 1) {
      await app.fetch(
        new Request(`${APP_URL}/sign-out`, {
          method: "POST",
          headers: headersFrom(shared),
        }),
      );
    }

    const signedOut = await app.fetch(
      new Request(`${APP_URL}/sign-out`, {
        method: "POST",
        headers: headersFrom(shared, cookie),
      }),
    );

    expect(signedOut.status).toBe(302);
    expect(
      signedOut.headers
        .getSetCookie()
        .map(parseSetCookie)
        .some(
          (entry) =>
            entry.name === SESSION_COOKIE_NAME && isExpiredSetCookie(entry),
        ),
    ).toBe(true);
    expect(database.db.select().from(session).all()).toHaveLength(0);
  });
});
