import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER } from "../contracts.js";
import { openRelayDatabase, type RelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { createRelayAuth } from "./index.js";
import type { RelayAuthService } from "./auth-service.js";

const APP_URL = "https://relay.example";

const LIBRARY_ENDPOINTS = [
  ["POST", "/sign-in/social"],
  ["GET", "/callback/github"],
  ["POST", "/callback/github"],
  ["GET", "/callback/google"],
  ["GET", "/get-session"],
  ["POST", "/get-session"],
  ["POST", "/sign-out"],
  ["POST", "/sign-up/email"],
  ["POST", "/sign-in/email"],
  ["POST", "/reset-password"],
  ["POST", "/verify-password"],
  ["GET", "/verify-email"],
  ["POST", "/send-verification-email"],
  ["POST", "/change-email"],
  ["POST", "/change-password"],
  ["POST", "/update-session"],
  ["POST", "/update-user"],
  ["POST", "/delete-user"],
  ["POST", "/request-password-reset"],
  ["GET", "/reset-password/abc"],
  ["GET", "/list-sessions"],
  ["POST", "/revoke-session"],
  ["POST", "/revoke-sessions"],
  ["POST", "/revoke-other-sessions"],
  ["POST", "/link-social"],
  ["GET", "/list-accounts"],
  ["GET", "/delete-user/callback"],
  ["POST", "/unlink-account"],
  ["POST", "/refresh-token"],
  ["POST", "/get-access-token"],
  ["GET", "/account-info"],
  ["GET", "/ok"],
  ["GET", "/error"],
  ["POST", "/magic-link/verify"],
  ["GET", "/magic-link/verify"],
  ["POST", "/sign-in/magic-link"],
  ["POST", "/email-otp/send-verification-otp"],
  ["POST", "/sign-in/email-otp"],
  ["POST", "/forget-password"],
  ["GET", "/reference"],
] as const;

const RELAY_ALLOWED = new Set([
  "GET /callback/github",
  "POST /sign-out",
  "GET /error",
  "GET /ok",
]);

const PATH_VARIANTS = [
  ["POST", "/api/auth/update-user/"],
  ["POST", "/API/AUTH/update-user"],
  ["POST", "/api/auth/get-session/../update-user"],
  ["POST", "/api/auth/get-session%2F..%2Fupdate-user"],
  ["GET", "/api/auth/get-session/"],
  ["GET", "/API/AUTH/get-session"],
  ["GET", "/api/auth/Get-Session"],
  ["GET", "/api/auth//get-session"],
  ["GET", "/api/auth/%67et-session"],
  ["HEAD", "/api/auth/get-session"],
  ["OPTIONS", "/api/auth/get-session"],
  ["POST", "/api/auth/sign-up/email/"],
  ["POST", "/api/auth/sign-in/social;x"],
  ["POST", "/api/auth/./sign-in/social"],
  ["GET", "/api/auth/callback/github/"],
  ["GET", "/api/auth/callback/GitHub"],
  ["POST", "/api/auth/callback/github"],
] as const;

let database: RelayDatabase;

let service: RelayAuthService;

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  service = createRelayAuth(
    {
      appUrl: APP_URL,
      betterAuthSecret: "auth-endpoints-root-key-material-0123456789",
      github: {
        clientId: "relay-endpoints-client",
        clientSecret: "relay-endpoints-oauth",
        openSignUp: true,
      },
    },
    database,
  ).service;
});

afterEach(() => {
  database.close();
});

async function call(method: string, pathname: string): Promise<number> {
  const response = await service.handler(
    new Request(`${APP_URL}${pathname}`, {
      method,
      headers: {
        origin: APP_URL,
        "content-type": "application/json",
        [CLIENT_IP_HEADER]: "198.51.100.77",
      },
      ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
    }),
  );

  return response.status;
}

describe("the relay's better-auth allowlist against every 1.7.17 endpoint", () => {
  it("answers 404 for every library endpoint except the four the relay uses", async () => {
    const reachable: string[] = [];

    for (const [method, path] of LIBRARY_ENDPOINTS) {
      const status = await call(method, `/api/auth${path}`);

      if (status !== 404) reachable.push(`${method} ${path} ${status}`);
    }

    expect(
      reachable.map((entry) => entry.split(" ").slice(0, 2).join(" ")).sort(),
    ).toEqual([...RELAY_ALLOWED].sort());
  });

  it("answers 404 for case, slash, encoding, dot-segment and method variants", async () => {
    const reachable: string[] = [];

    for (const [method, path] of PATH_VARIANTS) {
      const status = await call(method, path);

      if (status !== 404) reachable.push(`${method} ${path} ${status}`);
    }

    expect(reachable).toEqual([]);
  });

  it("does not start an IdP-initiated sign-in from a callback without state", async () => {
    const response = await service.handler(
      new Request(`${APP_URL}/api/auth/callback/github?code=attacker-code`, {
        headers: { [CLIENT_IP_HEADER]: "198.51.100.78" },
      }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", APP_URL);
    expect(location.origin).toBe(APP_URL);
    expect(location.searchParams.get("error")).toBe("state_not_found");
  });

  it("keeps the error page on the relay origin whatever the callback error says", async () => {
    const response = await service.handler(
      new Request(
        `${APP_URL}/api/auth/error?error=%3Cscript%3E&error_description=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E`,
        { headers: { [CLIENT_IP_HEADER]: "198.51.100.79" } },
      ),
    );

    const location = response.headers.get("location");

    if (location !== null) {
      expect(new URL(location, APP_URL).origin).toBe(APP_URL);
    } else {
      const body = await response.text();
      expect(body).not.toContain("<script>");
      expect(body).not.toContain("<img src=x");
    }
  });
});
