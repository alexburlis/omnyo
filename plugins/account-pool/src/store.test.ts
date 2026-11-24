import Database from "better-sqlite3";
import type { PluginKvStorage } from "@omnyo/plugin-sdk";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Account } from "./contracts.js";
import {
  AccountStore,
  HubTokenStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
} from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function delayedAccountReads(kv: PluginKvStorage): PluginKvStorage {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await kv.get<T>(key);

      if (key === "accounts:v1") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      return value;
    },
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
    list: (prefix) => kv.list(prefix),
  };
}

describe("AccountStore", () => {
  it("loads account metadata written before account UUIDs were stored", async () => {
    const host = createFakePluginHost({ pluginId: "account-pool" });

    const store = new AccountStore(
      host.api.storage.kv,
      host.api.experimental_secrets,
    );

    await host.api.storage.kv.set("accounts:v1", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "claude",
        kind: "oauth",
        label: "existing",
        email: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
        createdAt: 1,
      },
    ]);
    cleanups.push(() => host.harness.lifecycle.dispose());

    expect(await store.list()).toEqual([
      expect.objectContaining({ accountUuid: null }),
    ]);
  });

  it("preserves both accounts added concurrently", async () => {
    const host = createFakePluginHost({ pluginId: "account-pool" });

    const store = new AccountStore(
      delayedAccountReads(host.api.storage.kv),
      host.api.experimental_secrets,
    );

    cleanups.push(() => host.harness.lifecycle.dispose());

    const account = (
      label: string,
    ): Omit<Account, "id" | "createdAt" | "lastUsedAt" | "lastUsedHostId"> => ({
      provider: "claude",
      kind: "api-key",
      label,
      email: null,
      accountUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
    });

    const [first, second] = await Promise.all([
      store.add(account("first"), { kind: "api-key", apiKey: "sk-first" }),
      store.add(account("second"), { kind: "api-key", apiKey: "sk-second" }),
    ]);

    expect((await store.list()).map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("keeps each account's credentials in its own secret and removes them with the account", async () => {
    const host = createFakePluginHost({ pluginId: "account-pool" });
    cleanups.push(() => host.harness.lifecycle.dispose());
    const secrets = host.api.experimental_secrets;
    const store = new AccountStore(host.api.storage.kv, secrets);

    const account = await store.add(
      {
        provider: "claude",
        kind: "api-key",
        label: "work",
        email: null,
        accountUuid: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
      },
      { kind: "api-key", apiKey: "sk-work" },
    );

    const name = `accounts/account-${account.id}.json`;
    expect(await secrets.get(name)).toBe(
      `${JSON.stringify({ kind: "api-key", apiKey: "sk-work" })}\n`,
    );
    expect(await store.readSecret(account)).toEqual({
      kind: "api-key",
      apiKey: "sk-work",
    });

    await store.writeSecret(account.id, { kind: "api-key", apiKey: "sk-next" });
    expect(await store.readSecret(account)).toEqual({
      kind: "api-key",
      apiKey: "sk-next",
    });

    expect(await store.remove(account.id)).toBe(true);
    expect(await secrets.list()).toEqual([]);
    await expect(store.readSecret(account)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      store.writeSecret(account.id, { kind: "api-key", apiKey: "sk-late" }),
    ).rejects.toThrow("no longer exists");
    expect(await secrets.list()).toEqual([]);
  });

  it("reads a secret left by the earlier file layout under the same name", async () => {
    const host = createFakePluginHost({ pluginId: "account-pool" });
    cleanups.push(() => host.harness.lifecycle.dispose());
    const id = "11111111-1111-4111-8111-111111111111";

    await host.api.experimental_secrets.set(
      `accounts/account-${id}.json`,
      `${JSON.stringify({ kind: "api-key", apiKey: "sk-legacy" })}\n`,
    );
    await host.api.experimental_secrets.set(
      "accounts/hub-token-host-one.json",
      `${JSON.stringify({
        hostId: "host-one",
        value: "B".repeat(43),
        mintedAt: 5,
        lastUsedAt: null,
        previous: [],
      })}\n`,
    );

    const store = new AccountStore(
      host.api.storage.kv,
      host.api.experimental_secrets,
    );

    const tokens = new HubTokenStore(host.api.experimental_secrets);

    const legacy: Account = {
      id,
      provider: "claude",
      kind: "api-key",
      label: "Existing API key",
      email: null,
      accountUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
      createdAt: 1,
      lastUsedAt: null,
      lastUsedHostId: null,
    };

    expect(await store.readSecret(legacy)).toEqual({
      kind: "api-key",
      apiKey: "sk-legacy",
    });
    expect(await tokens.authenticate("B".repeat(43))).toBe("host-one");
    expect(await tokens.forHost("host-one")).toBe("B".repeat(43));
  });
});

describe("QuotaStore", () => {
  it("migrates an existing quota table to family observations", () => {
    const database = new Database(":memory:");
    const initial = QUOTA_MIGRATIONS[0];
    const familyMigration = QUOTA_MIGRATIONS[1];
    const windowMigration = QUOTA_MIGRATIONS[2];

    if (
      initial === undefined ||
      familyMigration === undefined ||
      windowMigration === undefined
    ) {
      throw new Error("Expected quota migrations.");
    }

    database.exec(initial);
    database
      .prepare(
        `INSERT INTO account_quota (
          account_id, seven_day_utilization, bucket_exhaustion_json
        ) VALUES (?, ?, ?)`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        0.5,
        '{"7d_oi":4102452000000}',
      );
    database.exec(familyMigration);
    database.exec(windowMigration);

    for (const migration of QUOTA_MIGRATIONS.slice(3)) database.exec(migration);
    const quotas = new QuotaStore(database);

    const migrated = quotas.get("11111111-1111-4111-8111-111111111111");
    expect(migrated.sevenDayUtilization).toBe(0.5);
    expect(migrated.limitWindows).toEqual([]);
    expect(migrated.extraUsage).toBeNull();
    expect(migrated.familyWeekly).toEqual({
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    });
    quotas.put({
      ...migrated,
      familyWeekly: {
        ...migrated.familyWeekly,
        fable: {
          utilization: 1,
          resetAt: 4_102_452_000_000,
          status: "rejected",
          observedAt: 10,
          source: "usage",
        },
      },
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").familyWeekly.fable,
    ).toMatchObject({ utilization: 1, source: "usage" });
    quotas.put({
      ...migrated,
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10_080,
          utilization: 0.48,
          resetAt: 4_102_452_000_000,
          status: "allowed",
          observedAt: 10,
          source: "usage",
        },
      ],
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").limitWindows,
    ).toEqual([
      {
        slot: "primary",
        windowMinutes: 10_080,
        utilization: 0.48,
        resetAt: 4_102_452_000_000,
        status: "allowed",
        observedAt: 10,
        source: "usage",
      },
    ]);
    database.close();
  });
});
