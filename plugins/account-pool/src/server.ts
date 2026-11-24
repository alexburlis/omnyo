import { registerWorkflowService } from "./workflow-service.js";
import {
  PoolTelemetry,
  TELEMETRY_MIGRATION,
  telemetryRpcContract,
} from "./telemetry.js";
import {
  retryAvailabilityContract,
  retryAvailabilityMethod,
  type RetryAvailability,
} from "./retry-contract.js";
import { modelFamily } from "./quota.js";
import { modelFamilySchema } from "./contracts.js";
import { registerComposerPredictions } from "./composer-predictions.js";
import { registerUsageSource } from "./usage-source.js";
import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";
import { z } from "zod";
import type {
  ExperimentalPluginProviderEnvContext,
  PluginApi,
} from "@omnyo/plugin-sdk";
import { registerPoolCli } from "./cli.js";
import {
  CLAUDE_POOL_THREAD_RETIRED,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  poolAvailabilitySchema,
  type AccountPoolConfigController,
  type PoolProvider,
  type PoolStatus,
} from "./contracts.js";
import {
  AVAILABILITY_PATH,
  CLAUDE_API_KEY_PROXY_HEADER,
  CLAUDE_API_KEY_PROXY_PREFIX,
  PARENT_TOKEN_ENV,
  PARENT_URL_ENV,
  ParentAvailability,
  readParentPool,
  type ParentPool,
} from "./parent-pool.js";
import { createHub, DEFAULT_ACCOUNT_POOL_DRAIN_TIMEOUT_MS } from "./hub.js";

import { PoolOperations } from "./operations.js";
import { poolModelNotice } from "./model-notice.js";
import {
  accountPoolRpcContract,
  createRpcHandlers,
  registerCodexResetRpc,
} from "./rpc.js";
import { CodexDeviceLogin } from "./codex-device-login.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";

export interface AccountPoolPluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  availabilityTtlMs?: number;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  drainTimeoutMs?: number;
  maxAffinityBindings?: number;
  disposeTimeoutMs?: number;
  codexAuthBaseUrl?: string;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;

const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");

const HUB_BASE_PATH = "/api/v1/plugins/account-pool/http";

const RETIRED_CLAUDE_PATH = "/retired-claude-pool";

const CLAUDE_MODELS_ROUTE = "/claude/v1/models";

const PROVIDER_ROUTING_ENV: Record<PoolProvider, readonly string[]> = {
  claude: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "OMNYO_CLAUDE_MODELS_URL",
  ],
  codex: ["CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"],
};

interface PoolEnvEntry {
  name: string;
  value: string | { serverPath: string };
  reason: string;
}

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(api: PluginApi): Promise<void> {
    const storedConfig = z
      .record(z.string(), z.unknown())
      .parse((await api.storage.kv.get("config")) ?? {});

    const hasRemovedSettings =
      "cacheMissDebug" in storedConfig || "cacheMissMinTokens" in storedConfig;

    delete storedConfig.cacheMissDebug;
    delete storedConfig.cacheMissMinTokens;
    delete storedConfig.composerPredictionAllowance;
    let currentSettings = accountPoolConfigSchema.parse(storedConfig);

    if (hasRemovedSettings) {
      await api.storage.kv.set("config", currentSettings);
    }

    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);

        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });

        await api.storage.kv.set("config", next);
        currentSettings = next;
        api.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});

        return next;
      },
    };

    const accounts = new AccountStore(api.storage.kv, api.experimental_secrets);
    const now = options.now ?? Date.now;
    const hubTokens = new HubTokenStore(api.experimental_secrets, now);
    await hubTokens.initialize();
    const enrolledHosts = await api.sdk.hosts.list();
    await hubTokens.prune(enrolledHosts.map((host) => host.id));
    const routing = new RoutingStore(api.storage.kv, now);
    const env = options.env ?? process.env;
    const parentPool = readParentPool(env);

    const proxyingParent = (): ParentPool | null =>
      parentPool !== null && currentSettings.parentMode === "proxy"
        ? parentPool
        : null;

    const db = api.storage.database();
    api.storage.migrate(db, [...QUOTA_MIGRATIONS, TELEMETRY_MIGRATION]);
    const telemetry = new PoolTelemetry(db, now);
    const quotas = new QuotaStore(db, (quota) => telemetry.observeQuota(quota));
    api.rpc.register(telemetryRpcContract, {
      "experimental_telemetry.v1.report": ({ accountId }) =>
        telemetry.report(accountId),
    });

    const transport =
      options.fetch === undefined ? createUpstreamTransport() : null;

    const upstreamFetch = options.fetch ?? transport?.fetch;

    const hub = createHub({
      telemetry,
      accounts,
      quotas,
      affinity: new PoolAffinityStore(db),
      hubTokens,
      getSettings: () => currentSettings,
      fetch: upstreamFetch,
      now,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      drainTimeoutMs: options.drainTimeoutMs,
      maxAffinityBindings: options.maxAffinityBindings,
      getParentRoute: proxyingParent,
      onUpstreamError: (provider, error) =>
        api.log.warn(
          `Account Pooler ${provider} transport failed: ${transportErrorCode(error)}.`,
        ),
      onUpstreamDiagnostic: (provider, diagnostic) =>
        api.log.warn(
          `Account Pooler ${provider} upstream diagnostic: ${JSON.stringify(diagnostic)}`,
        ),
      onAccountsChanged: () =>
        api.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      onOAuthRefresh: (provider, accountId, outcome, detail) => {
        const message = `Account Pooler ${provider} account ${accountId} OAuth refresh ${outcome}: ${detail}`;

        if (outcome === "succeeded") api.log.info(message);
        else api.log.warn(message);
      },
    });

    if (transport !== null) {
      api.onDispose(async () => {
        await hub.stop();
        await transport.destroy();
      });
    }

    const availability =
      parentPool === null
        ? null
        : new ParentAvailability({
            parent: parentPool,
            fetch: upstreamFetch ?? fetch,
            now,
            ...(options.availabilityTtlMs === undefined
              ? {}
              : { ttlMs: options.availabilityTtlMs }),
            onError: (error) =>
              api.log.warn(
                `Account Pooler could not read parent availability: ${error instanceof Error ? error.message : String(error)}.`,
              ),
          });

    const parentStatus = async (): Promise<PoolStatus["parent"]> =>
      parentPool === null || availability === null
        ? null
        : {
            baseUrl: parentPool.baseUrl,
            mode: currentSettings.parentMode,
            availability: await availability.get(),
          };

    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      () => api.sdk.hosts.list(),
      async (hostId) =>
        (await api.sdk.system.providerStates({ hostId })).providers,
      now,
      () => api.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      (accountId) => hub.refreshUsage(accountId, true),
      parentStatus,
    );

    const codexLogin = new CodexDeviceLogin({
      fetch: upstreamFetch,
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      validateTarget: (target) =>
        operations.validateLoginTarget("codex", target),
      saveLogin: (authenticated, target) =>
        operations.addCodexOAuth(authenticated, target),
    });

    if ((await accounts.listRoutable()).every((account) => !account.enabled)) {
      api.status.needsConfiguration(
        "Add an Anthropic API key or Codex account with `omnyo pool account add`.",
      );
    }

    const routedProviderSchema = z.enum(["claude", "codex"]);

    const claudeApiKeyRoute = "claude-api-key";

    const retryRouteSchema = z
      .enum(["claude", "claude-api-key", "codex"])
      .transform((route) => (route === claudeApiKeyRoute ? "claude" : route));

    const failedRequestSchema = z.object({
      requestId: z.string(),
      execution: z.object({
        model: z.string(),
        serviceTier: z.string().nullish(),
      }),
    });

    const retryAvailability = async (input: {
      threadId: string;
      requestId: string;
    }): Promise<RetryAvailability> => {
      const provider = retryRouteSchema.safeParse(
        await api.storage.kv.get(`retry-route:${input.threadId}`),
      );

      if (!provider.success) return { kind: "not-routed" };

      const events = await api.sdk.threads.events.list({
        threadId: input.threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
      });

      const request = failedRequestSchema.safeParse(events[0]?.data);

      if (!request.success || request.data.requestId !== input.requestId)
        return { kind: "unavailable", reason: "source-unavailable" };

      return hub.retryAvailability(
        provider.data,
        modelFamily(request.data.execution.model),
        request.data.execution.model,
        request.data.execution.serviceTier ?? null,
      );
    };

    api.rpc.register(
      retryAvailabilityContract,
      { [retryAvailabilityMethod]: retryAvailability },
      {
        experimental_discoverable: true,
        experimental_description:
          "Account Pooler retry availability for routed failed turns.",
      },
    );
    registerUsageSource(api, hub);
    registerComposerPredictions(api);
    registerWorkflowService(api, hub, routing);
    registerCodexResetRpc(api, hub);
    api.rpc.register(
      accountPoolRpcContract,
      createRpcHandlers(operations, codexLogin, config),
    );
    registerPoolCli(api, operations, codexLogin, config, hub, telemetry);

    const canServe = async (provider: PoolProvider): Promise<boolean> => {
      if (!(await operations.isRoutingEnabled(provider))) return false;

      if (proxyingParent() !== null && availability !== null) {
        return (await availability.get())[provider];
      }

      return operations.hasUsableEnabledAccount(provider);
    };

    const markerEntries = (token: string): PoolEnvEntry[] => [
      {
        name: PARENT_URL_ENV,
        value: { serverPath: HUB_BASE_PATH },
        reason: "Account Pooler hub for nested Omnyo servers on this machine",
      },
      {
        name: PARENT_TOKEN_ENV,
        value: token,
        reason: "Account Pooler hub token for this machine",
      },
    ];

    const legacyClaudeOverrides = (
      [
        "ENABLE_PROMPT_CACHING_1H",
        "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
      ] as const
    ).flatMap((name) =>
      parentPool !== null && env[name] !== undefined
        ? [
            {
              name,
              value: "",
              reason: "Clear the parent pool's Claude subscription override.",
            },
          ]
        : [],
    );

    const neutralized = (provider: PoolProvider): PoolEnvEntry[] => [
      ...PROVIDER_ROUTING_ENV[provider].map((name) => ({
        name,
        value: "",
        reason:
          "Account Pooler is isolated from the parent Omnyo server's pool on this instance",
      })),
      ...(provider === "claude" ? legacyClaudeOverrides : []),
    ];

    const canKeepOldClaudeRoute = async (
      context: Extract<
        ExperimentalPluginProviderEnvContext,
        { threadId: string }
      >,
    ): Promise<boolean> => {
      if (proxyingParent() !== null) return false;

      const [completion] = await api.sdk.threads.events.list({
        threadId: context.threadId,
        types: ["turn/completed"],
        order: "desc",
        limit: "1",
      });

      return (
        completion?.type === "turn/completed" &&
        typeof completion.data.providerThreadId === "string" &&
        (await hub.hasClaudeApiKeyAffinity(
          context.hostId,
          completion.data.providerThreadId,
        ))
      );
    };

    const retiredClaudeEntries = async (
      hostId: string,
    ): Promise<PoolEnvEntry[]> => [
      ...legacyClaudeOverrides,
      {
        name: "OMNYO_CLAUDE_MODELS_URL",
        value: "",
        reason: CLAUDE_POOL_THREAD_RETIRED,
      },
      {
        name: "ANTHROPIC_BASE_URL",
        value: { serverPath: `${HUB_BASE_PATH}${RETIRED_CLAUDE_PATH}` },
        reason: CLAUDE_POOL_THREAD_RETIRED,
      },
      {
        name: "ANTHROPIC_AUTH_TOKEN",
        value: await hubTokens.forHost(hostId),
        reason: "Account Pooler hub token for this machine",
      },
      {
        name: "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
        value: "1",
        reason: CLAUDE_POOL_THREAD_RETIRED,
      },
    ];

    const contributeFor =
      (
        provider: PoolProvider,
        serving: (token: string) => Promise<PoolEnvEntry[]>,
      ) =>
      async (context: ExperimentalPluginProviderEnvContext) => {
        if (context.purpose === "model-list") {
          if (await canServe(provider)) {
            return serving(await hubTokens.forHost(context.hostId));
          }

          return parentPool === null ? [] : neutralized(provider);
        }

        const routeKey = `retry-route:${context.threadId}`;
        const bypassed = await routing.isBypassed(context.threadId);

        if (
          !bypassed &&
          provider === "claude" &&
          (await operations.isRoutingEnabled(provider)) &&
          (await api.storage.kv.get(routeKey)) === "claude" &&
          !(await canKeepOldClaudeRoute(context))
        )
          return retiredClaudeEntries(context.hostId);

        if (!bypassed && (await canServe(provider))) {
          await api.storage.kv.set(
            routeKey,
            provider === "claude" ? claudeApiKeyRoute : provider,
          );
          const token = await hubTokens.forHost(context.hostId);

          if (provider === "claude") {
            await routing.recordRouted(context.threadId, context.hostId);
          }

          return [...(await serving(token)), ...markerEntries(token)];
        }

        await api.storage.kv.delete(routeKey);

        return parentPool === null ? [] : neutralized(provider);
      };

    const proxiedHealth = async (provider: PoolProvider) =>
      (await canServe(provider))
        ? {
            label: "Proxied",
            statusMessage:
              proxyingParent() === null
                ? "Credentials are provided by the Account Pooler hub."
                : "Credentials are proxied to the parent Omnyo server's Account Pooler.",
          }
        : null;

    api.providers.experimental_contributeEnv(
      "claude-code",
      contributeFor("claude", async (token) => [
        ...legacyClaudeOverrides,
        {
          name: "ANTHROPIC_BASE_URL",
          value: { serverPath: HUB_BASE_PATH },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
        {
          name: "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
          value: "1",
          reason:
            "Claude Code otherwise refreshes this machine's own Claude login while routed, which can spend its single-use refresh token and sign it out",
        },
        {
          name: "ENABLE_TOOL_SEARCH",
          value: "true",
          reason:
            "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
        },
        {
          name: "OMNYO_CLAUDE_MODELS_URL",
          value: { serverPath: `${HUB_BASE_PATH}${CLAUDE_MODELS_ROUTE}` },
          reason:
            "Claude Code lists only its cached models behind a custom base URL; Omnyo lists the pooled accounts' models from the hub",
        },
      ]),
    );
    api.providers.experimental_contributeEnvHealth("claude-code", () =>
      proxiedHealth("claude"),
    );
    api.providers.experimental_contributeEnv(
      "codex",
      contributeFor("codex", async (token) => [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: { serverPath: `${HUB_BASE_PATH}/v1` },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
      ]),
    );
    api.providers.experimental_contributeEnvHealth("codex", () =>
      proxiedHealth("codex"),
    );
    api.providers.experimental_contributeModelNotice("codex", async () =>
      proxyingParent() === null && (await operations.isRoutingEnabled("codex"))
        ? poolModelNotice(
            (await operations.status()).accounts,
            "codex",
            hub.activeAccountId("codex"),
            currentSettings.switchThreshold,
            Date.now(),
          )
        : null,
    );
    api.onDispose(async () => {
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;

      try {
        const inspection = inspectDisableState(api, operations);

        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );

        const result = await Promise.race([inspection, timeout]);

        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          api.log.debug("Account Pooler disable inspection timed out.");

          return;
        }

        if (result !== null) api.log.warn(result);
      } catch (error) {
        api.log.debug(
          `Account Pooler disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });

    for (const [method, route] of [
      ["POST", "/v1/messages"],
      ["POST", "/v1/messages/count_tokens"],
      ["GET", CLAUDE_MODELS_ROUTE],
    ] as const) {
      api.http.route(
        method,
        route,
        (context) => hub.handle(context.req.raw, "claude", route),
        { auth: "none" },
      );
      api.http.route(
        method,
        `${CLAUDE_API_KEY_PROXY_PREFIX}${route}`,
        (context) => {
          const url = new URL(context.req.raw.url);
          url.pathname = `${HUB_BASE_PATH}${route}`;

          return hub.handle(new Request(url, context.req.raw), "claude", route);
        },
        { auth: "none" },
      );
      api.http.route(
        method,
        `${RETIRED_CLAUDE_PATH}${route}`,
        () =>
          Response.json(
            {
              type: "error",
              error: { type: "api_error", message: CLAUDE_POOL_THREAD_RETIRED },
            },
            { status: 409 },
          ),
        { auth: "none" },
      );
    }

    for (const route of [
      "/v1/responses",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/alpha/search",
    ]) {
      api.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "codex", route),
        { auth: "none" },
      );
    }

    api.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex", "/v1/models"),
      { auth: "none" },
    );
    api.http.route(
      "GET",
      AVAILABILITY_PATH,
      async (context) => {
        if ((await hub.authenticate(context.req.raw)) === null) {
          return new Response(null, { status: 401 });
        }

        return Response.json(
          poolAvailabilitySchema.parse({
            claude: await canServe("claude"),
            codex: await canServe("codex"),
          }),
          { headers: { [CLAUDE_API_KEY_PROXY_HEADER]: "1" } },
        );
      },
      { auth: "none" },
    );
    api.http.route(
      "GET",
      "/retry-availability",
      async (context) => {
        if ((await hub.authenticate(context.req.raw)) === null)
          return new Response(null, { status: 401 });

        const query = z
          .object({
            provider: routedProviderSchema,
            family: modelFamilySchema,
            model: z.string().min(1).optional(),
            serviceTier: z.string().min(1).optional(),
          })
          .safeParse(
            Object.fromEntries(new URL(context.req.raw.url).searchParams),
          );

        if (!query.success) return new Response(null, { status: 400 });

        return Response.json(
          await hub.retryAvailability(
            query.data.provider,
            query.data.family,
            query.data.model ?? null,
            query.data.serviceTier ?? null,
          ),
        );
      },
      { auth: "none" },
    );
    api.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    api.background.service("hub", {
      experimental_stopTimeoutMs:
        (options.drainTimeoutMs ?? DEFAULT_ACCOUNT_POOL_DRAIN_TIMEOUT_MS) +
        5_000,
      start: (signal) => hub.start(signal),
    });
  };
}

async function inspectDisableState(
  api: PluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await api.sdk.plugins.list();

  const disabled =
    installed.plugins.find((plugin) => plugin.id === api.pluginId)?.enabled ===
    false;

  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();

  if (warnings.length === 0) return null;

  return `Account Pooler disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run omnyo pool status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
