import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, session, user } from "@omnyo/connect-db";
import { CLIENT_IP_HEADER } from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import {
  AUTH_COOKIE_PREFIX,
  SESSION_COOKIE_NAME,
  STATE_COOKIE_NAME,
} from "./cookies.js";
import {
  createGitHubOAuthStub,
  GITHUB_ALLOWED_HOSTS,
  type GitHubOAuthStub,
  isExpiredSetCookie,
  type ParsedSetCookie,
  parseSetCookie,
} from "./github-oauth-stub.js";
import { createRelayAuth } from "./index.js";
import type { RelayAuthService } from "./auth-service.js";
import {
  GITHUB_ACCOUNT_NOT_ALLOWED,
  GITHUB_ACCOUNT_SUSPENDED,
  GitHubAllowlistRequiredError,
} from "./better-auth.js";
import { suspendUser } from "../user-blocks.js";

const APP_URL = "https://relay.example";

const ROOT_KEY_MATERIAL = "h1-root-key-material-for-tests-only-0123456789";

const CLIENT_IP = "198.51.100.20";

const ALLOWED_GITHUB_ID = 4242;

let database: RelayDatabase;

let service: RelayAuthService;

let github: GitHubOAuthStub;

let emitted: ParsedSetCookie[];

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  github = createGitHubOAuthStub({
    id: ALLOWED_GITHUB_ID,
    login: "sawyer",
    name: "Sawyer",
    email: "sawyer@example.com",
  });
  vi.stubGlobal("fetch", github.fetch);
  service = createRelayAuth(
    {
      appUrl: APP_URL,
      betterAuthSecret: ROOT_KEY_MATERIAL,
      github: {
        clientId: "relay-test-client",
        clientSecret: "relay-test-oauth",
        allowedUserIds: [String(ALLOWED_GITHUB_ID)],
      },
    },
    database,
  ).service;
  emitted = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
});

function record(response: Response): ParsedSetCookie[] {
  const cookies = response.headers.getSetCookie().map(parseSetCookie);
  emitted.push(...cookies);

  return cookies;
}

function baseHeaders(cookie?: string): Headers {
  const headers = new Headers({ [CLIENT_IP_HEADER]: CLIENT_IP });

  if (cookie !== undefined) headers.set("cookie", cookie);

  return headers;
}

async function startSignIn(): Promise<{ state: string; stateCookie: string }> {
  const response = await service.startGitHubSignIn(baseHeaders(), "/dashboard");

  expect(response.status).toBe(302);
  const authorize = new URL(response.headers.get("location") ?? "");
  expect(authorize.origin).toBe("https://github.com");
  const state = authorize.searchParams.get("state");

  if (state === null) throw new Error("no state in authorize URL");
  const cookies = record(response);

  const stateCookie = cookies.find(
    (cookie) => cookie.name === STATE_COOKIE_NAME,
  );

  if (stateCookie === undefined) throw new Error("no state cookie at start");
  expect(isExpiredSetCookie(stateCookie)).toBe(false);

  return { state, stateCookie: `${stateCookie.name}=${stateCookie.value}` };
}

async function callback(state: string, cookie: string | undefined) {
  const url = new URL(`${APP_URL}/api/auth/callback/github`);
  url.searchParams.set("code", github.issueCode());
  url.searchParams.set("state", state);

  return service.handler(new Request(url, { headers: baseHeaders(cookie) }));
}

function sessionCount(): number {
  return database.db.select().from(session).all().length;
}

function expectHostOnly(cookies: readonly ParsedSetCookie[]): void {
  expect(cookies.length).toBeGreaterThan(0);

  for (const cookie of cookies) {
    expect(cookie.name.startsWith(`${AUTH_COOKIE_PREFIX}`), cookie.name).toBe(
      true,
    );
    expect(cookie.name.startsWith("__Host-"), cookie.name).toBe(true);
    expect(cookie.attributes.has("secure"), cookie.name).toBe(true);
    expect(cookie.attributes.get("path"), cookie.name).toBe("/");
    expect(cookie.attributes.has("domain"), cookie.name).toBe(false);
  }
}

describe("H1: better-auth cookies are host-only __Host-omnyo cookies", () => {
  it("emits only __Host- cookies across sign-in, callback, refresh and sign-out", async () => {
    const { state, stateCookie } = await startSignIn();

    const completed = await callback(state, stateCookie);
    expect(completed.status).toBe(302);
    expect(
      new URL(completed.headers.get("location") ?? "", APP_URL).pathname,
    ).toBe("/dashboard");
    const callbackCookies = record(completed);

    const expiredState = callbackCookies.find(
      (cookie) => cookie.name === STATE_COOKIE_NAME,
    );

    expect(expiredState).toBeDefined();
    expect(expiredState && isExpiredSetCookie(expiredState)).toBe(true);

    const sessionCookie = callbackCookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );

    if (sessionCookie === undefined) throw new Error("no session cookie");
    expect(isExpiredSetCookie(sessionCookie)).toBe(false);
    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionCookie.value}`;

    const signedIn = await service.getSession(baseHeaders(cookieHeader));
    expect(signedIn?.user).toMatchObject({
      name: "Sawyer",
      email: `${ALLOWED_GITHUB_ID}+sawyer@users.noreply.github.com`,
      githubLogin: "sawyer",
    });

    if (signedIn === null) throw new Error("no session");
    database.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) })
      .where(eq(session.id, signedIn.session.id))
      .run();

    const refreshed = await service.resolveSession(baseHeaders(cookieHeader));
    expect(refreshed?.session.id).toBe(signedIn.session.id);
    const refreshCookies = (refreshed?.setCookies ?? []).map(parseSetCookie);
    emitted.push(...refreshCookies);
    expect(
      refreshCookies.some(
        (cookie) =>
          cookie.name === SESSION_COOKIE_NAME && !isExpiredSetCookie(cookie),
      ),
    ).toBe(true);
    expect(
      (refreshed?.session.expiresAt.getTime() ?? 0) - Date.now(),
    ).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);

    const signOutHeaders = baseHeaders(cookieHeader);
    signOutHeaders.set("origin", APP_URL);

    const signedOut = await service.handler(
      new Request(`${APP_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: signOutHeaders,
      }),
    );

    expect(signedOut.status).toBe(200);
    const signOutCookies = record(signedOut);
    expect(
      signOutCookies.some(
        (cookie) =>
          cookie.name === SESSION_COOKIE_NAME && isExpiredSetCookie(cookie),
      ),
    ).toBe(true);
    expect(sessionCount()).toBe(0);

    expectHostOnly(emitted);

    for (const request of github.requests) {
      expect(GITHUB_ALLOWED_HOSTS.has(request.hostname)).toBe(true);
    }
  });

  it("starts sign-in from the in-process helper with a __Host- state cookie", async () => {
    const response = await service.startGitHubSignIn(
      baseHeaders(),
      "/link?code=ABCD-EFGH",
    );

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").host).toBe(
      "github.com",
    );
    const cookies = record(response);
    expect(cookies.map((cookie) => cookie.name)).toContain(STATE_COOKIE_NAME);
    expectHostOnly(cookies);

    await expect(
      service.startGitHubSignIn(baseHeaders(), "https://evil.test/"),
    ).rejects.toThrow("app path");
    await expect(
      service.startGitHubSignIn(baseHeaders(), "//evil.test"),
    ).rejects.toThrow("app path");
    await expect(
      service.startGitHubSignIn(baseHeaders(), "/%09/evil.test"),
    ).rejects.toThrow("app path");
  });

  it("fails a callback whose state cookie is missing", async () => {
    const { state } = await startSignIn();

    const response = await callback(state, undefined);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=");
    expect(
      record(response).some((cookie) => cookie.name === SESSION_COOKIE_NAME),
    ).toBe(false);
    expect(sessionCount()).toBe(0);
  });

  it("fails a callback whose state cookie was tossed under a non-__Host- name", async () => {
    const { state, stateCookie } = await startSignIn();
    const value = stateCookie.slice(stateCookie.indexOf("=") + 1);

    for (const tossedName of [
      `__Secure-${STATE_COOKIE_NAME}`,
      "better-auth.state",
      "__Secure-better-auth.state",
    ]) {
      const response = await callback(state, `${tossedName}=${value}`);

      expect(response.status, tossedName).toBe(302);
      expect(response.headers.get("location"), tossedName).toContain("error=");
      expect(sessionCount(), tossedName).toBe(0);
    }
  });

  it("fails a callback that pairs one flow's state with another flow's cookie", async () => {
    const attacker = await startSignIn();
    const victim = await startSignIn();

    const response = await callback(attacker.state, victim.stateCookie);

    expect(response.headers.get("location")).toContain("error=");
    expect(sessionCount()).toBe(0);
    expect(database.db.select().from(user).all()).toHaveLength(0);
    expect(database.db.select().from(account).all()).toHaveLength(0);
  });

  it("ignores a session cookie tossed under a __Secure- prefixed name", async () => {
    const { state, stateCookie } = await startSignIn();
    const completed = await callback(state, stateCookie);

    const sessionCookie = record(completed).find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );

    if (sessionCookie === undefined) throw new Error("no session cookie");

    for (const tossedName of [
      `__Secure-${SESSION_COOKIE_NAME}`,
      "better-auth.session_token",
      "__Secure-better-auth.session_token",
    ]) {
      expect(
        await service.getSession(
          baseHeaders(`${tossedName}=${sessionCookie.value}`),
        ),
      ).toBeNull();
    }
  });

  it("serves only the allowlisted better-auth routes", async () => {
    const blocked = [
      ["POST", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/link-social"],
      ["GET", "/api/auth/get-access-token"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/delete-user"],
      ["GET", "/api/auth/list-accounts"],
    ] as const;

    for (const [method, path] of blocked) {
      const response = await service.handler(
        new Request(`${APP_URL}${path}`, {
          method,
          headers: { origin: APP_URL, "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );

      expect(response.status, path).toBe(404);
    }
  });

  it("records the derived client IP on the session, not a forwarded header", async () => {
    const { state, stateCookie } = await startSignIn();
    const url = new URL(`${APP_URL}/api/auth/callback/github`);
    url.searchParams.set("code", github.issueCode());
    url.searchParams.set("state", state);
    const headers = baseHeaders(stateCookie);
    headers.set("x-forwarded-for", "203.0.113.250");

    await service.handler(new Request(url, { headers }));

    expect(
      database.db.select({ ip: session.ipAddress }).from(session).all(),
    ).toEqual([{ ip: CLIENT_IP }]);
  });

  it("stores the GitHub access token encrypted", async () => {
    const { state, stateCookie } = await startSignIn();
    const code = github.issueCode();
    const url = new URL(`${APP_URL}/api/auth/callback/github`);
    url.searchParams.set("code", code);
    url.searchParams.set("state", state);

    const completed = await service.handler(
      new Request(url, { headers: baseHeaders(stateCookie) }),
    );

    expect(completed.status).toBe(302);

    const stored = database.db
      .select({ accessToken: account.accessToken })
      .from(account)
      .all();

    expect(stored).toHaveLength(1);
    expect(stored[0]?.accessToken).not.toBeNull();
    expect(stored[0]?.accessToken).not.toBe(`stub-access-${code}`);
  });
});

describe("GitHub sign-in is limited to the configured GitHub user IDs", () => {
  it("refuses a GitHub account outside the allowlist before any user, account or session exists", async () => {
    github.setProfile({
      id: 9001,
      login: "stranger",
      name: "Stranger",
      email: "stranger@example.com",
    });
    const { state, stateCookie } = await startSignIn();

    const response = await callback(state, stateCookie);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: GITHUB_ACCOUNT_NOT_ALLOWED,
    });
    expect(
      record(response).some((cookie) => cookie.name === SESSION_COOKIE_NAME),
    ).toBe(false);
    expect(sessionCount()).toBe(0);
    expect(database.db.select().from(user).all()).toHaveLength(0);
    expect(database.db.select().from(account).all()).toHaveLength(0);
  });

  it("refuses a suspended GitHub account at the callback without a new session", async () => {
    const first = await startSignIn();
    expect((await callback(first.state, first.stateCookie)).status).toBe(302);
    const [signedIn] = database.db.select().from(user).all();

    if (signedIn === undefined) throw new Error("no user after sign-in");
    suspendUser(database.db, {
      userId: signedIn.id,
      reason: null,
      now: Date.now(),
    });
    expect(sessionCount()).toBe(0);

    const second = await startSignIn();
    const response = await callback(second.state, second.stateCookie);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: GITHUB_ACCOUNT_SUSPENDED,
    });
    expect(sessionCount()).toBe(0);
  });

  it("refuses an allowlisted login name whose GitHub user ID differs", async () => {
    github.setProfile({
      id: ALLOWED_GITHUB_ID + 1,
      login: "sawyer",
      name: "Sawyer",
      email: "sawyer@example.com",
    });
    const { state, stateCookie } = await startSignIn();

    const response = await callback(state, stateCookie);

    expect(response.status).toBe(403);
    expect(database.db.select().from(user).all()).toHaveLength(0);
  });

  it("will not build GitHub sign-in for a public domain without an allowlist", () => {
    expect(() =>
      createRelayAuth(
        {
          appUrl: "https://omnyo.link",
          betterAuthSecret: ROOT_KEY_MATERIAL,
          github: {
            clientId: "relay-test-client",
            clientSecret: "relay-test-oauth",
          },
        },
        database,
      ),
    ).toThrow(GitHubAllowlistRequiredError);
  });
});
