import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "./server.ts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const CREDIT_ID = "provider-credit:one";

const listing = {
  accountId: ACCOUNT_ID,
  availableCount: 1,
  credits: [
    { id: CREDIT_ID, status: "available", expiresAt: "2026-11-06T00:00:00Z" },
  ],
  fetchedAt: 1_792_000_000_000,
};

describe("reset owner RPC boundary", () => {
  it.each([
    { accountId: ACCOUNT_ID, creditId: CREDIT_ID, redeemRequestId: REQUEST_ID },
    {
      accountId: ACCOUNT_ID,
      creditId: CREDIT_ID,
      redeemRequestId: REQUEST_ID,
      confirmed: false,
    },
    { accountId: ACCOUNT_ID, redeemRequestId: REQUEST_ID, confirmed: true },
  ])(
    "rejects redemption without a selected credit and explicit confirmation",
    async (input) => {
      const { api, harness } = createFakePluginHost({
        pluginId: "omnyo--account-usage",
        sdk: {
          plugins: {
            callRpc: () => ({
              accountId: ACCOUNT_ID,
              code: "no_credit",
              usageRefreshError: null,
            }),
          },
        },
      });

      plugin(api);
      await expect(
        harness.callRpc("codexRedeemReset", input),
      ).rejects.toThrow();
      expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    },
  );

  it("rejects an unrelated plugin before forwarding a confirmed redemption", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: () => ({
            accountId: ACCOUNT_ID,
            code: "no_credit",
            usageRefreshError: null,
          }),
        },
      },
    });

    plugin(api);
    await expect(
      harness.callRpc(
        "codexRedeemReset",
        {
          accountId: ACCOUNT_ID,
          creditId: CREDIT_ID,
          redeemRequestId: REQUEST_ID,
          confirmed: true,
        },
        {
          experimental_caller: {
            kind: "plugin",
            pluginId: "unrelated-fixture",
          },
        },
      ),
    ).rejects.toThrow(/caller is not authorized/);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });

  it("lists credits through the scoped Pooler method and preserves provider identifiers", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "omnyo--account-usage",
      sdk: { plugins: { callRpc: () => listing } },
    });

    plugin(api);

    await expect(
      harness.callRpc("codexResetCredits", { accountId: ACCOUNT_ID }),
    ).resolves.toEqual(listing);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    expect(
      harness.inspection.sdk.callsTo("plugins.callRpc")[0]?.[0],
    ).toMatchObject({
      pluginId: "account-pool",
      method: "experimental_codex-resets.v1.credits",
      input: { accountId: ACCOUNT_ID },
    });
  });

  it("surfaces a list failure rather than returning zero credits", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: () => {
            throw new Error("Reset credits unavailable");
          },
        },
      },
    });

    plugin(api);

    await expect(
      harness.callRpc("codexResetCredits", { accountId: ACCOUNT_ID }),
    ).rejects.toThrow("Reset credits unavailable");
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
  });

  it("rejects another account's result", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: { callRpc: () => ({ ...listing, accountId: REQUEST_ID }) },
      },
    });

    plugin(api);

    await expect(
      harness.callRpc("codexResetCredits", { accountId: ACCOUNT_ID }),
    ).rejects.toThrow("Reset credits response account mismatch");
  });

  it("forwards one confirmed reset with the caller's stable request ID and usage failure", async () => {
    const result = {
      accountId: ACCOUNT_ID,
      code: "reset",
      usageRefreshError: "Usage refresh failed",
    };

    const { api, harness } = createFakePluginHost({
      pluginId: "omnyo--account-usage",
      sdk: { plugins: { callRpc: () => result } },
    });

    plugin(api);

    const input = {
      accountId: ACCOUNT_ID,
      creditId: CREDIT_ID,
      redeemRequestId: REQUEST_ID,
      confirmed: true,
    };

    await expect(harness.callRpc("codexRedeemReset", input)).resolves.toEqual(
      result,
    );
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    expect(
      harness.inspection.sdk.callsTo("plugins.callRpc")[0]?.[0],
    ).toMatchObject({
      pluginId: "account-pool",
      method: "experimental_codex-resets.v1.redeem",
      input: {
        accountId: ACCOUNT_ID,
        creditId: CREDIT_ID,
        redeemRequestId: REQUEST_ID,
      },
    });
    expect(harness.inspection.realtimeSignals).toHaveLength(1);
  });
});
