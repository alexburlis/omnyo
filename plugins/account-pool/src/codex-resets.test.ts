import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountPoolPlugin } from "./server.js";
import { AccountStore } from "./store.js";

const creditsMethod = "experimental_codex-resets.v1.credits";

const redeemMethod = "experimental_codex-resets.v1.redeem";

const endpoint =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

const caller = {
  experimental_caller: {
    kind: "plugin" as const,
    pluginId: "omnyo--account-usage",
  },
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup() {
  const dataDir = await mkdtemp(
    path.join(tmpdir(), "omnyo-codex-resets-test-"),
  );

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let clock = Date.now();
  let identity = "subscription-one";
  let expired = false;

  let resetReply: () => Response | Promise<Response> = () =>
    Response.json({
      available_count: 1,
      credits: [
        {
          id: "opaque-credit/1",
          status: "available",
          expires_at: "2026-11-06T00:00:00Z",
          ignored: "private-provider-data",
        },
      ],
      ignored: "private-provider-data",
    });

  let usageReply = () =>
    Response.json({
      rate_limit: {
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18000,
          reset_at: Math.floor(clock / 1000) + 3600,
        },
      },
    });

  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "account-pool", enabled: true }],
        }),
      },
    },
  });

  cleanup.push(async () => {
    await host.harness.lifecycle.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  await createAccountPoolPlugin({
    env: {},
    now: () => clock,
    fetch: async (url, init) => {
      const address = String(url);
      calls.push({ url: address, init });

      if (address === endpoint || address === `${endpoint}/consume`)
        return resetReply();

      if (address.includes("/wham/usage")) return usageReply();

      if (address.includes("/oauth/token"))
        return Response.json({
          access_token: "synthetic-renewed",
          refresh_token: "synthetic-refresh",
          expires_in: 3600,
        });
      throw new Error("Unexpected upstream endpoint");
    },
  })(host.api);

  const accounts = new AccountStore(
    host.api.storage.kv,
    host.api.experimental_secrets,
  );

  const add = async () => {
    const account = await accounts.add(
      {
        provider: "codex",
        kind: "oauth",
        label: identity,
        email: null,
        accountUuid: null,
        codexAccountId: identity,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
      },
      {
        kind: "oauth",
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: expired ? 0 : clock + 3600000,
      },
    );

    await host.harness.behavior.callRpc("account.enable", { id: account.id });

    return account;
  };

  const account = await add();
  calls.length = 0;

  return {
    host,
    account,
    calls,
    add,
    nextIdentity: (value: string) => {
      identity = value;
    },
    expire: () => {
      expired = true;
    },
    tick: () => {
      clock += 1000;
    },
    reply: (value: typeof resetReply) => {
      resetReply = value;
    },
    usage: (value: typeof usageReply) => {
      usageReply = value;
    },
    list: () =>
      host.harness.behavior.callRpc(
        creditsMethod,
        { accountId: account.id },
        caller,
      ),
    redeem: (requestId = randomUUID()) =>
      host.harness.behavior.callRpc(
        redeemMethod,
        {
          accountId: account.id,
          creditId: "opaque-credit/1",
          redeemRequestId: requestId,
        },
        caller,
      ),
  };
}

describe("Codex reset owner boundary", () => {
  it("uses only the selected OAuth account and returns safe live listing fields", async () => {
    const f = await setup();
    f.nextIdentity("subscription-two");
    const second = await f.add();
    f.calls.length = 0;

    const result = await f.host.harness.behavior.callRpc(
      creditsMethod,
      { accountId: second.id },
      caller,
    );

    expect(result).toMatchObject({
      accountId: second.id,
      availableCount: 1,
      credits: [
        {
          id: "opaque-credit/1",
          status: "available",
          expiresAt: "2026-11-06T00:00:00Z",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private-provider-data");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(endpoint);
    expect(f.calls[0]?.init?.redirect).toBe("error");
    expect(
      new Headers(f.calls[0]?.init?.headers).get("chatgpt-account-id"),
    ).toBe("subscription-two");
    expect(new Headers(f.calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-access",
    );
  });
  it.each([
    { kind: "client" as const },
    { kind: "plugin" as const, pluginId: "composer-predictions" },
  ])("denies an unapproved RPC caller", async (identity) => {
    const f = await setup();
    await expect(
      f.host.harness.behavior.callRpc(
        creditsMethod,
        { accountId: f.account.id },
        { experimental_caller: identity },
      ),
    ).rejects.toThrow("Codex resets caller is not authorized");
    expect(f.calls).toHaveLength(0);
  });
  it("rejects removed and disabled accounts without sending credentials", async () => {
    const f = await setup();
    await f.host.harness.behavior.callRpc("account.disable", {
      id: f.account.id,
    });
    await expect(f.list()).rejects.toThrow("enabled Codex OAuth account");
    await expect(
      f.host.harness.behavior.callRpc(
        creditsMethod,
        { accountId: randomUUID() },
        caller,
      ),
    ).rejects.toThrow("enabled Codex OAuth account");
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { available_count: -1, credits: [] },
    {
      available_count: 1,
      credits: [{ id: "", status: "available", expires_at: null }],
    },
    {
      available_count: 1,
      credits: [{ id: "good", status: "available", expires_at: "tomorrow" }],
    },
    { available_count: 0 },
  ])("fails visibly for malformed listing data", async (payload) => {
    const f = await setup();
    f.reply(() => Response.json(payload));
    await expect(f.list()).rejects.toThrow("invalid reset-credit response");
  });
  it("rejects provider redirects and keeps raw upstream details out of errors", async () => {
    const f = await setup();
    f.reply(
      () =>
        new Response("sensitive-upstream-text", {
          status: 302,
          headers: { location: "https://other.invalid" },
        }),
    );
    await expect(f.list()).rejects.toThrow("HTTP 302");
    f.reply(() => {
      throw new Error("sensitive-upstream-text");
    });
    await expect(f.list()).rejects.toThrow("could not reach OpenAI");
  });
  it("bounds provider response bodies", async () => {
    const f = await setup();
    f.reply(() => new Response("x".repeat(70000)));
    await expect(f.list()).rejects.toThrow("too large");
  });
  it("refreshes a rejected token once with the same redemption UUID and no account failover", async () => {
    const f = await setup();
    let count = 0;
    f.reply(() =>
      ++count === 1
        ? new Response(null, { status: 401 })
        : Response.json({ code: "no_credit" }),
    );
    const requestId = randomUUID();
    await expect(f.redeem(requestId)).resolves.toMatchObject({
      code: "no_credit",
      usageRefreshError: null,
    });

    const requests = f.calls.filter(
      (call) => call.url === `${endpoint}/consume`,
    );

    expect(requests).toHaveLength(2);

    for (const call of requests)
      expect(JSON.parse(String(call.init?.body))).toEqual({
        credit_id: "opaque-credit/1",
        redeem_request_id: requestId,
      });
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-renewed",
    );
    expect(
      f.calls.filter((call) => call.url.includes("/oauth/token")),
    ).toHaveLength(1);
  });
  it("does not automatically replay an uncertain POST", async () => {
    const f = await setup();
    f.reply(() => {
      throw new Error("socket lost");
    });
    await expect(f.redeem()).rejects.toThrow("could not reach OpenAI");
    expect(
      f.calls.filter((call) => call.url.endsWith("/consume")),
    ).toHaveLength(1);
  });
  it.each(["reset", "already_redeemed"])(
    "refreshes observed quota after %s",
    async (code) => {
      const f = await setup();
      f.tick();
      f.reply(() => Response.json({ code }));
      f.usage(() =>
        Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 0,
              limit_window_seconds: 18000,
              reset_at: 1800000000,
            },
          },
        }),
      );
      await expect(f.redeem()).resolves.toMatchObject({
        accountId: f.account.id,
        code,
        usageRefreshError: null,
      });
      const status = await f.host.harness.behavior.callRpc("status.get", null);
      expect(status).toMatchObject({
        accounts: [{ id: f.account.id, limitWindows: [{ utilization: 0 }] }],
      });
      expect(
        f.calls.filter((call) => call.url.includes("/wham/usage")),
      ).toHaveLength(1);
    },
  );
  it.each(["no_credit", "nothing_to_reset"])(
    "returns %s without pretending quota changed",
    async (code) => {
      const f = await setup();
      f.reply(() => Response.json({ code }));
      await expect(f.redeem()).resolves.toMatchObject({
        code,
        usageRefreshError: null,
      });
      expect(
        f.calls.filter((call) => call.url.includes("/wham/usage")),
      ).toHaveLength(0);
    },
  );
  it.each([() => new Response(null, { status: 503 }), () => Response.json({})])(
    "preserves acknowledged reset when usage refresh fails",
    async (usage) => {
      const f = await setup();
      f.reply(() => Response.json({ code: "reset" }));
      f.usage(usage);
      await expect(f.redeem()).resolves.toMatchObject({
        code: "reset",
        usageRefreshError:
          "Reset acknowledged; account usage could not be refreshed.",
      });
    },
  );
  it("rejects unknown redemption codes and unvalidated action inputs", async () => {
    const f = await setup();
    f.reply(() => Response.json({ code: "future_success" }));
    await expect(f.redeem()).rejects.toThrow("invalid reset-credit response");
    f.calls.length = 0;
    await expect(
      f.host.harness.behavior.callRpc(
        redeemMethod,
        {
          accountId: f.account.id,
          creditId: "x\nvalue",
          redeemRequestId: randomUUID(),
        },
        caller,
      ),
    ).rejects.toThrow();
    await expect(
      f.host.harness.behavior.callRpc(
        redeemMethod,
        { accountId: f.account.id, redeemRequestId: "not-uuid" },
        caller,
      ),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it("requires explicit CLI confirmation and request identity", async () => {
    const f = await setup();

    const refused = await f.host.harness.behavior.runCli([
      "account",
      "reset",
      f.account.id,
      "--request-id",
      randomUUID(),
    ]);

    expect(refused.exitCode).not.toBe(0);
    expect(f.calls).toHaveLength(0);

    const list = await f.host.harness.behavior.runCli([
      "account",
      "reset-credits",
      f.account.id,
      "--json",
    ]);

    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ availableCount: 1 });
    f.reply(() => Response.json({ code: "nothing_to_reset" }));
    const requestId = randomUUID();

    const result = await f.host.harness.behavior.runCli([
      "account",
      "reset",
      f.account.id,
      "--confirm",
      "--request-id",
      requestId,
      "--credit-id",
      "opaque-credit/1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "nothing_to_reset",
    });
    expect(JSON.parse(String(f.calls.at(-1)?.init?.body))).toMatchObject({
      redeem_request_id: requestId,
    });
  });
});
