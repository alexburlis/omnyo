import { PoolTelemetry, TELEMETRY_MIGRATION } from "../telemetry.js";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import { accountPoolConfigSchema } from "../contracts.js";
import { createHub, type AccountPoolHub } from "../hub.js";
import { PoolOperations } from "../operations.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "../store.js";

export const HOUR = 60 * 60_000;

export const ROUTE = "/api/v1/plugins/account-pool/http";

export const REFRESH_URL = "https://oauth.invalid/token";

export const USAGE_URL = "https://usage.invalid/usage";

export const UPSTREAM_URL = "https://upstream.invalid";

export const SOL = "gpt-6.1-sol";

export const LUNA = "gpt-6-luna";

export const ASTRA = "gpt-6-astra";

export const CLIENT_VERSION = "0.167.0";

export const WEEK = 7 * 24 * HOUR;

export const TOKEN_LIFETIME = 5 * WEEK;

export type RejectionShape = "http" | "event-stream";

export interface PoolAccount {
  name: string;
  plan: string;
  unsupported: readonly string[];
  exhaustedFor?: number;
  credits?: boolean;
  catalog?: readonly string[];
  serviceTiers?: Readonly<Record<string, readonly string[]>>;
  legacySpeedTiers?: Readonly<Record<string, readonly string[]>>;
}

export const catalogEtag = (account: string, revision = 0) =>
  `W/"catalog-${account}-${revision}"`;

export type Responder = (call: {
  account: string;
  route: string;
  model: string;
  serviceTier: string | undefined;
}) => Response | undefined;

export const cleanups: Array<() => Promise<void>> = [];

export async function cleanupPools(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()?.();
}

export function oauthSecret(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
) {
  return { kind: "oauth" as const, accessToken, refreshToken, expiresAt };
}

export const rejectionMessage = (model: string) =>
  `The '${model}' model is not supported when using Codex with a ChatGPT account.`;

export function eventStream(events: ReadonlyArray<{ type: string }>): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

export function rejection(shape: RejectionShape, model: string): Response {
  if (shape === "http")
    return Response.json({ detail: rejectionMessage(model) }, { status: 400 });

  return eventStream([
    {
      type: "response.created",
      response: { id: "resp_rejected", status: "in_progress" },
    } as { type: string },
    {
      type: "response.failed",
      response: {
        id: "resp_rejected",
        status: "failed",
        error: { code: "model_not_found", message: rejectionMessage(model) },
      },
    } as { type: string },
  ]);
}

export function success(account: string, model: string): Response {
  return eventStream([
    {
      type: "response.created",
      response: { id: `resp_${account}`, status: "in_progress" },
    } as { type: string },
    {
      type: "response.output_text.delta",
      delta: `${account}:${model}`,
    } as { type: string },
    {
      type: "response.completed",
      response: { id: `resp_${account}`, status: "completed" },
    } as { type: string },
  ]);
}

export async function createPool(
  shape: RejectionShape,
  definitions: readonly PoolAccount[],
  respond: Responder = () => undefined,
) {
  const dataDir = await fs.mkdtemp(
    path.join(tmpdir(), "omnyo-account-pool-models-"),
  );

  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  const database = host.api.storage.database();
  host.api.storage.migrate(database, [
    ...QUOTA_MIGRATIONS,
    TELEMETRY_MIGRATION,
  ]);
  let time = 1_800_000_000_000;
  const now = () => time;
  const telemetry = new PoolTelemetry(database, now);

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
  const plans = new Map<string, string>();
  const unsupported = new Map<string, Set<string>>();
  const exhaustedUntil = new Map<string, number>();
  const credited = new Set<string>();
  const catalogs = new Map<string, readonly string[]>();

  const accountsByName = new Map(
    definitions.map((account) => [account.name, account]),
  );

  const catalogRevisions = new Map<string, number>();
  const failingCatalogs = new Set<string>();
  const catalogGates = new Map<string, Promise<void>>();
  const ids = new Map<string, string>();

  for (const [index, definition] of definitions.entries()) {
    plans.set(definition.name, definition.plan);
    unsupported.set(definition.name, new Set(definition.unsupported));

    if (definition.catalog !== undefined)
      catalogs.set(definition.name, definition.catalog);

    if (definition.exhaustedFor !== undefined)
      exhaustedUntil.set(definition.name, time + definition.exhaustedFor);

    if (definition.credits === true) credited.add(definition.name);

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
        time + TOKEN_LIFETIME,
      ),
    );

    ids.set(definition.name, account.id);
  }

  const attempts: string[] = [];

  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const account = new Headers(init?.headers).get("chatgpt-account-id") ?? "";

    if (url === USAGE_URL) {
      const until = exhaustedUntil.get(account);

      return Response.json({
        plan_type: plans.get(account),
        ...(until === undefined || until <= time
          ? {}
          : {
              rate_limit: {
                allowed: false,
                limit_reached: true,
                secondary_window: {
                  used_percent: 100,
                  reset_at: until / 1_000,
                  limit_window_seconds: 7 * 24 * 60 * 60,
                },
              },
              credits: {
                has_credits: credited.has(account),
                unlimited: false,
              },
            }),
      });
    }

    if (url.startsWith(`${UPSTREAM_URL}/models?client_version=`)) {
      attempts.push(`${account}:/models`);
      const slugs = catalogs.get(account);
      const gate = catalogGates.get(account);

      if (gate !== undefined) {
        const signal = init?.signal;

        await new Promise<void>((resolve, reject) => {
          void gate.then(resolve);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }

      if (slugs === undefined || failingCatalogs.has(account))
        return new Response(null, { status: 404 });

      return Response.json(
        {
          models: [
            {
              slug: "gpt-reserve",
              priority: 1,
              visibility: "hide",
              display_name: "reserve",
            },
            ...slugs.map((slug, index) => ({
              slug,
              priority: index + 2,
              visibility: "list",
              display_name: `${account} ${slug}`,
              additional_speed_tiers:
                accountsByName.get(account)?.legacySpeedTiers?.[slug],
              service_tiers: accountsByName
                .get(account)
                ?.serviceTiers?.[slug]?.map((tier) => ({
                  id: tier,
                  name: tier,
                  description: `${tier} service`,
                })),
            })),
          ],
        },
        {
          headers: {
            etag: catalogEtag(account, catalogRevisions.get(account) ?? 0),
          },
        },
      );
    }

    if (url.startsWith(`${UPSTREAM_URL}/`)) {
      const route = url.slice(UPSTREAM_URL.length);

      const { model, service_tier: serviceTier } = z
        .object({ model: z.string(), service_tier: z.string().optional() })
        .parse(
          JSON.parse(
            new TextDecoder().decode(
              z.instanceof(ArrayBuffer).parse(init?.body),
            ),
          ),
        );

      attempts.push(
        route === "/responses"
          ? `${account}:${model}`
          : `${account}:${route}:${model}`,
      );

      const answered = respond({ account, route, model, serviceTier });

      if (answered !== undefined) return answered;

      if (unsupported.get(account)?.has(model)) return rejection(shape, model);
      const served = success(account, model);

      if (catalogs.has(account))
        served.headers.set(
          "x-models-etag",
          catalogEtag(account, catalogRevisions.get(account) ?? 0),
        );

      return served;
    }

    throw new Error(`Unexpected network destination ${url}.`);
  };

  const startHub = async (
    current: ReturnType<typeof stores>,
  ): Promise<{ hub: AccountPoolHub; stop: () => Promise<void> }> => {
    const hub = createHub({
      telemetry,
      ...current,
      now,
      fetch: transport,
      getSettings: () =>
        accountPoolConfigSchema.parse({
          anthropicUpstreamBaseUrl: UPSTREAM_URL,
          codexUpstreamBaseUrl: UPSTREAM_URL,
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
  const hubCredential = await initial.hubTokens.forHost("synthetic-host");

  const id = (name: string) => {
    const value = ids.get(name);

    if (value === undefined) throw new Error(`Unknown account ${name}.`);

    return value;
  };

  return {
    telemetry: () => telemetry.report(null),
    attempts,
    id,
    hub: () => active.hub,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    now,
    setPlan: (name: string, plan: string) => plans.set(name, plan),
    allow: (name: string, model: string) =>
      unsupported.get(name)?.delete(model),
    refresh: (name: string) => active.hub.refreshUsage(id(name), true),
    disable: (name: string) => initial.accounts.setEnabled(id(name), false),
    enable: (name: string) => initial.accounts.setEnabled(id(name), true),
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
          time + TOKEN_LIFETIME,
        ),
      ),
    listedIncompatibleModels: async (name: string) => {
      const operations = new PoolOperations(
        initial.accounts,
        initial.quotas,
        active.hub,
        initial.hubTokens,
        new RoutingStore(host.api.storage.kv, now),
        async () => [],
        async () => [],
        now,
        () => {},
        (accountId) => active.hub.refreshUsage(accountId, true),
        async () => null,
      );

      return (await operations.list()).find(
        (candidate) => candidate.id === id(name),
      )?.incompatibleModels;
    },
    setCatalog: (name: string, slugs: readonly string[]) => {
      catalogs.set(name, slugs);
      catalogRevisions.set(name, (catalogRevisions.get(name) ?? 0) + 1);
    },
    failCatalog: (name: string, failing: boolean) =>
      failing ? failingCatalogs.add(name) : failingCatalogs.delete(name),
    holdCatalog: (name: string) => {
      let release = () => {};

      catalogGates.set(
        name,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );

      return () => {
        catalogGates.delete(name);
        release();
      };
    },
    turnHeaders: () => ({
      authorization: `Bearer ${hubCredential}`,
      "content-type": "application/json",
      "thread-id": "synthetic-thread",
    }),
    modelCatalog: async (name: string) =>
      (await active.hub.status()).accounts.find(
        (candidate) => candidate.id === id(name),
      )?.modelCatalog,
    markError: (name: string) =>
      initial.quotas.put({
        ...initial.quotas.get(id(name)),
        error: "synthetic account error",
      }),
    listModels: async (clientVersion = CLIENT_VERSION) => {
      attempts.length = 0;

      const response = await active.hub.handle(
        new Request(
          `https://hub.invalid${ROUTE}/v1/models?client_version=${clientVersion}`,
          { headers: { authorization: `Bearer ${hubCredential}` } },
        ),
        "codex",
        "/v1/models",
      );

      const body = z
        .object({
          models: z.array(
            z.object({
              slug: z.string(),
              priority: z.number(),
              visibility: z.string(),
              display_name: z.string(),
              service_tiers: z.array(z.object({ id: z.string() })).optional(),
              additional_speed_tiers: z.array(z.string()).optional(),
            }),
          ),
        })
        .parse(await response.json());

      return {
        status: response.status,
        etag: response.headers.get("etag"),
        models: body.models,
      };
    },
    incompatibleModels: async (name: string) => {
      const account = (await active.hub.status()).accounts.find(
        (candidate) => candidate.id === id(name),
      );

      return (account as Record<string, unknown> | undefined)
        ?.incompatibleModels;
    },
    request: async (
      model: string,
      routePath = "/v1/responses",
      serviceTier?: string,
    ) => {
      attempts.length = 0;

      const response = await active.hub.handle(
        new Request(`https://hub.invalid${ROUTE}${routePath}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${hubCredential}`,
            "content-type": "application/json",
            "thread-id": "synthetic-thread",
          },
          body: JSON.stringify({
            model,
            input: "ok",
            stream: true,
            service_tier: serviceTier,
          }),
        }),
        "codex",
        routePath,
      );

      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: await response.text(),
      };
    },
  };
}
