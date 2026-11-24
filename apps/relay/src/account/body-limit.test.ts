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

const POLL_URL = `${APP_URL}/api/account/link/poll`;

const LIMIT_BYTES = 64 * 1024;

const silent: RelayLogger = { info() {}, warn() {}, error() {} };

let database: RelayDatabase;

let account: ReturnType<typeof createAccountApp>;

function oversizedBody(): string {
  return JSON.stringify({
    deviceCode: "unknown-device",
    pad: "a".repeat(LIMIT_BYTES + 1),
  });
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

describe("apex body limit", () => {
  it("refuses a declared body over 64 KiB with 413", async () => {
    const body = oversizedBody();

    const request = new Request(POLL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });

    expect(request.headers.get("content-length")).toBe(
      String(Buffer.byteLength(body)),
    );

    const response = await account.fetch(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload-too-large" });
  });

  it("refuses a streamed body over 64 KiB without content-length", async () => {
    const bytes = new TextEncoder().encode(oversizedBody());

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 8192)
          controller.enqueue(bytes.slice(offset, offset + 8192));
        controller.close();
      },
    });

    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    };

    const request = new Request(POLL_URL, init);

    expect(request.headers.get("content-length")).toBeNull();

    const response = await account.fetch(request);

    expect(response.status).toBe(413);
  });

  it("passes a small link poll body to the route", async () => {
    const response = await account.fetch(
      new Request(POLL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: "unknown-device" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "invalid-code" });
  });
});
