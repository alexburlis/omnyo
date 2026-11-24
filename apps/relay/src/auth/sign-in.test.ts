import { inspect } from "node:util";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, auditLog, session, user } from "@omnyo/connect-db";
import { CLIENT_IP_HEADER } from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { suspendUser } from "../user-blocks.js";
import { SESSION_COOKIE_NAME, STATE_COOKIE_NAME } from "./cookies.js";
import {
  createGitHubOAuthStub,
  type GitHubOAuthStub,
  type GitHubStubProfile,
  parseSetCookie,
} from "./github-oauth-stub.js";
import { createRelayAuth } from "./index.js";
import type { RelayAuthService } from "./auth-service.js";
import {
  AUTH_LIBRARY_LOG_EVENT,
  GITHUB_ACCOUNT_SUSPENDED,
  MAX_SESSIONS_PER_USER,
  MAX_SIGN_IN_RECORDS_PER_USER,
  SIGNED_IN_ACTION,
} from "./better-auth.js";

const APP_URL = "https://relay.example";

const CLIENT_IP = "198.51.100.31";

const FIRST: GitHubStubProfile = {
  id: 4242,
  login: "sawyer",
  name: "Sawyer",
  email: "shared@example.com",
};

const SECOND: GitHubStubProfile = {
  id: 5151,
  login: "quinn",
  name: "Quinn",
  email: "shared@example.com",
};

let database: RelayDatabase;

let service: RelayAuthService;

let github: GitHubOAuthStub;

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  github = createGitHubOAuthStub(FIRST);
  vi.stubGlobal("fetch", github.fetch);
  service = createRelayAuth(
    {
      appUrl: APP_URL,
      betterAuthSecret: "sign-in-test-root-key-material-0123456789",
      github: {
        clientId: "relay-sign-in-client",
        clientSecret: "relay-sign-in-oauth",
        openSignUp: true,
      },
    },
    database,
  ).service;
});

afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
});

function headers(cookie?: string): Headers {
  const result = new Headers({ [CLIENT_IP_HEADER]: CLIENT_IP });

  if (cookie !== undefined) result.set("cookie", cookie);

  return result;
}

async function signInAs(profile: GitHubStubProfile): Promise<Response> {
  github.setProfile(profile);
  const started = await service.startGitHubSignIn(headers(), "/dashboard");

  const state = new URL(started.headers.get("location") ?? "").searchParams.get(
    "state",
  );

  const stateCookie = started.headers
    .getSetCookie()
    .map(parseSetCookie)
    .find((cookie) => cookie.name === STATE_COOKIE_NAME);

  if (state === null || stateCookie === undefined)
    throw new Error("sign-in did not start");
  const url = new URL(`${APP_URL}/api/auth/callback/github`);
  url.searchParams.set("code", github.issueCode());
  url.searchParams.set("state", state);

  return service.handler(
    new Request(url, {
      headers: headers(`${stateCookie.name}=${stateCookie.value}`),
    }),
  );
}

function sessionCookieOf(response: Response): string | null {
  const cookie = response.headers
    .getSetCookie()
    .map(parseSetCookie)
    .find((entry) => entry.name === SESSION_COOKIE_NAME);

  return cookie === undefined ? null : `${cookie.name}=${cookie.value}`;
}

function userIdForGitHubId(githubId: number): string | null {
  return (
    database.db
      .select({ userId: account.userId })
      .from(account)
      .where(eq(account.accountId, String(githubId)))
      .get()?.userId ?? null
  );
}

function sessionsOf(userId: string | null): string[] {
  return database.db
    .select({ id: session.id })
    .from(session)
    .where(eq(session.userId, userId ?? ""))
    .all()
    .map((row) => row.id);
}

function storedEmail(githubId: number): string | null {
  return (
    database.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userIdForGitHubId(githubId) ?? ""))
      .get()?.email ?? null
  );
}

describe("a GitHub email never blocks sign-up or sign-in", () => {
  it("lets a second GitHub account sign up although another user reported the same email", async () => {
    expect((await signInAs(FIRST)).status).toBe(302);

    const second = await signInAs(SECOND);

    expect({
      location: new URL(second.headers.get("location") ?? "/", APP_URL)
        .pathname,
      hasSession: sessionCookieOf(second) !== null,
      linkedUser: userIdForGitHubId(SECOND.id) !== null,
    }).toEqual({ location: "/dashboard", hasSession: true, linkedUser: true });
    expect(userIdForGitHubId(SECOND.id)).not.toBe(userIdForGitHubId(FIRST.id));
  });

  it("keeps an existing user able to sign in after GitHub reports an email another user holds", async () => {
    expect((await signInAs(FIRST)).status).toBe(302);
    expect(
      (await signInAs({ ...SECOND, email: "quinn@example.com" })).status,
    ).toBe(302);

    const moved = await signInAs({ ...FIRST, email: "quinn@example.com" });

    expect({
      status: moved.status,
      hasSession: sessionCookieOf(moved) !== null,
      sessions: sessionsOf(userIdForGitHubId(FIRST.id)).length,
    }).toEqual({ status: 302, hasSession: true, sessions: 2 });
  });

  it("stores the GitHub no-reply address instead of the address GitHub reports", async () => {
    expect((await signInAs(FIRST)).status).toBe(302);
    expect(storedEmail(FIRST.id)).toBe("4242+sawyer@users.noreply.github.com");

    expect((await signInAs({ ...FIRST, login: "sawyer-renamed" })).status).toBe(
      302,
    );
    expect(storedEmail(FIRST.id)).toBe(
      "4242+sawyer-renamed@users.noreply.github.com",
    );
  });

  it("signs a row written before better-auth 1.7 in as the same user", async () => {
    const at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    database.db
      .insert(user)
      .values({
        id: "legacy-user-0001",
        name: "Sawyer",
        email: FIRST.email,
        emailVerified: true,
        githubLogin: FIRST.login,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    database.db
      .insert(account)
      .values({
        id: "legacy-account-0001",
        accountId: String(FIRST.id),
        providerId: "github",
        userId: "legacy-user-0001",
        createdAt: at,
        updatedAt: at,
      })
      .run();

    const renamed = await signInAs({ ...FIRST, login: "sawyer-renamed" });

    expect(renamed.status).toBe(302);
    expect(sessionsOf("legacy-user-0001")).toHaveLength(1);
    expect(database.db.select().from(user).all()).toHaveLength(1);
    expect(
      database.db
        .select({ githubLogin: user.githubLogin })
        .from(user)
        .where(eq(user.id, "legacy-user-0001"))
        .get(),
    ).toEqual({ githubLogin: "sawyer-renamed" });
  });
});

describe("session creation", () => {
  it("refuses a session when the account is suspended while GitHub answers", async () => {
    expect((await signInAs(FIRST)).status).toBe(302);
    const userId = userIdForGitHubId(FIRST.id);

    database.sqlite.exec(
      "CREATE TRIGGER suspend_mid_callback AFTER UPDATE ON user BEGIN INSERT OR IGNORE INTO relay_suspension (github_id, user_id, blocked_at, reason) VALUES (NULL, NEW.id, 0, 'mid-callback'); END;",
    );

    const before = sessionsOf(userId).length;
    const refused = await signInAs(FIRST);

    const landing = new URL(refused.headers.get("location") ?? "/", APP_URL);

    expect(refused.status).toBe(302);
    expect(landing.pathname).toBe("/dashboard");
    expect(landing.searchParams.get("error")).toBe(GITHUB_ACCOUNT_SUSPENDED);
    expect(sessionCookieOf(refused)).toBeNull();
    expect(sessionsOf(userId)).toHaveLength(before);
  });

  it("removes a session that a suspension committed just before its insert would otherwise leave live", async () => {
    expect((await signInAs(FIRST)).status).toBe(302);
    const userId = userIdForGitHubId(FIRST.id);

    database.sqlite.exec(
      "CREATE TRIGGER suspend_before_session BEFORE INSERT ON session BEGIN INSERT INTO relay_suspension (github_id, user_id, blocked_at, reason) VALUES (NULL, NEW.user_id, 0, 'racing the insert'); DELETE FROM session WHERE user_id = NEW.user_id; END;",
    );

    const refused = await signInAs(FIRST);
    const cookie = sessionCookieOf(refused);

    expect(sessionsOf(userId)).toHaveLength(0);
    expect(
      cookie === null ? null : await service.resolveSession(headers(cookie)),
    ).toBeNull();
    expect(
      database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, SIGNED_IN_ACTION))
        .all(),
    ).toHaveLength(1);
  });

  it("keeps only the newest sign-in records of one user", async () => {
    for (let index = 0; index < MAX_SIGN_IN_RECORDS_PER_USER + 3; index += 1) {
      expect((await signInAs(FIRST)).status).toBe(302);
    }

    expect((await signInAs(SECOND)).status).toBe(302);

    const rows = database.db
      .select({ userId: auditLog.userId })
      .from(auditLog)
      .where(eq(auditLog.action, SIGNED_IN_ACTION))
      .all();

    expect(
      rows.filter((row) => row.userId === userIdForGitHubId(FIRST.id)),
    ).toHaveLength(MAX_SIGN_IN_RECORDS_PER_USER);
    expect(
      rows.filter((row) => row.userId === userIdForGitHubId(SECOND.id)),
    ).toHaveLength(1);
  });

  it("keeps only the newest sessions of one user", async () => {
    const cookies: string[] = [];

    for (let index = 0; index < MAX_SESSIONS_PER_USER + 2; index += 1) {
      const signedIn = await signInAs(FIRST);
      const cookie = sessionCookieOf(signedIn);

      if (cookie === null) throw new Error("no session cookie");
      cookies.push(cookie);
    }

    expect(sessionsOf(userIdForGitHubId(FIRST.id))).toHaveLength(
      MAX_SESSIONS_PER_USER,
    );
    expect(await service.resolveSession(headers(cookies[0]))).toBeNull();
    expect(await service.resolveSession(headers(cookies[1]))).toBeNull();
    expect(
      (await service.resolveSession(headers(cookies.at(-1))))?.user.githubLogin,
    ).toBe("sawyer");
  });

  it("records each sign-in with the user, GitHub ID and client IP", async () => {
    expect((await signInAs(FIRST)).status).toBe(302);
    expect((await signInAs(FIRST)).status).toBe(302);
    const userId = userIdForGitHubId(FIRST.id);

    const rows = database.db
      .select({
        userId: auditLog.userId,
        detail: auditLog.detail,
        ipAddress: auditLog.ipAddress,
      })
      .from(auditLog)
      .where(eq(auditLog.action, SIGNED_IN_ACTION))
      .all();

    expect(rows).toEqual([
      {
        userId,
        detail: JSON.stringify({ githubId: "4242" }),
        ipAddress: CLIENT_IP,
      },
      {
        userId,
        detail: JSON.stringify({ githubId: "4242" }),
        ipAddress: CLIENT_IP,
      },
    ]);
  });

  it("records no sign-in for a suspended account", async () => {
    expect((await signInAs(FIRST)).status).toBe(302);
    const userId = userIdForGitHubId(FIRST.id);

    if (userId === null) throw new Error("no user");
    suspendUser(database.db, { userId, reason: null, now: Date.now() });

    expect((await signInAs(FIRST)).status).toBe(403);
    expect(
      database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, SIGNED_IN_ACTION))
        .all(),
    ).toHaveLength(1);
  });
});

describe("session cookies", () => {
  it("resolves no one when the request carries the session cookie twice", async () => {
    const first = sessionCookieOf(await signInAs(FIRST));
    const second = sessionCookieOf(await signInAs(SECOND));

    if (first === null || second === null) throw new Error("no session cookie");

    expect(
      (await service.resolveSession(headers(first)))?.user.githubLogin,
    ).toBe("sawyer");
    expect(
      await service.resolveSession(headers(`${second}; ${first}`)),
    ).toBeNull();
    expect(
      await service.resolveSession(headers(`${first}; theme=dark; ${second}`)),
    ).toBeNull();
  });
});

describe("the session lookup route", () => {
  it("does not answer browsers, so no page can read the session token", async () => {
    const cookie = sessionCookieOf(await signInAs(FIRST));

    if (cookie === null) throw new Error("no session cookie");

    const response = await service.handler(
      new Request(`${APP_URL}/api/auth/get-session`, {
        headers: headers(cookie),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(cookie.split("=")[1] ?? "-");
    expect((await service.resolveSession(headers(cookie)))?.user.name).toBe(
      "Sawyer",
    );
  });
});

function logEvent(line: string): unknown {
  try {
    const parsed: unknown = JSON.parse(line);

    return typeof parsed === "object" && parsed !== null && "event" in parsed
      ? parsed.event
      : null;
  } catch {
    return null;
  }
}

describe("the auth library's own log lines", () => {
  it("are relay JSON lines without the GitHub profile when a sign-in cannot store the user", async () => {
    database.sqlite.exec(
      "CREATE TRIGGER refuse_new_user BEFORE INSERT ON user BEGIN SELECT RAISE(ABORT, 'user store unavailable'); END",
    );
    const written: string[] = [];

    const capture =
      (sink: string[]) =>
      (...args: unknown[]) => {
        sink.push(
          args
            .map((arg) =>
              typeof arg === "string" ? arg : inspect(arg, { depth: 6 }),
            )
            .join(" "),
        );

        return true;
      };

    const spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(capture(written)),
      vi.spyOn(process.stderr, "write").mockImplementation(capture(written)),
      vi.spyOn(console, "error").mockImplementation(capture(written)),
      vi.spyOn(console, "warn").mockImplementation(capture(written)),
      vi.spyOn(console, "log").mockImplementation(capture(written)),
      vi.spyOn(console, "info").mockImplementation(capture(written)),
    ];

    let response: Response;

    try {
      response = await signInAs({
        id: 7373,
        login: "privatelogin",
        name: "Private Person",
        email: "private.person@example.com",
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(sessionCookieOf(response)).toBeNull();
    expect(written.length).toBeGreaterThan(0);
    expect(written.map(logEvent)).toEqual(
      written.map(() => AUTH_LIBRARY_LOG_EVENT),
    );

    const output = written.join("\n");

    for (const detail of [
      "privatelogin",
      "Private Person",
      "private.person@example.com",
      "7373",
    ]) {
      expect(output, detail).not.toContain(detail);
    }
  });
});
