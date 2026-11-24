import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  accountPoolConfigSchema,
  type composerPredictionAllowanceSchema,
} from "./contracts.js";
import { createHub, type AccountPoolHub } from "./hub.js";
import {
  composerPredictionPrompt,
  type ComposerPredictionConfiguration,
} from "./prediction-contract.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
} from "./store.js";

const HOUR = 60 * 60_000;

const DAY = 24 * HOUR;

const ROUTE = "/api/v1/plugins/account-pool/http";

const REFRESH_URL = "https://oauth.invalid/token";

const USAGE_URL = "https://usage.invalid/usage";

const UPSTREAM_URL = "https://upstream.invalid";

const CONFIG_URL = "https://chatgpt.com/backend-api/wham/predictions/config";

const NOT_ENABLED =
  "OpenAI has not enabled composer predictions for any available account";

const THREAD_AFFINITY_KEY = JSON.stringify([
  "codex",
  "synthetic-host",
  "session:synthetic-native-thread",
]);

interface PredictionAccount {
  name: string;
  plan: string;
  allowance: "included" | "prepaid";
  predictions: boolean | "not-found";
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function oauthSecret(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
) {
  return { kind: "oauth" as const, accessToken, refreshToken, expiresAt };
}

function usage(
  definition: Pick<PredictionAccount, "plan" | "allowance">,
  now: number,
) {
  if (definition.allowance === "included")
    return {
      plan_type: definition.plan,
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 0,
          reset_at: (now + 30 * DAY) / 1_000,
          limit_window_seconds: 30 * 24 * 60 * 60,
        },
      },
      credits: { has_credits: false, unlimited: false },
    };

  return {
    plan_type: definition.plan,
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: {
        used_percent: 100,
        reset_at: (now + 3 * HOUR) / 1_000,
        limit_window_seconds: 5 * 60 * 60,
      },
      secondary_window: {
        used_percent: 16,
        reset_at: (now + 5 * DAY) / 1_000,
        limit_window_seconds: 7 * 24 * 60 * 60,
      },
    },
    credits: { has_credits: true, unlimited: false },
  };
}

function completedStream(account: string): Response {
  return new Response(
    [
      { type: "response.created", response: { id: `resp_${account}` } },
      { type: "response.output_text.delta", delta: account },
      { type: "response.completed", response: { id: `resp_${account}` } },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function createPredictionPool(
  definitions: readonly PredictionAccount[],
  allowance: z.infer<typeof composerPredictionAllowanceSchema>,
  routedTo: string | null = null,
) {
  const dataDir = await fs.mkdtemp(
    path.join(tmpdir(), "omnyo-account-pool-predictions-"),
  );

  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  const database = host.api.storage.database();
  host.api.storage.migrate(database, QUOTA_MIGRATIONS);
  let time = 1_800_000_000_000;
  const now = () => time;

  const stores = () => ({
    accounts: new AccountStore(
      host.api.storage.kv,
      host.api.experimental_secrets,
    ),
    quotas: new QuotaStore(database),
    affinity: new PoolAffinityStore(database),
    hubTokens: new HubTokenStore(host.api.experimental_secrets, now),
  });

  const initial = stores();
  const accounts = new Map<string, PredictionAccount>();
  const ids = new Map<string, string>();

  for (const [index, definition] of definitions.entries()) {
    accounts.set(definition.name, { ...definition });

    const account = await initial.accounts.add(
      {
        provider: "codex",
        kind: "oauth",
        label: definition.name,
        email: null,
        accountUuid: null,
        codexAccountId: definition.name,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: (index + 1) * 100,
      },
      oauthSecret(
        `synthetic-access-${index}`,
        `synthetic-refresh-${index}`,
        time + 72 * HOUR,
      ),
    );

    ids.set(definition.name, account.id);
  }

  if (routedTo !== null) {
    const accountId = ids.get(routedTo);

    if (accountId === undefined)
      throw new Error(`Unknown account ${routedTo}.`);
    initial.affinity.putBinding(THREAD_AFFINITY_KEY, {
      accountId,
      lastUsedAt: time,
    });
    initial.affinity.putActiveAccount("codex", accountId);
  }

  const configCalls: string[] = [];
  const inferences: string[] = [];

  const definition = (name: string) => {
    const value = accounts.get(name);

    if (value === undefined) throw new Error(`Unknown account ${name}.`);

    return value;
  };

  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const account = new Headers(init?.headers).get("chatgpt-account-id") ?? "";

    if (url === USAGE_URL)
      return Response.json(usage(definition(account), time));

    if (url === CONFIG_URL) {
      configCalls.push(account);

      if (definition(account).predictions === "not-found")
        return Response.json({ detail: "Not Found" }, { status: 404 });

      return Response.json({
        is_enabled: definition(account).predictions,
        prompt: "Provider fixture prompt",
        prompt_version: "fixture-v1",
        prediction_reasoning_effort: "low",
      });
    }

    if (url === `${UPSTREAM_URL}/responses`) {
      inferences.push(account);

      return completedStream(account);
    }

    throw new Error(`Unexpected network destination ${url}.`);
  };

  const startHub = async (
    current: ReturnType<typeof stores>,
  ): Promise<{ hub: AccountPoolHub; stop: () => Promise<void> }> => {
    const hub = createHub({
      ...current,
      now,
      fetch: transport,
      getSettings: () =>
        accountPoolConfigSchema.parse({
          anthropicUpstreamBaseUrl: UPSTREAM_URL,
          codexUpstreamBaseUrl: UPSTREAM_URL,
          composerPredictionAllowance: allowance,
        }),
      codexRefreshUrl: REFRESH_URL,
      codexUsageUrl: USAGE_URL,
    });

    const controller = new AbortController();
    const running = hub.start(controller.signal);
    await hub.refreshUsage();

    return {
      hub,
      stop: async () => {
        controller.abort();
        await running;
      },
    };
  };

  let active = await startHub(initial);
  cleanups.push(async () => {
    await active.stop();
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const id = (name: string) => {
    const value = ids.get(name);

    if (value === undefined) throw new Error(`Unknown account ${name}.`);

    return value;
  };

  const affinity = new PoolAffinityStore(database);

  return {
    configCalls,
    inferences,
    now,
    id,
    routing: () => ({
      pin:
        affinity.loadBindings(0, 1_000).get(THREAD_AFFINITY_KEY)?.accountId ??
        null,
      cursor: affinity.loadActiveAccounts().get("codex")?.accountId ?? null,
      liveCursor: active.hub.activeAccountId("codex"),
    }),
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    change: (name: string, update: Partial<PredictionAccount>) =>
      accounts.set(name, { ...definition(name), ...update }),
    restart: async () => {
      await active.stop();
      active = await startHub(stores());
    },
    signInAgain: (name: string) =>
      active.hub.replaceSecret(
        id(name),
        oauthSecret(
          "synthetic-access-again",
          "synthetic-refresh-again",
          time + 72 * HOUR,
        ),
      ),
    predictionsDisabled: async (name: string) => {
      const account = (await active.hub.status()).accounts.find(
        (candidate) => candidate.id === id(name),
      );

      return (account as Record<string, unknown> | undefined)
        ?.composerPredictionsDisabled;
    },
    prepare: (includedOnly = false) => {
      configCalls.length = 0;

      return active.hub.prepareComposerPrediction(
        "synthetic-host",
        "synthetic-native-thread",
        new AbortController().signal,
        async () => {},
        includedOnly,
        false,
      );
    },
    forward: async (prepared: {
      capability: string;
      configuration: ComposerPredictionConfiguration;
    }) => {
      inferences.length = 0;

      const response = await active.hub.handle(
        new Request(`https://hub.invalid${ROUTE}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-omnyo-composer-prediction-token": prepared.capability,
          },
          body: JSON.stringify({
            model: "gpt-6.1-sol",
            store: false,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: composerPredictionPrompt(prepared.configuration),
                  },
                ],
              },
            ],
          }),
        }),
        "codex",
        "/v1/responses",
      );

      return { status: response.status, body: await response.text() };
    },
  };
}

const freeAndPlus: readonly PredictionAccount[] = [
  {
    name: "free-account",
    plan: "free",
    allowance: "included",
    predictions: false,
  },
  {
    name: "plus-account",
    plan: "plus",
    allowance: "prepaid",
    predictions: true,
  },
];

describe("Composer prediction eligibility", () => {
  it("leases prepaid credits on an enabled account after OpenAI disables predictions for the included account", async () => {
    const pool = await createPredictionPool(
      freeAndPlus,
      "included-or-prepaid-credits",
    );

    const prepared = await pool.prepare();

    expect(pool.configCalls).toEqual(["free-account", "plus-account"]);
    expect(await pool.forward(prepared)).toMatchObject({ status: 200 });
    expect(pool.inferences).toEqual(["plus-account"]);
    expect(await pool.predictionsDisabled("free-account")).toEqual({
      plan: "free",
      observedAt: pool.now(),
    });
    expect(await pool.predictionsDisabled("plus-account")).toBeNull();
  });

  it("leases the next account when OpenAI has no predictions configuration for the included account", async () => {
    const pool = await createPredictionPool(
      [{ ...freeAndPlus[0]!, predictions: "not-found" }, freeAndPlus[1]!],
      "included-or-prepaid-credits",
    );

    const prepared = await pool.prepare();

    expect(pool.configCalls).toEqual(["free-account", "plus-account"]);
    expect(await pool.forward(prepared)).toMatchObject({ status: 200 });
    expect(pool.inferences).toEqual(["plus-account"]);
    expect(await pool.predictionsDisabled("free-account")).toEqual({
      plan: "free",
      observedAt: pool.now(),
    });
  });

  it("keeps the thread's pin and the provider cursor when predictions detour to prepaid credits", async () => {
    const pool = await createPredictionPool(
      [
        freeAndPlus[0]!,
        freeAndPlus[1]!,
        {
          name: "second-free-account",
          plan: "free",
          allowance: "included",
          predictions: false,
        },
      ],
      "included-or-prepaid-credits",
      "free-account",
    );

    const pinned = pool.id("free-account");
    const prepared = await pool.prepare();

    expect(pool.configCalls).toEqual([
      "free-account",
      "second-free-account",
      "plus-account",
    ]);
    expect(await pool.forward(prepared)).toMatchObject({ status: 200 });
    expect(pool.inferences).toEqual(["plus-account"]);
    expect(pool.routing()).toEqual({
      pin: pinned,
      cursor: pinned,
      liveCursor: pinned,
    });
  });

  it("skips the marked account on later predictions, including after a restart", async () => {
    const pool = await createPredictionPool(
      freeAndPlus,
      "included-or-prepaid-credits",
    );

    await pool.forward(await pool.prepare());

    const second = await pool.prepare();
    expect(pool.configCalls).toEqual(["plus-account"]);
    expect(await pool.forward(second)).toMatchObject({ status: 200 });
    expect(pool.inferences).toEqual(["plus-account"]);

    await pool.restart();

    await pool.prepare();
    expect(pool.configCalls).toEqual(["plus-account"]);
  });

  it.each([
    { allowance: "included-only", includedOnly: false },
    { allowance: "included-or-prepaid-credits", includedOnly: true },
  ] as const)(
    "never spends prepaid credits under $allowance with includedOnly=$includedOnly",
    async ({ allowance, includedOnly }) => {
      const pool = await createPredictionPool(freeAndPlus, allowance);

      await expect(pool.prepare(includedOnly)).rejects.toThrow(NOT_ENABLED);
      expect(pool.configCalls).toEqual(["free-account"]);
      expect(await pool.predictionsDisabled("free-account")).toEqual({
        plan: "free",
        observedAt: pool.now(),
      });

      await expect(pool.prepare(includedOnly)).rejects.toThrow(NOT_ENABLED);
      expect(pool.configCalls).toEqual([]);
      expect(pool.inferences).toEqual([]);
    },
  );

  it("reports that no available account is enabled when OpenAI disables every candidate", async () => {
    const pool = await createPredictionPool(
      [
        ...freeAndPlus.slice(0, 1),
        {
          name: "go-account",
          plan: "go",
          allowance: "included",
          predictions: false,
        },
        { ...freeAndPlus[1]!, predictions: false },
      ],
      "included-or-prepaid-credits",
    );

    await expect(pool.prepare()).rejects.toThrow(NOT_ENABLED);
    expect(pool.configCalls).toHaveLength(3);
    expect(pool.configCalls.slice(0, 2).sort()).toEqual([
      "free-account",
      "go-account",
    ]);
    expect(pool.configCalls[2]).toBe("plus-account");

    for (const name of ["free-account", "go-account", "plus-account"])
      expect(await pool.predictionsDisabled(name)).not.toBeNull();

    await expect(pool.prepare()).rejects.toThrow(NOT_ENABLED);
    expect(pool.configCalls).toEqual([]);
  });

  it("checks the account again when its plan changes", async () => {
    const pool = await createPredictionPool(
      freeAndPlus,
      "included-or-prepaid-credits",
    );

    await pool.prepare();
    pool.change("free-account", { plan: "plus", predictions: true });

    const prepared = await pool.prepare();

    expect(pool.configCalls).toEqual(["free-account"]);
    expect(await pool.predictionsDisabled("free-account")).toBeNull();
    expect(await pool.forward(prepared)).toMatchObject({ status: 200 });
    expect(pool.inferences).toEqual(["free-account"]);
  });

  it("checks the account again after it signs in again", async () => {
    const pool = await createPredictionPool(
      freeAndPlus,
      "included-or-prepaid-credits",
    );

    await pool.prepare();
    await pool.signInAgain("free-account");

    expect(await pool.predictionsDisabled("free-account")).toBeNull();
    await pool.prepare();
    expect(pool.configCalls).toEqual(["free-account", "plus-account"]);
  });

  it("keeps skipping a marked account within the hour", async () => {
    const pool = await createPredictionPool(
      freeAndPlus,
      "included-or-prepaid-credits",
    );

    await pool.prepare();
    pool.advance(HOUR - 60_000);

    await pool.prepare();
    expect(pool.configCalls).toEqual(["plus-account"]);
  });

  it("checks the account again once the mark expires after an hour", async () => {
    const pool = await createPredictionPool(
      freeAndPlus,
      "included-or-prepaid-credits",
    );

    await pool.prepare();
    pool.advance(HOUR + 60_000);

    expect(await pool.predictionsDisabled("free-account")).toBeNull();
    await pool.prepare();
    expect(pool.configCalls).toEqual(["free-account", "plus-account"]);
    expect(await pool.predictionsDisabled("free-account")).toEqual({
      plan: "free",
      observedAt: pool.now(),
    });
  });
});
