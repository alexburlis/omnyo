import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { createHub } from "./hub.js";
import { DEFAULT_ACCOUNT_POOL_CONFIG } from "./contracts.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
} from "./store.js";
import {
  CLAUDE_WORKFLOW_UNAVAILABLE,
  WORKFLOW_SYSTEM_PROMPT,
  type PoolWorkflowInput,
} from "./workflow-contract.js";
import { syntheticStream } from "./fixtures/workflow-stream.js";
import {
  composerPredictionSchema,
  predictionResult,
} from "./prediction-contract.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(kind: "oauth" | "api-key" = "oauth") {
  const { api, harness } = createFakePluginHost({ pluginId: "account-pool" });
  const accounts = new AccountStore(api.storage.kv, api.experimental_secrets);
  const tokens = new HubTokenStore(api.experimental_secrets);
  await tokens.initialize();
  const db = api.storage.database();
  api.storage.migrate(db, QUOTA_MIGRATIONS);
  const quotas = new QuotaStore(db);
  const now = Date.now();

  const account = await accounts.add(
    {
      provider: "codex",
      kind,
      label: "fixture",
      email: null,
      accountUuid: crypto.randomUUID(),
      subscriptionType: "promax",
      codexAccountId: "fixture-account",
      rateLimitTier: null,
      enabled: true,
      priority: 1,
    },
    kind === "oauth"
      ? {
          kind,
          accessToken: "fixture-oauth",
          refreshToken: "fixture-refresh",
          expiresAt: now + 3600000,
        }
      : { kind, apiKey: "fixture-key" },
  );

  const usage = {
    account_id: "fixture-account",
    plan_type: "promax",
    credits: { has_credits: false, unlimited: false, balance: "0" },
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 20,
        reset_at: (now + 3600000) / 1000,
        limit_window_seconds: 18000,
      },
    },
  };

  let rawUsage: unknown = usage;
  let responseText = "Wire verified";

  const calls: { headers: Headers; body: unknown }[] = [];

  const hub = createHub({
    accounts,
    quotas,
    affinity: new PoolAffinityStore(db),
    hubTokens: tokens,
    getSettings: () => DEFAULT_ACCOUNT_POOL_CONFIG,
    drainTimeoutMs: 100,
    fetch: async (url, init) => {
      if (String(url).endsWith("/responses")) {
        calls.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)),
        });

        return new Response(syntheticStream("codex", responseText), {
          headers: { "content-type": "text/event-stream" },
        });
      }

      return Response.json(rawUsage);
    },
  });

  const stop = new AbortController();
  void hub.start(stop.signal);
  cleanups.push(async () => {
    stop.abort();
    await hub.stop();
    await harness.dispose();
  });

  const input: PoolWorkflowInput = {
    hostId: "host",
    providerId: "codex",
    attemptId: "attempt",
    model: "gpt-6-luna",
    prompt: "Draft",
    timeoutMs: 1000,
    maxOutputBytes: 1000,
  };

  const send = (capability: string, route = "/v1/responses") =>
    hub.handle(
      new Request(`http://fixture${route}`, {
        method: "POST",
        headers: {
          "x-omnyo-workflow-token": capability,
          session_id: "native-client-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          stream: true,
          tools: [],
          input: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: WORKFLOW_SYSTEM_PROMPT }],
            },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: input.prompt }],
            },
          ],
        }),
      }),
      "codex",
      route,
    );

  return {
    hub,
    account,
    accounts,
    quotas,
    input,
    send,
    calls,
    usage,
    setResponseText: (value: string) => {
      responseText = value;
    },
    setRawUsage: (value: unknown) => {
      rawUsage = value;
    },
  };
}

describe("workflow included-only lease", () => {
  it("preserves official headers, permits one exact text request and revokes the lease", async () => {
    const test = await setup();

    const lease = await test.hub.prepareWorkflow(
      test.input,
      new AbortController().signal,
    );

    const response = await test.send(lease.capability);
    expect(response.status).toBe(200);
    await response.text();
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.headers.get("session_id")).toBe(
      "native-client-session",
    );
    expect((await test.send(lease.capability)).status).toBe(409);
    lease.revoke();
    expect((await test.send(lease.capability)).status).toBe(401);
  });
  it("does not trust a fresh rejected normalized quota without explicit raw credit evidence", async () => {
    const test = await setup();
    test.setRawUsage({ ...test.usage, credits: undefined });
    await expect(
      test.hub.prepareWorkflow(test.input, new AbortController().signal),
    ).rejects.toThrow();
    expect(test.calls).toHaveLength(0);
  });
  it("never uses API keys", async () => {
    const test = await setup("api-key");
    await expect(
      test.hub.prepareWorkflow(test.input, new AbortController().signal),
    ).rejects.toThrow();
    expect(test.calls).toHaveLength(0);
  });
  it.each(["credits", "stale", "disabled"])(
    "rechecks %s at actual dispatch",
    async (change) => {
      const test = await setup();

      const lease = await test.hub.prepareWorkflow(
        test.input,
        new AbortController().signal,
      );

      const quota = test.quotas.get(test.account.id);

      if (change === "disabled")
        await test.accounts.setEnabled(test.account.id, false);
      else
        test.quotas.put({
          ...quota,
          ...(change === "stale"
            ? { observedAt: Date.now() - 60001 }
            : {
                extraUsage: {
                  status: "allowed",
                  hasCredits: true,
                  unlimited: false,
                  observedAt: Date.now(),
                  source: "usage",
                },
              }),
        });
      expect((await test.send(lease.capability)).status).toBe(429);
      expect(test.calls).toHaveLength(0);
      lease.revoke();
    },
  );
  it("refuses Claude workflow leases even with accounts configured", async () => {
    const test = await setup();
    await expect(
      test.hub.prepareWorkflow(
        { ...test.input, providerId: "claude-code", model: "claude-haiku-4-5" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(CLAUDE_WORKFLOW_UNAVAILABLE);
    expect(test.calls).toHaveLength(0);
  });
  it.each(["extra-usage", "stale", "disabled"])(
    "rechecks %s at actual dispatch",
    async (change) => {
      const test = await setup();

      const lease = await test.hub.prepareWorkflow(
        test.input,
        new AbortController().signal,
      );

      const quota = test.quotas.get(test.account.id);

      if (change === "disabled")
        await test.accounts.setEnabled(test.account.id, false);
      else
        test.quotas.put({
          ...quota,
          ...(change === "stale"
            ? { observedAt: Date.now() - 60001 }
            : {
                extraUsage: {
                  status: "allowed",
                  hasCredits: true,
                  unlimited: false,
                  observedAt: Date.now(),
                  source: "usage",
                },
              }),
        });
      expect((await test.send(lease.capability)).status).toBe(429);
      expect(test.calls).toHaveLength(0);
      lease.revoke();
    },
  );
});

describe("pooled composer prediction", () => {
  const result = {
    suggestion: "Check the update.",
    noSuggestionReason: null,
    archiveReadiness: {
      ready: false,
      reason: "The update still needs checking.",
    },
  };

  it("uses the Codex subscription and constrains the upstream request to structured text", async () => {
    const test = await setup();
    test.setResponseText(JSON.stringify(result));

    const text = await test.hub.completePrediction(
      test.input,
      composerPredictionSchema([], true),
      new AbortController().signal,
      async () => {},
    );

    expect(predictionResult(text, [], true).text).toBe(result.suggestion);
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.headers.get("chatgpt-account-id")).toBe(
      "fixture-account",
    );
    expect(test.calls[0]?.headers.has("x-omnyo-workflow-token")).toBe(false);
    expect(test.calls[0]?.body).toMatchObject({
      model: test.input.model,
      store: false,
      stream: true,
      tools: [],
      tool_choice: "none",
      text: { format: { type: "json_schema", strict: true } },
      input: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [{ type: "input_text", text: test.input.prompt }],
        }),
      ]),
    });
  });

  it("does not use a Claude account when it is the only enabled account", async () => {
    const test = await setup();
    await test.accounts.setEnabled(test.account.id, false);
    await test.accounts.add(
      {
        provider: "claude",
        kind: "api-key",
        label: "Anthropic fixture",
        email: null,
        accountUuid: crypto.randomUUID(),
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 0,
      },
      { kind: "api-key", apiKey: "fixture-key" },
    );

    await expect(
      test.hub.completePrediction(
        test.input,
        composerPredictionSchema(),
        new AbortController().signal,
        async () => {},
      ),
    ).rejects.toThrow("fresh included Codex allowance");
    expect(test.calls).toHaveLength(0);
  });

  it.each(["api-key", "credits", "unknown credits", "source changed"] as const)(
    "sends no inference when %s prevents admission",
    async (blocker) => {
      const test = await setup(blocker === "api-key" ? "api-key" : "oauth");

      if (blocker === "credits" || blocker === "unknown credits")
        test.setRawUsage({
          ...test.usage,
          credits:
            blocker === "credits"
              ? { has_credits: true, unlimited: false, balance: "5" }
              : undefined,
        });

      await expect(
        test.hub.completePrediction(
          test.input,
          composerPredictionSchema(),
          new AbortController().signal,
          async () => {
            if (blocker === "source changed")
              throw new Error("Prediction source changed");
          },
        ),
      ).rejects.toThrow();

      expect(test.calls).toHaveLength(0);
    },
  );
});
