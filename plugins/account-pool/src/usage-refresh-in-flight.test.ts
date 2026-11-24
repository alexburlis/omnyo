import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { accountPoolConfigSchema } from "./contracts.js";
import { createHub } from "./hub.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
} from "./store.js";

const ROUTE = "/api/v1/plugins/account-pool/http";

const USAGE_URL = "https://usage.invalid/usage";

const UPSTREAM_URL = "https://upstream.invalid";

const RESET_SECONDS = "4102444800";

const [syntheticAccess, syntheticRefresh] = ["synthetic-a", "synthetic-r"];

const SYNTHETIC_SECRET = {
  accessToken: syntheticAccess,
  refreshToken: syntheticRefresh,
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createStreamingPool() {
  const dataDir = await fs.mkdtemp(
    path.join(tmpdir(), "omnyo-account-pool-in-flight-"),
  );

  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  const database = host.api.storage.database();
  host.api.storage.migrate(database, QUOTA_MIGRATIONS);
  let time = 1_800_000_000_000;
  const now = () => time;

  const accounts = new AccountStore(
    host.api.storage.kv,
    host.api.experimental_secrets,
  );

  const quotas = new QuotaStore(database);

  const account = await accounts.add(
    {
      provider: "codex",
      kind: "oauth",
      label: "streaming-account",
      codexAccountId: "streaming-account",
      email: null,
      accountUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
    },
    { kind: "oauth", ...SYNTHETIC_SECRET, expiresAt: time + 60 * 60_000 },
  );

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  let messageCount = 0;
  let usageReads = 0;

  const transport: typeof fetch = async (input) => {
    const url = String(input);

    if (url === USAGE_URL) {
      usageReads += 1;

      return Response.json({
        rate_limit: {
          primary_window: {
            used_percent: 45,
            reset_at: Number(RESET_SECONDS),
            limit_window_seconds: 604_800,
          },
          secondary_window: null,
        },
      });
    }

    if (url.startsWith(`${UPSTREAM_URL}/`)) {
      messageCount += 1;

      const headers = {
        "x-codex-primary-used-percent": "44",
        "x-codex-primary-reset-at": RESET_SECONDS,
        ...(messageCount === 1
          ? {
              "x-codex-secondary-used-percent": "12",
              "x-codex-secondary-reset-at": RESET_SECONDS,
            }
          : { "content-type": "text/event-stream" }),
      };

      return messageCount === 1
        ? Response.json({ ok: true }, { headers })
        : new Response(stream.readable, { headers });
    }

    throw new Error(`Unexpected network destination ${url}.`);
  };

  const hubTokens = new HubTokenStore(host.api.experimental_secrets, now);

  const hub = createHub({
    accounts,
    quotas,
    affinity: new PoolAffinityStore(database),
    hubTokens,
    now,
    fetch: transport,
    getSettings: () =>
      accountPoolConfigSchema.parse({
        anthropicUpstreamBaseUrl: UPSTREAM_URL,
        codexUpstreamBaseUrl: UPSTREAM_URL,
      }),
    codexUsageUrl: USAGE_URL,
  });

  const controller = new AbortController();
  const running = hub.start(controller.signal);
  cleanups.push(async () => {
    controller.abort();
    await running;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const token = await hubTokens.forHost("synthetic-host");

  return {
    account,
    hub,
    quotas,
    writer,
    usageReads: () => usageReads,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    send: () =>
      hub.handle(
        new Request(`https://hub.invalid${ROUTE}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "gpt-5", input: "ok" }),
        }),
        "codex",
        "/v1/responses",
      ),
  };
}

describe("usage refresh while an account is streaming", () => {
  it("refreshes Codex usage and drops obsolete windows while a request is in flight", async () => {
    const pool = await createStreamingPool();
    const first = await pool.send();
    expect(first.status).toBe(200);
    await first.text();
    pool.advance(60_000);
    const response = await pool.send();
    const responseBody = response.text();

    try {
      expect(response.status).toBe(200);
      expect((await pool.hub.status()).inFlight).toBe(1);
      expect(pool.quotas.get(pool.account.id)).toMatchObject({
        limitWindows: expect.arrayContaining([
          expect.objectContaining({ slot: "secondary", utilization: 0.12 }),
        ]),
      });
      const readsBeforeRefresh = pool.usageReads();
      await pool.hub.refreshUsage(pool.account.id, true);
      expect((await pool.hub.status()).inFlight).toBe(1);
      expect(pool.usageReads()).toBe(readsBeforeRefresh + 1);
      expect(pool.quotas.get(pool.account.id)).toMatchObject({
        limitWindows: [
          expect.objectContaining({ slot: "primary", utilization: 0.45 }),
        ],
      });
      pool.advance(10 * 60_000);
      await pool.hub.refreshUsage();
      expect(pool.usageReads()).toBe(readsBeforeRefresh + 2);
    } finally {
      await pool.writer.close();
      await responseBody;
    }

    expect((await pool.hub.status()).inFlight).toBe(0);
  });
});
