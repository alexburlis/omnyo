import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayAuth } from "../auth/index.js";
import { parseRelayConfig } from "../config.js";
import type { RelayLogger } from "../contracts.js";
import { type RelayDatabase, openRelayDatabase } from "../db.js";
import { sourceMigrationDirectories } from "../migrations.js";
import { createRelayRateLimiters } from "../rate-limit.js";
import { createTunnelRegistry } from "../tunnel/registry.js";
import { createAccountApp } from "./routes.js";

const APP_URL = "https://relay.test";

const silent: RelayLogger = { info() {}, warn() {}, error() {} };

let database: RelayDatabase;

let account: ReturnType<typeof createAccountApp>;

function formActionSources(csp: string | null): string[] {
  const directive = (csp ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("form-action "));

  return directive ? directive.split(/\s+/).slice(1) : [];
}

beforeEach(() => {
  const now = Date.now;

  const config = parseRelayConfig({
    BASE_DOMAIN: "relay.test",
    APP_URL,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: randomBytes(16).toString("hex"),
    DATABASE_PATH: ":memory:",
    PORT: "0",
    HEALTH_PORT: "0",
    RELAY_CLIENT_IP_SOURCE: "xff-rightmost",
  });

  database = openRelayDatabase(":memory:", sourceMigrationDirectories(), now);

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
  database.close();
});

describe("sign-in page form-action", () => {
  it("lets the GitHub sign-in redirect chain end on a tenant host", async () => {
    const next = `/relay/authorize?host=alexb.relay.test&return=%2F&n=${"A".repeat(43)}`;

    const response = await account.fetch(
      new Request(`${APP_URL}/sign-in?next=${encodeURIComponent(next)}`),
    );

    const sources = formActionSources(
      response.headers.get("content-security-policy"),
    );

    expect(response.status).toBe(200);
    expect(sources).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://github.com",
        "https://*.relay.test",
      ]),
    );
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("https:");
  });
});
