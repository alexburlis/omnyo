import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { session, user } from "@omnyo/connect-db";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import {
  isAllowedAuthRoute,
  type RelayAuthService,
  safeAppPath,
  SESSION_EXPIRES_IN_MS,
  SESSION_UPDATE_AGE_MS,
} from "./auth-service.js";
import { createRelayAuth } from "./index.js";

const APP_URL = "https://relay.example";

const T0 = Date.UTC(2026, 10, 8, 12);

const DAY_MS = 24 * 60 * 60 * 1000;

let database: RelayDatabase;

let service: RelayAuthService;

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  service = createRelayAuth(
    {
      appUrl: APP_URL,
      betterAuthSecret: "service-root-material-for-tests-0123456789abcd",
      github: {
        clientId: "relay-test-client",
        clientSecret: "relay-test-oauth",
      },
    },
    database,
  ).service;
  database.db
    .insert(user)
    .values({
      id: "u1",
      name: "Sawyer",
      email: "sawyer@example.com",
      emailVerified: true,
      githubLogin: "sawyer",
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
    })
    .run();
  database.db
    .insert(session)
    .values({
      id: "s1",
      token: "opaque-session-value",
      userId: "u1",
      expiresAt: new Date(T0 + SESSION_EXPIRES_IN_MS),
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
    })
    .run();
});

afterEach(() => {
  database.close();
});

describe("AuthService session lookups", () => {
  it("finds a live session and its user, and nothing after expiry", () => {
    expect(service.findLiveSession("s1", T0 + DAY_MS)).toMatchObject({
      id: "s1",
      userId: "u1",
    });
    expect(
      service.findLiveSession("s1", T0 + SESSION_EXPIRES_IN_MS + 1000),
    ).toBeNull();
    expect(service.findLiveSession("missing", T0)).toBeNull();
    expect(service.findUser("u1")).toEqual({
      id: "u1",
      name: "Sawyer",
      email: "sawyer@example.com",
      image: null,
      githubLogin: "sawyer",
    });
    expect(service.findUser("nobody")).toBeNull();
  });

  it("renews only after the update age and keeps an active session alive for ten days", () => {
    const early = service.renewSession("s1", T0 + SESSION_UPDATE_AGE_MS - 1000);
    expect(early?.expiresAt.getTime()).toBe(T0 + SESSION_EXPIRES_IN_MS);

    let at = T0;

    for (let day = 1; day <= 10; day += 1) {
      at = T0 + day * DAY_MS;
      const renewed = service.renewSession("s1", at);

      expect(renewed, `day ${day}`).not.toBeNull();
      expect(renewed?.expiresAt.getTime()).toBe(at + SESSION_EXPIRES_IN_MS);
    }

    expect(service.findLiveSession("s1", at + 6 * DAY_MS)).not.toBeNull();
    expect(
      service.renewSession("s1", at + SESSION_EXPIRES_IN_MS + 1000),
    ).toBeNull();
  });

  it("returns no session for a request without cookies", async () => {
    expect(await service.getSession(new Headers())).toBeNull();
  });
});

describe("auth route and path guards", () => {
  it("allows only the documented better-auth routes", () => {
    expect(isAllowedAuthRoute("GET", "/api/auth/callback/github")).toBe(true);
    expect(isAllowedAuthRoute("POST", "/api/auth/callback/github")).toBe(false);
    expect(isAllowedAuthRoute("POST", "/api/auth/sign-in/social")).toBe(false);
    expect(isAllowedAuthRoute("GET", "/api/auth/callback/google")).toBe(false);
    expect(isAllowedAuthRoute("POST", "/api/auth/sign-up/email")).toBe(false);
    expect(isAllowedAuthRoute("POST", "/api/auth/sign-in/email")).toBe(false);
    expect(isAllowedAuthRoute("GET", "/api/auth/get-session")).toBe(false);
  });

  it("accepts app paths and rejects redirects off the app origin", () => {
    expect(safeAppPath("/link?code=ABCD-EFGH", APP_URL)).toBe(
      "/link?code=ABCD-EFGH",
    );
    expect(
      safeAppPath(
        "/dashboard?returnTo=https%3A%2F%2Fa.relay.example%2F",
        APP_URL,
      ),
    ).toBe("/dashboard?returnTo=https%3A%2F%2Fa.relay.example%2F");

    for (const raw of [
      "",
      "dashboard",
      "//evil.test",
      "/\\evil.test",
      "/%09/evil.test",
      "/%09%5Cevil.test",
      "/%5C%5Cevil.test",
      "https://evil.test",
      "/a b",
      "/%E0%A4%A",
      "/.//evil.test/phish",
      "/..//evil.test/phish",
      "/%2e//evil.test/phish",
      "/%2E%2E//evil.test/phish",
      "/.%2e//evil.test/phish",
      "/x/..//evil.test/phish",
      "/dashboard/..//evil.test/phish?x=1",
    ]) {
      expect(safeAppPath(raw, APP_URL), raw).toBeNull();
    }

    expect(safeAppPath("/x/../dashboard", APP_URL)).toBe("/dashboard");
  });
});
