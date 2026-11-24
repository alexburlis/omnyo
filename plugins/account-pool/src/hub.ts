import { validatePooledWorkflowAllowance } from "./workflow-allowance.js";
import { workflowRequest, workflowResponse } from "./workflow-transport.js";
import {
  CLAUDE_WORKFLOW_UNAVAILABLE,
  WORKFLOW_SYSTEM_PROMPT,
  type PoolWorkflowInput,
} from "./workflow-contract.js";
import type { PoolTelemetry } from "./telemetry.js";
import {
  retryAvailabilitySchema,
  type RetryAvailability,
} from "./retry-contract.js";
import {
  CLAUDE_API_KEY_PROXY_PREFIX,
  HUB_TOKEN_HEADER,
  readHubHeaderV1,
} from "./parent-pool.js";
import { randomBytes, randomUUID } from "node:crypto";
import { codexRejectionRequestDiagnostic } from "./request-body.js";
import {
  observeUpstreamResponse,
  upstreamDiagnostic,
  type UpstreamDiagnostic,
  type UpstreamDiagnosticContext,
} from "./upstream-transport.js";
import { zstdDecompressSync } from "node:zlib";
import { z } from "zod";
import {
  codexResetCreditsInputSchema,
  codexRedeemResetInputSchema,
  type CodexResetCredits,
  type CodexRedeemReset,
  type CodexRedeemResetInput,
} from "./codex-reset-contract.js";
import {
  CodexResetAuthorizationError,
  fetchCodexResetCredits,
  redeemCodexReset,
  fetchCodexUsageAfterReset,
} from "./codex-resets.js";
import {
  CLAUDE_PREDICTIONS_RETIRED,
  composerPredictionConfigurationSchema,
  composerPredictionBody,
  composerPredictionTimeouts,
  type ComposerPredictionConfiguration,
} from "./prediction-contract.js";
import {
  CLAUDE_POOL_LOGIN_RETIRED,
  CLAUDE_POOL_THREAD_RETIRED,
  isLegacyClaudeAccount,
} from "./contracts.js";
import type {
  Account,
  AccountPoolConfig,
  AccountQuota,
  AccountSecret,
  ModelCatalogSummary,
  ModelFamily,
  PoolProvider,
  PoolStatus,
} from "./contracts.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  isActiveModelRejection,
  isActivePredictionRejection,
  rejectsOtherModel,
} from "./model-compatibility.js";
import {
  advertisesServiceTier,
  codexServiceTierId,
  isActiveModelCatalog,
  listsModel,
  MAX_MODEL_CATALOG_BYTES,
  mergedCatalogEtag,
  mergeModelCatalogs,
  MODEL_CATALOG_INVALIDATION_INTERVAL_MS,
  MODEL_CATALOG_LIST_WAIT_MS,
  MODEL_CATALOG_PROBE_TIMEOUT_MS,
  MODEL_CATALOG_RETRY_MS,
  parseModelCatalog,
  type ModelCatalogHeader,
} from "./model-catalog.js";
import {
  createCodexAdapter,
  DEFAULT_CODEX_REFRESH_URL,
  DEFAULT_CODEX_USAGE_URL,
} from "./codex-adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  OAuthRefreshError,
  TransientOAuthRefreshError,
} from "./provider-adapter.js";
import {
  accountStatus,
  routeRank,
  isSubscriptionRank,
  rejoinAt,
  blockingResetAt,
  governingWeeklyResetAt,
  hasExtraUsage,
  isQuotaExhausted,
  isSharedQuotaExhausted,
  isUsageRestricted,
  modelFamily,
  retryAfterMilliseconds,
} from "./quota.js";
import type {
  AccountBinding,
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
} from "./store.js";
import { parentRequestHeaders, type ParentPool } from "./parent-pool.js";

const ROUTE = "/api/v1/plugins/account-pool/http";

const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export const DEFAULT_ACCOUNT_POOL_DRAIN_TIMEOUT_MS = 60_000;

const EXHAUSTED_USAGE_REFRESH_INTERVAL_MS = 30 * 1_000;

const MAX_INLINE_HOLD_MS = 20_000;

const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000];

const MAX_REFRESH_BACKOFF_MS = 60_000;

const MAX_REFRESH_BACKOFFS = 1_024;

const UPSTREAM_REJECTION_HOLD_MS = 60_000;

const MAX_FAILURE_DETAIL_BYTES = 1_024;

const FAILURE_DISPOSAL_TIMEOUT_MS = 250;

const AFFINITY_IDLE_TTL_MS = 65 * 60 * 1_000;

const MAX_AFFINITY_BINDINGS = 4_096;

const MODEL_ROUTED_PATH = "/v1/responses";

const CODEX_MODELS_PATH = "/v1/models";

const MODELS_ETAG_HEADER = "x-models-etag";

const MAX_REMEMBERED_MODELS_ETAGS = 256;

const CATALOG_TOO_LARGE =
  "The Codex model list exceeded the Account Pooler's size limit.";

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface HubOptions {
  codexUsageUrl: string;
  telemetry?: PoolTelemetry;
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  maxAffinityBindings: number;
  hubTokens: HubTokenStore;
  getSettings: () => AccountPoolConfig;
  adapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  fetch: typeof fetch;
  now: () => number;
  drainTimeoutMs: number;
  getParentRoute: () => ParentPool | null;
  onAccountsChanged: () => void;
  onUpstreamError: (provider: PoolProvider, error: unknown) => void;
  onUpstreamDiagnostic: (
    provider: PoolProvider,
    diagnostic: UpstreamDiagnostic,
  ) => void;
  onOAuthRefresh: (
    provider: PoolProvider,
    accountId: string,
    outcome: "succeeded" | "failed",
    message: string,
  ) => void;
}

interface SelectedAccount {
  rank: number;
  account: Account;
  quota: AccountQuota;
  keepAffinity: boolean;
  markedIncompatible: boolean;
  accept: () => void;
}

interface WorkflowLease {
  input: PoolWorkflowInput;
  account: Account;
  controller: AbortController;
  used: boolean;
  revoke: () => void;
}

interface ComposerPredictionLease {
  includedOnly: boolean;
  force: boolean;
  account: Account;
  hostId: string;
  expiresAt: number;
  configuration: ComposerPredictionConfiguration;
  controller: AbortController;
  used: boolean;
  accept: () => void;
  validateSource: () => Promise<void>;
  revoke: () => void;
}

const NO_CODEX_PREDICTION_ACCOUNT =
  "Predictions require an account in Account Pooler with fresh included Codex allowance";

const COMPOSER_PREDICTIONS_NOT_ENABLED =
  "OpenAI has not enabled composer predictions for any available account";

interface ActiveAccount {
  accountId: string;
}

interface PacingFlight {
  heldUntil: number;
  result: Promise<void>;
}

interface RoutingAttempt {
  binding: AccountBinding | null;
  active: ActiveAccount | null;
  pinnedAccountId: string | null;
}

interface UpstreamResult {
  response: Response;
  controller: AbortController;
  release: () => void;
}

interface RefreshBackoff {
  kind: "proactive" | "rejected" | "upstream";
  accessToken: string;
  retryAt: number;
  delayMs: number;
  error: TransientOAuthRefreshError;
}

type SecretUse = { kind: "normal" } | { kind: "rejected"; accessToken: string };

type SecretFlight =
  | { kind: "refresh"; use: SecretUse; result: Promise<AccountSecret> }
  | { kind: "rejection-check" | "replacement"; result: Promise<void> };

interface FailureSummary {
  status: number;
  message: string;
  headers: Record<string, string>;
}

class UpstreamConnectionError extends Error {}

export class AccountPoolHub {
  private readonly workflowLeases = new Map<string, WorkflowLease>();
  private readonly composerPredictions = new Map<
    string,
    ComposerPredictionLease
  >();
  private accepting = false;
  private stopping: Promise<void> | null = null;
  private stopped = new AbortController();
  private readonly inFlightByAccount = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly refreshes = new Map<string, SecretFlight>();
  private readonly refreshBackoffs = new Map<string, RefreshBackoff>();
  private readonly pacingByAccount = new Map<string, PacingFlight>();
  private affinityBindings = new Map<string, AccountBinding>();
  private activeAccounts = new Map<PoolProvider, ActiveAccount>();
  private readonly usageRefreshes = new Map<string, Promise<void>>();
  private readonly lastUsageRefreshAt = new Map<string, number>();
  private readonly drainWaiters = new Set<() => void>();
  private readonly catalogProbes = new Map<string, Promise<void>>();
  private readonly modelsEtags = new Map<string, string>();
  private readonly catalogProbeRetryAt = new Map<string, number>();
  private readonly catalogInvalidatedAt = new Map<string, number>();

  constructor(private readonly options: HubOptions) {}

  activeAccountId(provider: PoolProvider): string | null {
    return this.activeAccounts.get(provider)?.accountId ?? null;
  }

  async hasClaudeApiKeyAffinity(
    hostId: string,
    sessionId: string,
  ): Promise<boolean> {
    const key = JSON.stringify(["claude", hostId, `session:${sessionId}`]);
    const binding = this.affinityBindings.get(key);

    if (
      !binding ||
      this.options.now() - binding.lastUsedAt >= AFFINITY_IDLE_TTL_MS
    )
      return false;
    const account = await this.options.accounts.get(binding.accountId);

    return (
      account?.provider === "claude" &&
      account.kind === "api-key" &&
      account.enabled
    );
  }

  async start(signal: AbortSignal): Promise<void> {
    this.affinityBindings = this.options.affinity.loadBindings(
      this.options.now() - AFFINITY_IDLE_TTL_MS,
      MAX_AFFINITY_BINDINGS,
    );
    this.activeAccounts = this.options.affinity.loadActiveAccounts();
    this.pacingByAccount.clear();
    this.stopped = new AbortController();
    this.stopping = null;

    if (signal.aborted) return;
    this.accepting = true;

    const abort = () => {
      void this.stop();
    };

    signal.addEventListener("abort", abort, { once: true });

    try {
      while (!signal.aborted) {
        await this.refreshUsage();
        await waitForDelay(DEFAULT_USAGE_REFRESH_INTERVAL_MS, signal);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await this.stop();
      await Promise.all(this.usageRefreshes.values());
    }
  }

  async authenticate(request: Request): Promise<string | null> {
    const header = readHubHeaderV1(request.headers);

    const token =
      header.kind === "credential"
        ? header.token
        : readBearer(request.headers.get("authorization"));

    return this.options.hubTokens.authenticate(token);
  }

  async replaceSecret(accountId: string, secret: AccountSecret): Promise<void> {
    while (true) {
      const existing = this.refreshes.get(accountId);

      if (existing !== undefined) {
        await existing.result.then(
          () => undefined,
          () => undefined,
        );
        continue;
      }

      const flight: SecretFlight = {
        kind: "replacement",
        result: this.options.accounts
          .writeSecret(accountId, secret)
          .then(async () => {
            this.refreshBackoffs.delete(accountId);
            await this.options.accounts.clearRejectedRefresh(accountId);
            const quota = this.options.quotas.get(accountId);
            this.options.quotas.put({ ...quota, error: null });
            this.options.quotas.clearModelRejections(accountId);
            this.options.quotas.clearPredictionRejection(accountId);
            this.options.quotas.clearModelCatalog(accountId);
            this.catalogProbeRetryAt.delete(accountId);
          })
          .finally(() => {
            if (this.refreshes.get(accountId) === flight)
              this.refreshes.delete(accountId);
          }),
      };

      this.refreshes.set(accountId, flight);

      return flight.result;
    }
  }

  async handle(
    request: Request,
    provider: PoolProvider,
    routePath: string,
  ): Promise<Response> {
    const adapter = this.adapter(provider);

    const workflowCapability = request.headers.get("x-omnyo-workflow-token");

    if (workflowCapability !== null) {
      if (provider === "claude")
        return adapter.errorResponse(403, CLAUDE_WORKFLOW_UNAVAILABLE);

      if (request.method !== "POST" || routePath !== "/v1/responses")
        return adapter.errorResponse(
          403,
          "Workflow capabilities only allow text inference.",
        );

      return this.forwardWorkflow(request, workflowCapability, provider);
    }

    const predictionCapability = request.headers.get(
      "x-omnyo-composer-prediction-token",
    );

    if (predictionCapability !== null && provider === "claude")
      return adapter.errorResponse(403, CLAUDE_PREDICTIONS_RETIRED);

    if (predictionCapability !== null) {
      if (
        provider !== "codex" ||
        routePath !== "/v1/responses" ||
        request.method !== "POST"
      )
        return adapter.errorResponse(
          403,
          "Prediction capabilities only allow the Responses route.",
        );

      return this.forwardComposerPrediction(request, predictionCapability);
    }

    const hostId = await this.authenticate(request);

    if (hostId === null) {
      return adapter.errorResponse(401, "Invalid Account Pooler bearer token.");
    }

    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Account Pooler is not accepting requests.",
      );
    const parent = this.options.getParentRoute();

    if (parent !== null) {
      return this.forwardToParent(request, adapter, routePath, parent);
    }

    if (
      provider === "codex" &&
      routePath === CODEX_MODELS_PATH &&
      request.method === "GET"
    )
      return this.listCodexModels(request, adapter, hostId);

    return this.forward(
      request,
      new Uint8Array(await request.arrayBuffer()),
      adapter,
      hostId,
      routePath,
    );
  }

  private async listCodexModels(
    request: Request,
    adapter: ProviderAdapter,
    hostId: string,
  ): Promise<Response> {
    const served: { account: Account | null } = { account: null };

    const response = await this.forward(
      request,
      new Uint8Array(),
      adapter,
      hostId,
      CODEX_MODELS_PATH,
      (account) => {
        served.account = account;
      },
    );

    const account = served.account;

    if (account === null || !response.ok) return response;

    const signal = AbortSignal.any([request.signal, this.stopped.signal]);
    let text: string | null;

    try {
      text = await readCatalogText(response, signal);
    } catch (error) {
      if (!signal.aborted) throw error;

      return adapter.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
      );
    }

    if (text === null) return adapter.errorResponse(502, CATALOG_TOO_LARGE);

    const headers = new Headers(response.headers);
    const body = text;

    const reply = (content: string) =>
      new Response(content, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });

    const parsed = parseModelCatalog(body);

    if (parsed === null) return reply(body);

    const clientVersion = new URL(request.url).searchParams.get(
      "client_version",
    );

    const baseEtag = response.headers.get("etag");

    const previous = this.options.quotas.modelCatalog(
      account.id,
      clientVersion,
    );

    const changed =
      previous === null ||
      previous.etag !== baseEtag ||
      previous.models.map(({ slug }) => slug).join("\n") !==
        parsed.models.map(({ slug }) => slug).join("\n");

    this.options.quotas.replaceModelCatalog({
      accountId: account.id,
      plan: account.subscriptionType,
      clientVersion,
      etag: baseEtag,
      fetchedAt: this.options.now(),
      models: parsed.models,
    });

    const others = (await this.options.accounts.listRoutable())
      .filter(
        (other) =>
          other.provider === "codex" &&
          other.enabled &&
          other.id !== account.id,
      )
      .sort((left, right) => left.priority - right.priority);

    await this.probeModelCatalogs(
      others,
      request,
      adapter,
      clientVersion,
      changed,
    );

    const now = this.options.now();
    const current = await this.options.accounts.listRoutable();

    const catalogs = others.flatMap((other) => {
      const latest = current.find((candidate) => candidate.id === other.id);
      const catalog = this.options.quotas.modelCatalog(other.id, clientVersion);

      return latest !== undefined &&
        latest.enabled &&
        this.options.quotas.get(latest.id).error === null &&
        catalog !== null &&
        isActiveModelCatalog(latest, catalog, now)
        ? [catalog]
        : [];
    });

    const merged = mergeModelCatalogs(parsed, catalogs);
    const contributing = [baseEtag, ...catalogs.map(({ etag }) => etag)];

    if (!merged.changed) {
      if (baseEtag !== null) this.rememberModelsEtag(contributing, baseEtag);

      return reply(body);
    }

    const etag = mergedCatalogEtag(merged.text);
    this.rememberModelsEtag(contributing, etag);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    headers.set("etag", etag);

    return reply(merged.text);
  }

  private modelCatalogSummary(
    account: Account,
    now: number,
  ): ModelCatalogSummary | null {
    const header = this.options.quotas.latestModelCatalogHeader(account.id);

    const catalog =
      header === null
        ? null
        : this.options.quotas.modelCatalog(account.id, header.clientVersion);

    if (catalog === null || !isActiveModelCatalog(account, catalog, now))
      return null;

    return {
      plan: catalog.plan,
      clientVersion: catalog.clientVersion,
      fetchedAt: catalog.fetchedAt,
      models: catalog.models.filter(listsModel).map(({ slug }) => slug),
    };
  }

  private noteModelsEtag(account: Account, etag: string | null): void {
    if (etag === null || this.modelsEtags.has(etag)) return;
    const headers = this.options.quotas.modelCatalogHeadersFor(account.id);

    if (
      !headers.some((header) => header.etag !== null) ||
      headers.some((header) => header.etag === etag)
    )
      return;

    const now = this.options.now();
    const invalidatedAt = this.catalogInvalidatedAt.get(account.id);

    if (
      invalidatedAt !== undefined &&
      now - invalidatedAt < MODEL_CATALOG_INVALIDATION_INTERVAL_MS
    )
      return;

    this.catalogInvalidatedAt.set(account.id, now);
    this.catalogProbeRetryAt.delete(account.id);
    this.options.quotas.clearModelCatalog(account.id);
    this.options.onAccountsChanged();
  }

  private rememberModelsEtag(
    upstream: ReadonlyArray<string | null>,
    merged: string,
  ): void {
    if (this.modelsEtags.size > MAX_REMEMBERED_MODELS_ETAGS)
      this.modelsEtags.clear();

    for (const etag of upstream) {
      if (etag === null) continue;

      if (etag === merged) this.modelsEtags.delete(etag);
      else this.modelsEtags.set(etag, merged);
    }
  }

  private async probeModelCatalogs(
    accounts: readonly Account[],
    request: Request,
    adapter: ProviderAdapter,
    clientVersion: string | null,
    force: boolean,
  ): Promise<void> {
    const now = this.options.now();

    const stale = accounts.filter((account) => {
      const catalog = this.options.quotas.modelCatalogHeader(
        account.id,
        clientVersion,
      );

      return (
        this.options.quotas.get(account.id).error === null &&
        (this.catalogProbeRetryAt.get(account.id) ?? 0) <= now &&
        (force ||
          catalog === null ||
          !isActiveModelCatalog(account, catalog, now))
      );
    });

    if (stale.length === 0) return;

    const probes = Promise.all(
      stale.map((account) => {
        const existing = this.catalogProbes.get(account.id);

        if (existing !== undefined) return existing;

        const probe = this.probeModelCatalog(account, request, adapter).finally(
          () => {
            if (this.catalogProbes.get(account.id) === probe)
              this.catalogProbes.delete(account.id);
          },
        );

        this.catalogProbes.set(account.id, probe);

        return probe;
      }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;

    await Promise.race([
      probes,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MODEL_CATALOG_LIST_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private async probeModelCatalog(
    account: Account,
    request: Request,
    adapter: ProviderAdapter,
  ): Promise<void> {
    const signal = AbortSignal.any([
      this.stopped.signal,
      AbortSignal.timeout(MODEL_CATALOG_PROBE_TIMEOUT_MS),
    ]);

    const url = adapter.upstreamUrl(request, this.options.getSettings());

    const retryLater = () =>
      this.catalogProbeRetryAt.set(
        account.id,
        this.options.now() + MODEL_CATALOG_RETRY_MS,
      );

    try {
      let credential = await abortable(
        this.freshSecret(account, adapter, { kind: "normal" }),
        signal,
      );

      for (const retry of [false, true]) {
        const probe = new Request(url, { signal });
        const tracked = this.trackRequest(probe);

        try {
          const response = await this.options.fetch(probe.url, {
            headers: adapter.requestHeaders(
              request.headers,
              account,
              credential,
            ),
            signal: tracked.controller.signal,
          });

          if (
            (response.status === 401 || response.status === 403) &&
            !retry &&
            credential.kind === "oauth"
          ) {
            await response.body?.cancel().catch(() => undefined);
            const accessToken = credential.accessToken;
            credential = await abortable(
              this.freshSecret(account, adapter, {
                kind: "rejected",
                accessToken,
              }),
              signal,
            );
            continue;
          }

          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            retryLater();

            return;
          }

          const text = await readCatalogText(response, signal);
          const parsed = text === null ? null : parseModelCatalog(text);

          const latest = (await this.options.accounts.listRoutable()).find(
            (candidate) => candidate.id === account.id,
          );

          if (parsed === null || latest === undefined) {
            retryLater();

            return;
          }

          this.catalogProbeRetryAt.delete(account.id);
          this.options.quotas.replaceModelCatalog({
            accountId: account.id,
            plan: latest.subscriptionType,
            clientVersion: url.searchParams.get("client_version"),
            etag: response.headers.get("etag"),
            fetchedAt: this.options.now(),
            models: parsed.models,
          });
          this.options.onAccountsChanged();

          return;
        } finally {
          tracked.release();
        }
      }
    } catch (error) {
      retryLater();

      if (!this.stopped.signal.aborted)
        this.options.onUpstreamError(adapter.provider, error);
    }
  }

  private includedWorkflowQuota(account: Account): boolean {
    const quota = this.options.quotas.get(account.id);
    const now = this.options.now();

    if (
      quota.extraUsage?.status !== "rejected" ||
      quota.extraUsage.observedAt > now ||
      now - quota.extraUsage.observedAt > 60_000
    )
      return false;

    return account.provider === "codex" && this.includedComposerQuota(account);
  }

  private async verifyWorkflowAllowance(
    account: Account,
    signal: AbortSignal,
    secret?: AccountSecret,
  ): Promise<void> {
    const adapter = this.adapter(account.provider);

    const credential =
      secret ??
      (await abortable(
        this.freshSecret(account, adapter, { kind: "normal" }),
        signal,
      ));

    if (account.kind !== "oauth" || credential.kind !== "oauth")
      throw new Error("Workflow inference requires an included subscription.");

    const response = await this.options.fetch(this.options.codexUsageUrl, {
      headers: adapter.requestHeaders(
        new Headers({ accept: "application/json" }),
        account,
        credential,
      ),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Workflow allowance could not be verified.");
    }

    validatePooledWorkflowAllowance(
      await response.json(),
      account,
      this.options.now(),
    );
  }

  async hasWorkflowAccounts(provider: PoolProvider): Promise<boolean> {
    if (provider === "claude") return false;

    return (await this.options.accounts.listRoutable()).some(
      (account) => account.provider === provider,
    );
  }

  async workflowAccount(
    provider: PoolProvider,
    signal: AbortSignal,
  ): Promise<Account> {
    if (provider === "claude") throw new Error(CLAUDE_WORKFLOW_UNAVAILABLE);

    if (!this.accepting || this.options.getParentRoute() !== null)
      throw new Error(
        "Workflow inference requires the local Account Pooler owner.",
      );

    const accounts = (await this.options.accounts.listRoutable()).filter(
      (account) =>
        account.provider === provider &&
        account.kind === "oauth" &&
        account.enabled,
    );

    await abortable(
      Promise.all(
        accounts.map((account) => this.refreshAccountUsage(account, 0)),
      ),
      signal,
    );
    const current = await this.options.accounts.listRoutable();

    const account = current
      .filter(
        (account) =>
          account.provider === provider && this.includedWorkflowQuota(account),
      )
      .sort((a, b) => a.priority - b.priority)[0];

    if (account === undefined)
      throw new Error(
        "Workflow inference needs fresh included subscription allowance with extra usage disabled.",
      );

    await this.verifyWorkflowAllowance(account, signal);

    return account;
  }

  async prepareWorkflow(
    input: PoolWorkflowInput,
    signal: AbortSignal,
  ): Promise<{ capability: string; revoke: () => void }> {
    const provider = input.providerId === "codex" ? "codex" : "claude";
    const account = await this.workflowAccount(provider, signal);
    signal.throwIfAborted();

    if (this.workflowLeases.size >= 16)
      throw new Error("Workflow inference capacity is full.");
    const capability = randomBytes(32).toString("base64url");
    const controller = new AbortController();

    const revoke = () => {
      controller.abort();
      this.workflowLeases.delete(capability);
      signal.removeEventListener("abort", revoke);
      clearTimeout(timer);
    };

    const timer = setTimeout(revoke, input.timeoutMs);
    timer.unref();
    this.workflowLeases.set(capability, {
      input,
      account,
      controller,
      used: false,
      revoke,
    });
    signal.addEventListener("abort", revoke, { once: true });

    if (signal.aborted) revoke();

    return { capability, revoke };
  }

  private async forwardWorkflow(
    request: Request,
    capability: string,
    provider: PoolProvider,
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    const lease = this.workflowLeases.get(capability);

    if (
      !this.accepting ||
      lease === undefined ||
      lease.controller.signal.aborted ||
      (lease.input.providerId === "codex" ? "codex" : "claude") !== provider
    )
      return adapter.errorResponse(401, "Workflow capability is unavailable.");

    if (lease.used)
      return adapter.errorResponse(
        409,
        "Workflow capability was already used.",
      );
    lease.used = true;

    const signal = AbortSignal.any([
      request.signal,
      lease.controller.signal,
      this.stopped.signal,
    ]);

    try {
      const account = (await this.options.accounts.listRoutable()).find(
        (account) => account.id === lease.account.id,
      );

      if (account === undefined || !this.includedWorkflowQuota(account))
        return adapter.errorResponse(
          429,
          "Included subscription allowance is unavailable.",
        );

      const secret = await abortable(
        this.freshSecret(account, adapter, { kind: "normal" }),
        signal,
      );

      signal.throwIfAborted();

      const currentAccount = (await this.options.accounts.listRoutable()).find(
        (current) => current.id === account.id,
      );

      if (
        currentAccount === undefined ||
        secret.kind !== "oauth" ||
        !this.includedWorkflowQuota(currentAccount)
      )
        return adapter.errorResponse(
          429,
          "Included subscription allowance changed.",
        );
      await this.verifyWorkflowAllowance(currentAccount, signal, secret);
      const raw = await workflowRequest(request, lease.input);
      const headers = new Headers(request.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("x-omnyo-workflow-token");

      const upstream = await this.fetchUpstream(
        new Request(request.url, {
          method: "POST",
          body: raw,
          headers,
          signal,
        }),
        raw,
        currentAccount,
        secret,
        adapter,
      );

      this.options.quotas.put(
        adapter.quotaFromHeaders(
          account.id,
          upstream.response.headers,
          this.options.quotas.get(account.id),
          modelFamily(lease.input.model),
          this.options.now(),
        ),
      );

      if (!upstream.response.ok || signal.aborted) {
        const status = signal.aborted ? 499 : upstream.response.status;
        await this.discardUpstream(upstream, false);

        return adapter.errorResponse(
          status,
          "Workflow provider did not accept the text request.",
        );
      }

      try {
        upstream.response = await workflowResponse(
          upstream.response,
          lease.input,
          signal,
        );
      } catch (error) {
        await this.discardUpstream(upstream, false);
        throw error;
      }

      const changed = await this.options.accounts.recordUsed(
        account.id,
        this.options.now(),
        lease.input.hostId,
      );

      if (changed) this.options.onAccountsChanged();

      return this.clientResponse(upstream);
    } catch {
      return adapter.errorResponse(
        signal.aborted ? 499 : 502,
        "Workflow text inference failed.",
      );
    }
  }

  private includedComposerQuota(account: Account): boolean {
    const now = this.options.now();
    const quota = this.options.quotas.get(account.id);
    const threshold = this.options.getSettings().switchThreshold;

    return (
      account.enabled &&
      account.provider === "codex" &&
      account.kind === "oauth" &&
      account.codexAccountId !== undefined &&
      quota.error === null &&
      !isUsageRestricted(quota, now) &&
      quota.observedAt !== null &&
      now - quota.observedAt <= 60000 &&
      quota.limitWindows.length > 0 &&
      quota.limitWindows.every(
        (window) =>
          window.utilization !== null &&
          window.utilization < threshold &&
          window.status === "allowed" &&
          window.resetAt !== null &&
          window.resetAt > now &&
          now - window.observedAt <= 60000,
      ) &&
      !isSharedQuotaExhausted(quota, threshold, now) &&
      (quota.heldUntil === null || quota.heldUntil <= now)
    );
  }

  private prepaidComposerQuota(account: Account): boolean {
    const now = this.options.now();
    const quota = this.options.quotas.get(account.id);
    const credits = quota.extraUsage;

    return (
      this.options.getSettings().composerPredictionAllowance ===
        "included-or-prepaid-credits" &&
      account.enabled &&
      account.provider === "codex" &&
      account.kind === "oauth" &&
      account.codexAccountId !== undefined &&
      quota.error === null &&
      !isUsageRestricted(quota, now) &&
      quota.observedAt !== null &&
      quota.observedAt <= now &&
      now - quota.observedAt <= 60000 &&
      credits?.status === "allowed" &&
      credits.hasCredits === true &&
      credits.unlimited === false &&
      credits.observedAt <= now &&
      now - credits.observedAt <= 60000 &&
      (quota.heldUntil === null || quota.heldUntil <= now)
    );
  }

  private availableComposerQuota(account: Account): boolean {
    return (
      this.includedComposerQuota(account) || this.prepaidComposerQuota(account)
    );
  }

  private unavailableComposerQuotaMessage(includedOnly = false): string {
    if (includedOnly)
      return "Predictions require fresh included Codex allowance";

    return this.options.getSettings().composerPredictionAllowance ===
      "included-or-prepaid-credits"
      ? "Predictions require fresh included Codex allowance or finite prepaid credits"
      : "Predictions require fresh included Codex allowance";
  }

  async prepareComposerPrediction(
    hostId: string,
    nativeThreadId: string,
    requestSignal: AbortSignal,
    validateSource: () => Promise<void>,
    includedOnly = false,
    force = false,
  ): Promise<{
    capability: string;
    configuration: ComposerPredictionConfiguration;
    revoke: () => void;
  }> {
    const signal = AbortSignal.any([requestSignal, this.stopped.signal]);
    signal.throwIfAborted();

    if (!this.accepting)
      throw new Error("Account Pooler is not accepting requests");

    if (this.options.getParentRoute() !== null)
      throw new Error(
        "Composer predictions require a local Account Pooler owner; parent proxy predictions are unavailable",
      );

    for (const lease of this.composerPredictions.values())
      if (lease.expiresAt <= this.options.now()) lease.revoke();

    if (this.composerPredictions.size >= 32)
      throw new Error("Account Pooler prediction capacity is full");

    const predictionAccount = (account: Account) =>
      account.provider === "codex" &&
      account.kind === "oauth" &&
      account.enabled;

    await abortable(
      Promise.all(
        (await this.options.accounts.listRoutable())
          .filter(predictionAccount)
          .map((account) => this.refreshAccountUsage(account, 0)),
      ),
      signal,
    );

    const pooled = await this.options.accounts.listRoutable();

    if (pooled.length === 0) throw new Error(NO_CODEX_PREDICTION_ACCOUNT);

    const accounts = pooled.filter(predictionAccount);

    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
    };

    const attempted = new Set<string>();
    let previousAccountId: string | null = null;
    let selected: SelectedAccount | undefined;
    let configuration: ComposerPredictionConfiguration | undefined;

    while (selected === undefined || configuration === undefined) {
      signal.throwIfAborted();

      const disabled = new Set(
        accounts
          .filter((account) => this.composerPredictionsDisabled(account))
          .map((account) => account.id),
      );

      const eligible = accounts.filter(
        (account) => !disabled.has(account.id) && !attempted.has(account.id),
      );

      const included = eligible.filter((account) =>
        this.includedComposerQuota(account),
      );

      const candidates = new Set(
        (included.length > 0
          ? included
          : eligible.filter(
              (account) => !includedOnly && this.prepaidComposerQuota(account),
            )
        ).map((account) => account.id),
      );

      const candidate: SelectedAccount | null =
        candidates.size === 0
          ? null
          : await this.select(
              "codex",
              candidates,
              new Set(),
              "other",
              null,
              JSON.stringify(["codex", hostId, `session:${nativeThreadId}`]),
              null,
              previousAccountId,
              routing,
              signal,
            );

      if (candidate === null)
        throw new Error(
          candidates.size === 0 &&
            accounts.some(
              (account) =>
                disabled.has(account.id) &&
                (includedOnly
                  ? this.includedComposerQuota(account)
                  : this.availableComposerQuota(account)),
            )
            ? COMPOSER_PREDICTIONS_NOT_ENABLED
            : this.unavailableComposerQuotaMessage(includedOnly),
        );

      previousAccountId = candidate.account.id;
      attempted.add(candidate.account.id);

      const candidateConfiguration = await this.composerPredictionConfiguration(
        candidate.account,
        includedOnly,
        signal,
      );

      signal.throwIfAborted();

      if (
        candidateConfiguration === null ||
        !candidateConfiguration.is_enabled
      ) {
        this.recordPredictionRejection(candidate.account);
        continue;
      }

      this.clearPredictionRejection(candidate.account);
      selected = candidate;
      configuration = candidateConfiguration;
    }

    if (this.composerPredictions.size >= 32)
      throw new Error("Account Pooler prediction capacity is full");
    const capability = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    const revoke = () => {
      controller.abort();
      this.composerPredictions.delete(capability);
      signal.removeEventListener("abort", revoke);
      clearTimeout(timer);
    };

    const lease: ComposerPredictionLease = {
      includedOnly,
      force,
      account: selected.account,
      hostId,
      expiresAt: this.options.now() + composerPredictionTimeouts.operationMs,
      configuration,
      controller,
      used: false,
      accept: selected.accept,
      validateSource,
      revoke,
    };

    this.composerPredictions.set(capability, lease);
    timer = setTimeout(revoke, composerPredictionTimeouts.operationMs);
    timer.unref();
    signal.addEventListener("abort", revoke, { once: true });

    if (signal.aborted) revoke();

    return { capability, configuration, revoke };
  }

  private async composerPredictionConfiguration(
    account: Account,
    includedOnly: boolean,
    signal: AbortSignal,
  ): Promise<ComposerPredictionConfiguration | null> {
    const adapter = this.adapter("codex");

    let credential = await abortable(
      this.freshSecret(account, adapter, { kind: "normal" }),
      signal,
    );

    for (const retry of [false, true]) {
      signal.throwIfAborted();

      const currentAccount = (await this.options.accounts.listRoutable()).find(
        (current) => current.id === account.id,
      );

      if (
        currentAccount === undefined ||
        !(includedOnly
          ? this.includedComposerQuota(currentAccount)
          : this.availableComposerQuota(currentAccount))
      )
        throw new Error(this.unavailableComposerQuotaMessage(includedOnly));

      const configRequest = new Request(
        "https://chatgpt.com/backend-api/wham/predictions/config",
        { signal },
      );

      this.increment(account.id);

      const tracked = this.trackRequest(configRequest, () =>
        this.decrement(account.id),
      );

      let response: Response | undefined;

      try {
        response = await this.options.fetch(configRequest.url, {
          headers: adapter.requestHeaders(
            new Headers({ accept: "application/json", originator: "bb" }),
            account,
            credential,
          ),
          signal: tracked.controller.signal,
        });

        if (
          (response.status === 401 || response.status === 403) &&
          !retry &&
          credential.kind === "oauth"
        ) {
          await response.body?.cancel();
          credential = await abortable(
            this.freshSecret(account, adapter, {
              kind: "rejected",
              accessToken: credential.accessToken,
            }),
            signal,
          );
          continue;
        }

        if (response.status === 404) return null;

        if (!response.ok)
          throw new Error(
            `OpenAI prediction configuration failed (HTTP ${response.status})`,
          );

        const parsed = composerPredictionConfigurationSchema.safeParse(
          await abortable(response.json(), signal),
        );

        if (!parsed.success)
          throw new Error(
            "OpenAI returned an invalid prediction configuration",
          );

        return parsed.data;
      } catch (error) {
        if (signal.aborted) throw new Error("Prediction canceled");

        if (error instanceof Error && /^(OpenAI|Included)/u.test(error.message))
          throw error;
        throw new Error("Could not read OpenAI prediction configuration");
      } finally {
        await response?.body?.cancel().catch(() => undefined);
        tracked.release();
      }
    }

    throw new Error("OpenAI prediction configuration is unavailable");
  }

  private composerPredictionsDisabled(account: Account): boolean {
    return isActivePredictionRejection(
      account,
      this.options.quotas.predictionRejection(account.id),
      this.options.now(),
    );
  }

  private recordPredictionRejection(account: Account): void {
    this.options.quotas.recordPredictionRejection({
      accountId: account.id,
      plan: account.subscriptionType,
      observedAt: this.options.now(),
    });
    this.options.onAccountsChanged();
  }

  private clearPredictionRejection(account: Account): void {
    if (this.options.quotas.predictionRejection(account.id) === null) return;
    this.options.quotas.clearPredictionRejection(account.id);
    this.options.onAccountsChanged();
  }

  private async forwardComposerPrediction(
    request: Request,
    capability: string,
  ): Promise<Response> {
    const adapter = this.adapter("codex");
    const lease = this.composerPredictions.get(capability);

    if (
      !this.accepting ||
      lease === undefined ||
      lease.expiresAt <= this.options.now() ||
      lease.controller.signal.aborted
    )
      return adapter.errorResponse(401, "Prediction capability is unavailable");

    if (lease.used)
      return adapter.errorResponse(
        409,
        "Prediction capability was already used",
      );
    lease.used = true;

    const signal = AbortSignal.any([
      request.signal,
      lease.controller.signal,
      this.stopped.signal,
    ]);

    try {
      const account = (await this.options.accounts.listRoutable()).find(
        (account) => account.id === lease.account.id,
      );

      if (
        account === undefined ||
        !(lease.includedOnly
          ? this.includedComposerQuota(account)
          : this.availableComposerQuota(account))
      )
        return adapter.errorResponse(
          429,
          this.unavailableComposerQuotaMessage(lease.includedOnly),
        );

      const encoding = request.headers
        .get("content-encoding")
        ?.trim()
        .toLowerCase();

      if (
        encoding !== undefined &&
        encoding !== "identity" &&
        encoding !== "zstd"
      )
        return adapter.errorResponse(
          415,
          "Unsupported prediction request encoding",
        );
      const parsedBody = await request.arrayBuffer();

      if (parsedBody.byteLength > 32 * 1024 * 1024)
        return adapter.errorResponse(413, "Prediction request is too large");

      let value: z.output<z.ZodJSONSchema>;

      try {
        const decodedBody =
          encoding === "zstd"
            ? zstdDecompressSync(new Uint8Array(parsedBody), {
                maxOutputLength: 32 * 1024 * 1024,
              })
            : new Uint8Array(parsedBody);

        value = z
          .json()
          .parse(JSON.parse(new TextDecoder().decode(decodedBody)));
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ERR_BUFFER_TOO_LARGE"
        )
          return adapter.errorResponse(413, "Prediction request is too large");

        return adapter.errorResponse(400, "Invalid prediction payload");
      }

      const prediction = composerPredictionBody(
        value,
        lease.configuration,
        lease.force,
      );

      if (prediction.body === null)
        return adapter.errorResponse(
          400,
          `Prediction payload must use the provider prediction prompt and supported function declarations (reason=${prediction.rejection})`,
        );

      const body = new TextEncoder().encode(JSON.stringify(prediction.body));

      const secret = await abortable(
        this.freshSecret(account, adapter, { kind: "normal" }),
        signal,
      );

      signal.throwIfAborted();
      await abortable(lease.validateSource(), signal);
      signal.throwIfAborted();

      const currentAccount = (await this.options.accounts.listRoutable()).find(
        (current) => current.id === account.id,
      );

      if (
        currentAccount === undefined ||
        !(lease.includedOnly
          ? this.includedComposerQuota(currentAccount)
          : this.availableComposerQuota(currentAccount))
      )
        return adapter.errorResponse(
          429,
          this.unavailableComposerQuotaMessage(lease.includedOnly),
        );

      const headers = new Headers(request.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");

      const bounded = new Request(request.url, {
        method: "POST",
        headers,
        body,
        signal,
      });

      const upstream = await this.fetchUpstream(
        bounded,
        body,
        account,
        secret,
        adapter,
      );

      this.options.quotas.put(
        adapter.quotaFromHeaders(
          account.id,
          upstream.response.headers,
          this.options.quotas.get(account.id),
          "other",
          this.options.now(),
        ),
      );

      if (!upstream.response.ok) {
        const status = upstream.response.status;
        await this.discardUpstream(upstream, false);

        return adapter.errorResponse(
          status,
          `OpenAI prediction inference failed (HTTP ${status})`,
        );
      }

      if (signal.aborted) {
        await this.discardUpstream(upstream, false);
        throw new Error("Prediction canceled");
      }

      lease.accept();

      const changed = await this.options.accounts.recordUsed(
        account.id,
        this.options.now(),
        lease.hostId,
      );

      if (changed) this.options.onAccountsChanged();

      return this.clientResponse(upstream);
    } catch {
      return adapter.errorResponse(
        signal.aborted ? 499 : 502,
        signal.aborted
          ? "Prediction canceled"
          : "Could not reach OpenAI prediction inference",
      );
    }
  }

  private trackRequest(
    request: Request,
    onRelease?: () => void,
  ): { controller: AbortController; release: () => void } {
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    this.activeControllers.add(controller);

    if (request.signal.aborted) abortFromRequest();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    let released = false;

    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        request.signal.removeEventListener("abort", abortFromRequest);
        this.activeControllers.delete(controller);
        onRelease?.();
      },
    };
  }

  private async forwardToParent(
    request: Request,
    adapter: ProviderAdapter,
    routePath: string,
    parent: ParentPool,
  ): Promise<Response> {
    const { controller, release } = this.trackRequest(request);

    try {
      const search = new URL(request.url).search;

      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();

      const context = this.upstreamContext(request, "parent");

      const path =
        adapter.provider === "claude"
          ? `${CLAUDE_API_KEY_PROXY_PREFIX}${routePath}`
          : routePath;

      const response = await this.options
        .fetch(`${parent.baseUrl}${path}${search}`, {
          method: request.method,
          headers: parentRequestHeaders(request.headers, parent.token),
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            this.options.onUpstreamError(adapter.provider, cause);
            this.options.onUpstreamDiagnostic(
              adapter.provider,
              upstreamDiagnostic(context, cause),
            );
          }

          throw new UpstreamConnectionError("Parent pool unreachable.", {
            cause,
          });
        });

      return this.clientResponse({
        response: observeUpstreamResponse(response, context, (diagnostic) =>
          this.options.onUpstreamDiagnostic(adapter.provider, diagnostic),
        ),
        controller,
        release,
      });
    } catch (error) {
      release();

      if (request.signal.aborted)
        return adapter.errorResponse(
          499,
          "Account Pooler request was canceled.",
        );

      if (error instanceof UpstreamConnectionError)
        return adapter.errorResponse(
          502,
          "Account Pooler could not reach the parent pool.",
        );
      throw error;
    }
  }

  async refreshUsage(accountId?: string, force = false): Promise<void> {
    const accounts = (await this.options.accounts.listRoutable()).filter(
      (account) =>
        account.enabled &&
        account.kind === "oauth" &&
        (accountId === undefined || account.id === accountId),
    );

    await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(
          account,
          force ? 0 : DEFAULT_USAGE_REFRESH_INTERVAL_MS,
          force,
        ),
      ),
    );
  }

  private async withCodexResetAccount<T>(
    accountId: string,
    work: (
      account: Account,
      oauth: Extract<AccountSecret, { kind: "oauth" }>,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    const account = await this.options.accounts.get(accountId);

    if (
      account === null ||
      !account.enabled ||
      account.provider !== "codex" ||
      account.kind !== "oauth" ||
      !account.codexAccountId
    )
      throw new Error("Choose an enabled Codex OAuth account for resets.");

    const signal = AbortSignal.any([
      this.stopped.signal,
      AbortSignal.timeout(20000),
    ]);

    const adapter = this.adapter("codex");

    const validate = async () => {
      signal.throwIfAborted();
      const current = await this.options.accounts.get(accountId);

      if (
        current === null ||
        !current.enabled ||
        current.provider !== "codex" ||
        current.kind !== "oauth" ||
        current.codexAccountId !== account.codexAccountId
      )
        throw new Error("Choose an enabled Codex OAuth account for resets.");
    };

    const loadLogin = (use: SecretUse = { kind: "normal" }) =>
      this.freshSecret(account, adapter, use).catch(() => {
        throw new Error(
          "Codex login is unavailable; refresh this account's login before retrying resets.",
        );
      });

    let oauth = await loadLogin();

    if (oauth.kind !== "oauth")
      throw new Error("Choose an enabled Codex OAuth account for resets.");
    await validate();

    try {
      return await work(account, oauth, signal);
    } catch (error) {
      if (!(error instanceof CodexResetAuthorizationError)) throw error;
      oauth = await loadLogin({
        kind: "rejected",
        accessToken: oauth.accessToken,
      });

      if (oauth.kind !== "oauth")
        throw new Error("Choose an enabled Codex OAuth account for resets.");
      await validate();

      return work(account, oauth, signal);
    }
  }

  async codexResetCredits(accountId: string): Promise<CodexResetCredits> {
    const input = codexResetCreditsInputSchema.parse({ accountId });

    return this.withCodexResetAccount(
      input.accountId,
      (account, oauth, signal) =>
        fetchCodexResetCredits(
          this.options.fetch,
          account,
          oauth,
          signal,
          this.options.now(),
        ),
    );
  }

  async codexRedeemReset(
    input: CodexRedeemResetInput,
  ): Promise<CodexRedeemReset> {
    const parsed = codexRedeemResetInputSchema.parse(input);

    const code = await this.withCodexResetAccount(
      parsed.accountId,
      (account, oauth, signal) =>
        redeemCodexReset(this.options.fetch, account, oauth, signal, parsed),
    );

    let usageRefreshError: string | null = null;

    if (code === "reset" || code === "already_redeemed") {
      try {
        const quota = await this.withCodexResetAccount(
          parsed.accountId,
          (account, oauth, signal) =>
            fetchCodexUsageAfterReset(
              this.options.fetch,
              account,
              oauth,
              signal,
              this.options.quotas.get(account.id),
              this.options.now(),
            ),
        );

        this.options.quotas.put(quota);
      } catch {
        usageRefreshError =
          "Reset acknowledged; account usage could not be refreshed.";
      }

      this.options.onAccountsChanged();
    }

    return { accountId: parsed.accountId, code, usageRefreshError };
  }

  private async refreshExhaustedUsage(
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
  ): Promise<void> {
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;

    const accounts = (await this.options.accounts.listRoutable()).filter(
      (account) => {
        if (
          !candidateIds.has(account.id) ||
          attempted.has(account.id) ||
          !account.enabled ||
          account.kind !== "oauth"
        )
          return false;
        const quota = this.options.quotas.get(account.id);

        return (
          quota.error === null &&
          isQuotaExhausted(quota, family, threshold, now)
        );
      },
    );

    await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(account, EXHAUSTED_USAGE_REFRESH_INTERVAL_MS),
      ),
    );
  }

  private async refreshAccountUsage(
    account: Account,
    minIntervalMs: number,
    recoverError = false,
  ): Promise<void> {
    const adapter = this.adapter(account.provider);
    const running = this.usageRefreshes.get(account.id);

    if (running !== undefined) return running;
    const now = this.options.now();
    const last = this.lastUsageRefreshAt.get(account.id);

    if (last !== undefined && now - last < minIntervalMs) return;
    this.lastUsageRefreshAt.set(account.id, now);

    const recover =
      recoverError && this.options.quotas.get(account.id).error !== null;

    const refresh = adapter
      .refreshUsage({
        signal: this.stopped.signal,
        account,
        freshSecret: () =>
          this.freshSecret(account, adapter, { kind: "normal" }, recover).catch(
            (error: unknown) => {
              if (
                !(error instanceof TransientOAuthRefreshError) &&
                (recover || error instanceof OAuthRefreshError)
              )
                this.setError(account.id, errorMessage(error));
              throw error;
            },
          ),
        accounts: this.options.accounts,
        quotas: this.options.quotas,
        fetch: this.options.fetch,
        now: this.options.now,
      })
      .catch(() => undefined)
      .finally(() => this.usageRefreshes.delete(account.id));

    this.usageRefreshes.set(account.id, refresh);

    return refresh;
  }

  stop(): Promise<void> {
    return (this.stopping ??= this.drain());
  }

  private async drain(): Promise<void> {
    this.accepting = false;

    for (const lease of this.workflowLeases.values()) lease.revoke();
    this.workflowLeases.clear();

    for (const lease of this.composerPredictions.values()) lease.revoke();
    this.composerPredictions.clear();

    this.stopped.abort(new Error("Account Pooler stopped accepting requests."));

    if (this.inFlightCount() === 0) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.add(resolve)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.drainTimeoutMs);
      }),
    ]);

    if (timeout !== null) clearTimeout(timeout);

    if (this.inFlightCount() === 0) return;

    for (const controller of this.activeControllers) {
      controller.abort(
        new Error(
          "Account Pooler stopped before the upstream response completed.",
        ),
      );
    }
  }

  async status(): Promise<Omit<PoolStatus, "routing" | "parent">> {
    const settings = this.options.getSettings();
    const now = this.options.now();

    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );

    return {
      route: ROUTE,
      enabledAccountCount: accounts.filter(
        (account) => account.enabled && !isLegacyClaudeAccount(account),
      ).length,
      inFlight: this.inFlightCount(),
      accepting: this.accepting,
      hosts: await this.options.hubTokens.list(),
      accounts: accounts.map((account) => {
        const quota = this.options.quotas.get(account.id);
        const { accountId: _accountId, ...quotaFields } = quota;

        const predictionRejection = this.options.quotas.predictionRejection(
          account.id,
        );

        const retired = isLegacyClaudeAccount(account);

        return {
          ...account,
          enabled: retired ? false : account.enabled,
          lastUsedHostName: null,
          ...quotaFields,
          incompatibleModels: this.options.quotas
            .modelRejections(account.id)
            .filter((rejection) =>
              isActiveModelRejection(account, rejection, now),
            )
            .map(({ model, plan, observedAt }) => ({
              model,
              plan,
              observedAt,
            })),
          modelCatalog: this.modelCatalogSummary(account, now),
          composerPredictionsDisabled: isActivePredictionRejection(
            account,
            predictionRejection,
            now,
          )
            ? {
                plan: predictionRejection.plan,
                observedAt: predictionRejection.observedAt,
              }
            : null,
          inFlight: this.inFlightByAccount.get(account.id) ?? 0,
          error: retired ? CLAUDE_POOL_LOGIN_RETIRED : quota.error,
          status: retired
            ? "disabled"
            : accountStatus(account, quota, settings.switchThreshold, now),
        };
      }),
    };
  }

  private async forward(
    request: Request,
    body: Uint8Array,
    adapter: ProviderAdapter,
    hostId: string,
    routePath: string,
    served?: (account: Account) => void,
  ): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.stopped.signal]);

    const metadata =
      adapter.provider === "claude" &&
      request.method === "GET" &&
      routePath === "/claude/v1/models";

    const attempted = new Set<string>();
    const waited = new Set<string>();

    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
    };

    let previousAccountId: string | null = null;
    let failure: FailureSummary | null = null;
    let usageRefreshed = false;

    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === adapter.provider,
    );

    const candidateIds = new Set(
      accounts
        .filter((account) => !isLegacyClaudeAccount(account))
        .map((account) => account.id),
    );

    const parsed = adapter.parseRequest(body, request.headers);
    const family = parsed.family;

    const model =
      request.method === "POST" && routePath === MODEL_ROUTED_PATH
        ? parsed.model
        : null;

    const serviceTier =
      model === null ? null : requestedCodexServiceTier(parsed.serviceTier);

    const affinityKey =
      parsed.affinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.affinityId]);

    const parentAffinityKey =
      affinityKey === null || parsed.parentAffinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.parentAffinityId]);

    if (adapter.provider === "claude" && !metadata) {
      const retiredAffinity = [affinityKey, parentAffinityKey].some((key) => {
        if (key === null) return false;
        const binding = this.affinityBindings.get(key);

        return (
          binding !== undefined &&
          accounts.some(
            (account) =>
              account.id === binding.accountId &&
              isLegacyClaudeAccount(account),
          )
        );
      });

      if (
        retiredAffinity ||
        (candidateIds.size === 0 && accounts.some(isLegacyClaudeAccount))
      )
        return adapter.errorResponse(409, CLAUDE_POOL_THREAD_RETIRED);
    }

    try {
      while (attempted.size < candidateIds.size) {
        signal.throwIfAborted();

        const selected = await this.select(
          adapter.provider,
          candidateIds,
          attempted,
          family,
          model,
          affinityKey,
          parentAffinityKey,
          previousAccountId,
          routing,
          signal,
          { metadata, serviceTier },
        );

        if (
          !metadata &&
          !usageRefreshed &&
          (selected === null || !isSubscriptionRank(selected.rank))
        ) {
          usageRefreshed = true;
          await abortable(
            this.refreshExhaustedUsage(candidateIds, attempted, family),
            signal,
          );
          continue;
        }

        if (selected === null) break;
        let pacing: PacingFlight | null = null;

        const heldMs = metadata
          ? 0
          : (selected.quota.heldUntil ?? 0) - this.options.now();

        let activePacing = this.pacingByAccount.get(selected.account.id);

        if (
          !metadata &&
          activePacing !== undefined &&
          (activePacing.heldUntil !== selected.quota.heldUntil || heldMs <= 0)
        ) {
          this.releasePacing(selected.account.id, activePacing);
          activePacing = undefined;
        }

        if (heldMs > 0) {
          if (activePacing !== undefined) {
            pacing = activePacing;
            waited.add(selected.account.id);
            await abortable(activePacing.result, signal);
          } else if (
            heldMs > MAX_INLINE_HOLD_MS ||
            waited.has(selected.account.id)
          ) {
            failure = {
              status: 429,
              message:
                "The current Account Pooler account is temporarily rate limited.",
              headers: { "retry-after": String(Math.ceil(heldMs / 1_000)) },
            };

            if (selected.keepAffinity)
              return adapter.errorResponse(
                failure.status,
                failure.message,
                failure.headers,
              );
            attempted.add(selected.account.id);
            previousAccountId = selected.account.id;
            continue;
          } else {
            waited.add(selected.account.id);
            await waitForDelay(heldMs, signal);
            continue;
          }
        }

        previousAccountId = selected.account.id;
        attempted.add(selected.account.id);

        const changed =
          !metadata &&
          (await this.options.accounts.recordUsed(
            selected.account.id,
            this.options.now(),
            hostId,
          ));

        if (changed) this.options.onAccountsChanged();
        let secret: AccountSecret;

        try {
          signal.throwIfAborted();
          secret = await abortable(
            this.freshSecret(selected.account, adapter, { kind: "normal" }),
            signal,
          );
        } catch (error) {
          if (pacing !== null) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }

          signal.throwIfAborted();

          if (error instanceof TransientOAuthRefreshError) {
            failure = { status: 503, message: error.message, headers: {} };
          } else {
            this.setError(selected.account.id, errorMessage(error));
          }

          continue;
        }

        let authRetried = false;
        let transientRetries = 0;
        let paced = waited.has(selected.account.id);

        const retryTransient = async (
          retryAfter: string | null,
        ): Promise<boolean> => {
          if (!selected.keepAffinity) return false;

          const delayMs = transientRetryDelay(
            transientRetries,
            retryAfter,
            this.options.now(),
          );

          if (delayMs === null) return false;
          transientRetries++;
          await waitForDelay(delayMs, signal);
          signal.throwIfAborted();

          return true;
        };

        while (true) {
          signal.throwIfAborted();
          let upstream: UpstreamResult;

          try {
            upstream = await this.fetchUpstream(
              request,
              body,
              selected.account,
              secret,
              adapter,
            );
          } catch (error) {
            if (pacing !== null) {
              this.releasePacing(selected.account.id, pacing);
              pacing = null;
            }

            signal.throwIfAborted();

            if (!(error instanceof UpstreamConnectionError)) throw error;
            failure = {
              status: 502,
              message:
                "Account Pooler could not reach " + adapter.upstreamName + ".",
              headers: {},
            };

            if (await retryTransient(null)) continue;
            break;
          }

          if (request.signal.aborted) {
            await this.discardUpstream(upstream, false);
            signal.throwIfAborted();
          }

          const { response } = upstream;

          const observed = metadata
            ? this.options.quotas.get(selected.account.id)
            : adapter.quotaFromHeaders(
                selected.account.id,
                response.headers,
                this.options.quotas.get(selected.account.id),
                family,
                this.options.now(),
              );

          if (!metadata) this.options.quotas.put(observed);

          if (pacing !== null && !response.ok) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }

          if (response.status === 429) {
            if (metadata) return this.clientResponse(upstream);

            if (adapter.isQuotaRejection(response.headers)) {
              await this.discardUpstream(upstream, false);
              break;
            }

            const waitMs = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              this.options.now(),
            );

            const heldUntil = this.options.now() + waitMs;
            this.options.quotas.put({
              ...observed,
              heldUntil,
            });

            if (!paced && waitMs <= MAX_INLINE_HOLD_MS) {
              paced = true;
              pacing = {
                heldUntil,
                result: waitForDelay(waitMs, this.stopped.signal),
              };
              this.pacingByAccount.set(selected.account.id, pacing);
              await this.discardUpstream(upstream, false);
              await abortable(pacing.result, signal);
              continue;
            }

            if (!selected.keepAffinity) {
              failure = {
                status: 429,
                message: await this.discardUpstream(upstream, true),
                headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) },
              };
              break;
            }
          }

          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 408 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            response.status === 529
          ) {
            const retryAfter = response.headers.get("retry-after");
            const detail = await this.discardUpstream(upstream, true);
            signal.throwIfAborted();
            failure = {
              status: response.status,
              message:
                detail ||
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  ".",
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            };
            const rejected = response.status === 401 || response.status === 403;

            if (!rejected) {
              if (await retryTransient(retryAfter)) continue;
              break;
            }

            if (secret.kind === "oauth" && !authRetried) {
              authRetried = true;

              try {
                secret = await abortable(
                  this.freshSecret(selected.account, adapter, {
                    kind: "rejected",
                    accessToken: secret.accessToken,
                  }),
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();

                if (error instanceof TransientOAuthRefreshError) {
                  failure = {
                    status: 503,
                    message: error.message,
                    headers: {},
                  };
                } else {
                  const message = errorMessage(error);
                  await this.rejectCredential(
                    selected.account,
                    secret,
                    signal,
                    () => this.setError(selected.account.id, message),
                  );
                }

                break;
              }

              continue;
            }

            if (secret.kind === "oauth") {
              const accessToken = secret.accessToken;

              const hold = new TransientOAuthRefreshError(
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  " for a freshly refreshed credential, so the Account Pooler is treating it as an upstream failure: " +
                  failure.message,
                0,
              );

              failure = { status: 503, message: hold.message, headers: {} };
              await this.rejectCredential(
                selected.account,
                secret,
                signal,
                () =>
                  this.holdUpstreamRejection(
                    selected.account.id,
                    accessToken,
                    hold,
                  ),
              );
            } else {
              const message = failure.message;
              await this.rejectCredential(
                selected.account,
                secret,
                signal,
                () => this.setError(selected.account.id, message),
              );
            }

            break;
          }

          let modelRejected = false;

          if (model !== null) {
            const inspected = await adapter.inspectModelRejection(
              response,
              model,
              upstream.controller.signal,
            );

            upstream = { ...upstream, response: inspected.response };

            if (request.signal.aborted) {
              await this.discardUpstream(upstream, false);
              signal.throwIfAborted();
            }

            modelRejected = inspected.rejected;

            if (
              modelRejected &&
              this.anotherAccountMayServe(
                accounts,
                selected.account,
                model,
                serviceTier,
              )
            ) {
              if (pacing !== null) {
                this.releasePacing(selected.account.id, pacing);
                pacing = null;
              }

              await this.discardUpstream(upstream, false);
              signal.throwIfAborted();
              this.recordModelRejection(selected.account, model);
              break;
            }
          }

          if (response.ok && !modelRejected) {
            selected.accept();

            if (model !== null && selected.markedIncompatible)
              this.clearModelRejection(selected.account, model);

            served?.(selected.account);
          }

          if (adapter.provider === "codex" && response.ok && !modelRejected)
            this.noteModelsEtag(
              selected.account,
              response.headers.get(MODELS_ETAG_HEADER),
            );

          return this.clientResponse(
            upstream,
            adapter.provider === "codex" ? this.modelsEtags : null,
          );
        }
      }

      signal.throwIfAborted();

      return failure === null
        ? this.noEligibleResponse(accounts, family, model, serviceTier, adapter)
        : adapter.errorResponse(
            failure.status,
            failure.message,
            failure.headers,
          );
    } catch (error) {
      if (!signal.aborted) throw error;

      return adapter.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
      );
    }
  }

  private async discardUpstream(
    upstream: UpstreamResult,
    readDetail: boolean,
  ): Promise<string> {
    const reader = upstream.response.body?.getReader();

    if (reader === undefined) {
      upstream.controller.abort();
      upstream.release();

      return "";
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
    });

    let detail = "";

    try {
      if (!readDetail) return detail;

      return await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;

          while (bytes < MAX_FAILURE_DETAIL_BYTES) {
            const chunk = await reader.read();

            if (chunk.done) break;

            const part = chunk.value.subarray(
              0,
              MAX_FAILURE_DETAIL_BYTES - bytes,
            );

            bytes += part.byteLength;
            detail += decoder.decode(part, { stream: true });
          }

          return (detail + decoder.decode()).trim();
        })().catch(() => detail.trim()),
        deadline,
      ]);
    } finally {
      upstream.controller.abort();
      await Promise.race([reader.cancel().catch(() => undefined), deadline]);
      clearTimeout(timeout);
      upstream.release();
    }
  }

  private async rejectCredential(
    account: Account,
    rejected: AccountSecret,
    signal: AbortSignal,
    apply: () => void,
  ): Promise<void> {
    if (rejected.kind !== "oauth") {
      apply();

      return;
    }

    while (true) {
      signal.throwIfAborted();
      const existing = this.refreshes.get(account.id);

      if (existing !== undefined) {
        await abortable(
          existing.result.then(
            () => undefined,
            () => undefined,
          ),
          signal,
        );
        continue;
      }

      const flight: SecretFlight = {
        kind: "rejection-check",
        result: this.options.accounts
          .readSecret(account)
          .then((current) => {
            const backoff = this.refreshBackoffs.get(account.id);

            if (
              !signal.aborted &&
              current.kind === "oauth" &&
              current.accessToken === rejected.accessToken &&
              !(
                backoff !== undefined &&
                backoff.kind !== "proactive" &&
                backoff.accessToken === current.accessToken
              )
            ) {
              apply();
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };

      this.refreshes.set(account.id, flight);
      await abortable(flight.result, signal);

      return;
    }
  }

  private async select(
    provider: PoolProvider,
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
    model: string | null,
    affinityKey: string | null,
    parentAffinityKey: string | null,
    previousAccountId: string | null,
    routing: RoutingAttempt,
    signal: AbortSignal,
    {
      metadata = false,
      serviceTier = null,
    }: { metadata?: boolean; serviceTier?: string | null } = {},
  ): Promise<SelectedAccount | null> {
    const accounts = (await this.options.accounts.listRoutable()).sort(
      (left, right) => left.priority - right.priority,
    );

    signal.throwIfAborted();
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;

    const providerAccounts = accounts.filter(
      (account) => account.provider === provider,
    );

    if (metadata) {
      const account = providerAccounts.find(
        (candidate) =>
          candidateIds.has(candidate.id) &&
          !attempted.has(candidate.id) &&
          candidate.enabled &&
          this.options.quotas.get(candidate.id).error === null,
      );

      return account === undefined
        ? null
        : {
            account,
            quota: this.options.quotas.get(account.id),
            rank: 0,
            keepAffinity: false,
            markedIncompatible: false,
            accept: () => {},
          };
    }

    const marked = this.markedAccountIds(providerAccounts, model);

    const excluded = routingExclusions(
      providerAccounts,
      this.modelExclusions(providerAccounts, model, marked),
    );

    const entitled = this.tierAccountIds(providerAccounts, model, serviceTier);

    const pool = providerAccounts.map((account) => {
      const quota = this.options.quotas.get(account.id);

      return {
        account,
        quota,
        rank:
          excluded.has(account.id) || entitled?.has(account.id) === false
            ? null
            : routeRank(account, quota, family, threshold, now),
      };
    });

    const ranked = pool.flatMap(({ account, quota, rank }) =>
      rank === null ? [] : [{ account, quota, rank }],
    );

    const unattempted = ranked.filter(
      ({ account }) =>
        candidateIds.has(account.id) && !attempted.has(account.id),
    );

    const ready = unattempted.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );

    const floor = Math.min(...ready.map(({ rank }) => rank));

    const narrow = isSubscriptionRank(floor)
      ? null
      : this.narrowPlanAccountIds(providerAccounts, model);

    const narrowCredit =
      narrow !== null &&
      ready.some(
        ({ account, rank }) => rank === floor && narrow.has(account.id),
      )
        ? narrow
        : null;

    const spendsFirst = (rank: number, accountId: string) =>
      isSubscriptionRank(rank) ||
      narrowCredit === null ||
      narrowCredit.has(accountId);

    const keepsCursor = (rank: number, accountId: string) =>
      rank <= floor && spendsFirst(rank, accountId);

    const keepsPin = (rank: number, accountId: string) =>
      isSubscriptionRank(rank) ||
      (rank <= floor && spendsFirst(rank, accountId));

    const candidates = ready.filter(
      ({ account, rank }) => rank === floor && spendsFirst(rank, account.id),
    );

    let binding =
      affinityKey === null ? undefined : this.affinityBindings.get(affinityKey);

    const boundAccountId =
      binding !== undefined && now - binding.lastUsedAt < AFFINITY_IDLE_TTL_MS
        ? binding.accountId
        : null;

    const bound =
      boundAccountId !== null
        ? ranked.find(
            ({ account, rank }) =>
              account.id === boundAccountId && keepsPin(rank, account.id),
          )
        : undefined;

    let inherited: (typeof candidates)[number] | undefined;

    if (bound === undefined && parentAffinityKey !== null) {
      const parent = this.affinityBindings.get(parentAffinityKey);

      if (
        parent !== undefined &&
        now - parent.lastUsedAt < AFFINITY_IDLE_TTL_MS
      ) {
        inherited = unattempted.find(
          ({ account, rank }) =>
            account.id === parent.accountId && keepsPin(rank, account.id),
        );
      }
    }

    let active = this.activeAccounts.get(provider);

    const activeAccount = ranked.find(
      ({ account, rank }) =>
        account.id === active?.accountId && keepsCursor(rank, account.id),
    );

    const anchorId = previousAccountId ?? boundAccountId ?? active?.accountId;

    const anchorIndex = accounts.findIndex(
      (account) => account.id === anchorId,
    );

    const ordered = [
      ...accounts.slice(anchorIndex + 1),
      ...accounts.slice(0, anchorIndex + 1),
    ];

    const next = ordered
      .map((account) =>
        candidates.find((candidate) => candidate.account.id === account.id),
      )
      .find((candidate) => candidate !== undefined);

    const selected =
      bound !== undefined && unattempted.includes(bound)
        ? bound
        : (inherited ??
          (boundAccountId === null &&
          previousAccountId === null &&
          activeAccount !== undefined &&
          unattempted.includes(activeAccount)
            ? activeAccount
            : next) ??
          null);

    if (selected === null) return null;

    if (routing.active === null)
      routing.pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;

    if (affinityKey !== null && binding === undefined) {
      binding = { accountId: selected.account.id, lastUsedAt: now };
      this.affinityBindings.set(affinityKey, binding);
    }

    if (binding !== undefined && binding.accountId === selected.account.id) {
      binding.lastUsedAt = now;

      if (affinityKey !== null) {
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, binding);
      }
    }

    while (this.affinityBindings.size > this.options.maxAffinityBindings) {
      const oldest = this.affinityBindings.keys().next();

      if (!oldest.done) {
        this.affinityBindings.delete(oldest.value);
        this.options.affinity.removeBinding(oldest.value);
      }
    }

    if (active === undefined) {
      active = { accountId: selected.account.id };
      this.activeAccounts.set(provider, active);
    }

    routing.binding ??= binding ?? null;
    routing.active ??= active;

    const capabilityDetour = (
      accountId: string | null,
      keeps: (rank: number, accountId: string) => boolean,
    ) =>
      pool.some(({ account, quota, rank }) => {
        if (account.id !== accountId || account.id === selected.account.id)
          return false;
        const shared = routeRank(account, quota, null, threshold, now);

        return (
          shared !== null &&
          keeps(shared, account.id) &&
          (rank === null || !keeps(rank, account.id))
        );
      });

    const rebind =
      affinityKey !== null &&
      !capabilityDetour(boundAccountId, keepsPin) &&
      (bound === undefined ||
        bound.account.id === selected.account.id ||
        (binding === routing.binding && attempted.has(bound.account.id)));

    const advance =
      !capabilityDetour(active.accountId, keepsCursor) &&
      (activeAccount === undefined ||
        active.accountId === selected.account.id ||
        (active === routing.active && attempted.has(active.accountId)));

    return {
      ...selected,
      keepAffinity: selected.account.id === routing.pinnedAccountId,
      markedIncompatible: marked.has(selected.account.id),
      accept: () => {
        if (rebind && this.affinityBindings.get(affinityKey) === binding) {
          const accepted = {
            accountId: selected.account.id,
            lastUsedAt: this.options.now(),
          };

          this.options.affinity.putBinding(affinityKey, accepted);
          this.affinityBindings.delete(affinityKey);
          this.affinityBindings.set(affinityKey, accepted);
        }

        if (advance && this.activeAccounts.get(provider) === active) {
          this.options.affinity.putActiveAccount(provider, selected.account.id);
          this.activeAccounts.set(provider, { accountId: selected.account.id });
        }
      },
    };
  }

  private async freshSecret(
    account: Account,
    adapter: ProviderAdapter,
    use: SecretUse,
    recover = false,
  ): Promise<AccountSecret> {
    while (true) {
      const existing = this.refreshes.get(account.id);

      if (existing !== undefined) {
        if (existing.kind !== "refresh") {
          await existing.result;
          continue;
        }

        let secret: AccountSecret;

        try {
          secret = await existing.result;
        } catch (error) {
          const current = this.refreshes.get(account.id);

          if (current !== undefined && current !== existing) continue;
          throw error;
        }

        const current = this.refreshes.get(account.id);

        if (current !== undefined && current !== existing) continue;
        const backoff = this.refreshBackoffs.get(account.id);

        if (
          secret.kind === "oauth" &&
          backoff?.accessToken === secret.accessToken &&
          backoff.kind !== "proactive"
        )
          continue;

        if (
          use.kind === "normal" ||
          secret.kind !== "oauth" ||
          secret.accessToken !== use.accessToken ||
          (existing.use.kind === "rejected" &&
            existing.use.accessToken === use.accessToken)
        ) {
          return secret;
        }

        continue;
      }

      const flight: Extract<SecretFlight, { kind: "refresh" }> = {
        kind: "refresh",
        use,
        result: this.options.accounts
          .readSecret(account)
          .then(async (secret) => {
            let backoff = this.refreshBackoffs.get(account.id);

            if (
              secret.kind !== "oauth" ||
              backoff?.accessToken !== secret.accessToken
            ) {
              this.refreshBackoffs.delete(account.id);
              backoff = undefined;
            }

            const explicitlyRejected =
              secret.kind === "oauth" &&
              use.kind === "rejected" &&
              secret.accessToken === use.accessToken;

            const forceRefresh =
              recover || explicitlyRejected || backoff?.kind === "rejected";

            if (forceRefresh && secret.kind === "oauth") {
              flight.use = {
                kind: "rejected",
                accessToken: secret.accessToken,
              };
            }

            const rejection =
              secret.kind === "oauth"
                ? await this.options.accounts.rejectedRefresh(
                    account.id,
                    secret.refreshToken,
                  )
                : null;

            const error = this.options.quotas.get(account.id).error;

            if (error !== null && !recover) throw new Error(error);

            if (rejection?.sameToken && !recover && secret.kind === "oauth") {
              if (
                !forceRefresh &&
                accessTokenUnexpired(secret, this.options.now())
              )
                return secret;
              throw new OAuthRefreshError(rejection.message);
            }

            if (
              !recover &&
              backoff !== undefined &&
              this.options.now() < backoff.retryAt &&
              (!explicitlyRejected || backoff.kind !== "proactive")
            ) {
              if (
                backoff.kind === "proactive" &&
                !forceRefresh &&
                secret.kind === "oauth" &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }

              throw backoff.error;
            }

            try {
              const result = await adapter.refreshSecret({
                account,
                secret,
                accounts: this.options.accounts,
                quotas: this.options.quotas,
                fetch: this.options.fetch,
                now: this.options.now,
                forceRefresh,
              });

              this.refreshBackoffs.delete(account.id);

              if (result.refreshed) {
                this.options.onOAuthRefresh(
                  account.provider,
                  account.id,
                  "succeeded",
                  `previousExpiresAt=${secret.kind === "oauth" ? secret.expiresAt : null}, expiresAt=${result.secret.kind === "oauth" ? result.secret.expiresAt : null}, forced=${forceRefresh}.`,
                );
                this.setError(account.id, null);
              }

              if (rejection !== null)
                await this.options.accounts.clearRejectedRefresh(account.id);

              return result.secret;
            } catch (error) {
              this.options.onOAuthRefresh(
                account.provider,
                account.id,
                "failed",
                `${error instanceof OAuthRefreshError ? error.message : "Stored credential refresh failed."} expiresAt=${secret.kind === "oauth" ? secret.expiresAt : null}, forced=${forceRefresh}.`,
              );

              if (
                !(error instanceof TransientOAuthRefreshError) ||
                secret.kind !== "oauth"
              ) {
                this.refreshBackoffs.delete(account.id);

                if (
                  error instanceof OAuthRefreshError &&
                  secret.kind === "oauth"
                ) {
                  await this.options.accounts.recordRejectedRefresh(
                    account.id,
                    secret.refreshToken,
                    error.message,
                  );

                  if (
                    !forceRefresh &&
                    accessTokenUnexpired(secret, this.options.now())
                  )
                    return secret;
                }

                throw error;
              }

              const delayMs = Math.min(
                MAX_REFRESH_BACKOFF_MS,
                Math.max(
                  backoff === undefined ? 1_000 : backoff.delayMs * 2,
                  error.retryAfterMs,
                ),
              );

              this.refreshBackoffs.delete(account.id);
              this.refreshBackoffs.set(account.id, {
                kind: forceRefresh ? "rejected" : "proactive",
                accessToken: secret.accessToken,
                retryAt: this.options.now() + delayMs,
                delayMs,
                error,
              });

              while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
                const oldest = this.refreshBackoffs.keys().next();

                if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
              }

              if (
                !forceRefresh &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }

              throw error;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };

      this.refreshes.set(account.id, flight);

      return flight.result;
    }
  }

  private readonly upstreamOperations = new WeakMap<
    Request,
    { operationId: string; attempt: number }
  >();

  private upstreamContext(
    request: Request,
    endpoint: UpstreamDiagnosticContext["endpoint"],
  ): UpstreamDiagnosticContext {
    const operation = this.upstreamOperations.get(request) ?? {
      operationId: randomUUID(),
      attempt: 0,
    };

    operation.attempt++;
    this.upstreamOperations.set(request, operation);

    return { ...operation, endpoint, startedAt: performance.now() };
  }

  private async fetchUpstream(
    request: Request,
    body: Uint8Array,
    account: Account,
    secret: AccountSecret,
    adapter: ProviderAdapter,
  ): Promise<UpstreamResult> {
    this.increment(account.id);

    const { controller, release } = this.trackRequest(request, () =>
      this.decrement(account.id),
    );

    const measurement =
      adapter.provider === "codex" && request.method === "POST"
        ? this.options.telemetry?.start(account.id, body, request.headers)
        : null;

    try {
      const upstreamBody = new ArrayBuffer(body.byteLength);
      new Uint8Array(upstreamBody).set(body);
      const url = adapter.upstreamUrl(request, this.options.getSettings());
      const headers = adapter.requestHeaders(request.headers, account, secret);

      const context = this.upstreamContext(
        request,
        new URL(request.url).pathname.endsWith("/models")
          ? "models"
          : adapter.provider === "claude"
            ? "messages"
            : "responses",
      );

      const response = await this.options
        .fetch(url, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: upstreamBody }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            this.options.onUpstreamError(adapter.provider, cause);
            this.options.onUpstreamDiagnostic(
              adapter.provider,
              upstreamDiagnostic(context, cause),
            );
          }

          throw new UpstreamConnectionError("Upstream connection failed.", {
            cause,
          });
        });

      const requestDiagnostic =
        adapter.provider === "codex" &&
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith(MODEL_ROUTED_PATH) &&
        response.status === 400
          ? codexRejectionRequestDiagnostic(
              new Uint8Array(upstreamBody),
              headers,
            )
          : null;

      const observed = observeUpstreamResponse(
        response,
        context,
        (diagnostic) =>
          this.options.onUpstreamDiagnostic(
            adapter.provider,
            requestDiagnostic === null
              ? diagnostic
              : { ...diagnostic, codexRequest: requestDiagnostic },
          ),
      );

      return {
        response: measurement?.wrap(observed) ?? observed,
        controller,
        release,
      };
    } catch (error) {
      measurement?.failed();
      release();
      throw error;
    }
  }

  private clientResponse(
    upstream: UpstreamResult,
    modelsEtags: ReadonlyMap<string, string> | null = null,
  ): Response {
    const headers = new Headers();

    for (const [name, value] of upstream.response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers.append(name, value);
    }

    const modelsEtag = headers.get(MODELS_ETAG_HEADER);

    const mergedEtag =
      modelsEtag === null ? undefined : modelsEtags?.get(modelsEtag);

    if (mergedEtag !== undefined) headers.set(MODELS_ETAG_HEADER, mergedEtag);

    if (upstream.response.body === null) {
      upstream.release();

      return new Response(null, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers,
      });
    }

    const reader = upstream.response.body.getReader();

    const eventStream =
      upstream.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream";

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();

          if (chunk.done) {
            upstream.release();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          upstream.release();

          if (!eventStream) {
            controller.error(
              error instanceof Error ? error : new Error(String(error)),
            );

            return;
          }

          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage(error) } })}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel() {
        upstream.controller.abort();
        await reader.cancel().catch(() => undefined);
        upstream.release();
      },
    });

    return new Response(body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers,
    });
  }

  async retryAvailability(
    provider: PoolProvider,
    family: ModelFamily,
    model: string | null,
    tier: string | null = null,
  ): Promise<RetryAvailability> {
    const serviceTier =
      provider === "codex" ? requestedCodexServiceTier(tier) : null;

    const parent = this.options.getParentRoute();

    if (parent !== null) {
      try {
        const query = new URLSearchParams({ provider, family });

        if (serviceTier !== null && model !== null) {
          query.set("model", model);
          query.set("serviceTier", serviceTier);
        }

        const response = await this.options.fetch(
          `${parent.baseUrl}/retry-availability?${query}`,
          {
            headers: { [HUB_TOKEN_HEADER]: parent.token },
            signal: AbortSignal.timeout(2_000),
          },
        );

        if (response.ok)
          return retryAvailabilitySchema.parse(await response.json());
        await response.body?.cancel();
      } catch {
        return { kind: "unavailable", reason: "source-unavailable" };
      }

      return { kind: "unavailable", reason: "source-unavailable" };
    }

    const accounts = (await this.options.accounts.listRoutable()).filter(
      (account) => account.provider === provider,
    );

    return this.accountAvailability(
      accounts,
      family,
      model,
      this.tierAccountIds(accounts, model, serviceTier),
    );
  }

  private markedAccountIds(
    accounts: readonly Account[],
    model: string | null,
  ): Set<string> {
    if (model === null) return new Set();
    const now = this.options.now();
    const byId = new Map(accounts.map((account) => [account.id, account]));

    return new Set(
      this.options.quotas.modelRejectionsFor(model).flatMap((rejection) => {
        const account = byId.get(rejection.accountId);

        return account !== undefined &&
          isActiveModelRejection(account, rejection, now)
          ? [account.id]
          : [];
      }),
    );
  }

  private narrowPlanAccountIds(
    accounts: readonly Account[],
    model: string | null,
  ): Set<string> | null {
    if (model === null) return null;
    const catalogNarrow = this.catalogNarrowAccountIds(accounts, model);

    const narrow = accounts.filter(
      (account) =>
        catalogNarrow.has(account.id) ||
        rejectsOtherModel(
          account,
          this.options.quotas.modelRejections(account.id),
          model,
        ),
    );

    return narrow.length === 0
      ? null
      : new Set(narrow.map((account) => account.id));
  }

  private catalogNarrowAccountIds(
    accounts: readonly Account[],
    model: string,
  ): Set<string> {
    const now = this.options.now();

    const lists = accounts.flatMap((account) => {
      if (
        !account.enabled ||
        this.options.quotas.get(account.id).error !== null
      )
        return [];
      const header = this.options.quotas.latestModelCatalogHeader(account.id);

      if (header === null || !isActiveModelCatalog(account, header, now))
        return [];

      return [
        {
          accountId: account.id,
          clientVersion: header.clientVersion,
          slugs: new Set(
            this.options.quotas.modelCatalogSlugs(
              account.id,
              header.clientVersion,
            ),
          ),
        },
      ];
    });

    return new Set(
      lists
        .filter((own) =>
          lists.some(
            (other) =>
              other.clientVersion === own.clientVersion &&
              [...other.slugs].some(
                (slug) => slug !== model && !own.slugs.has(slug),
              ),
          ),
        )
        .map(({ accountId }) => accountId),
    );
  }

  private modelExclusions(
    accounts: readonly Account[],
    model: string | null,
    marked: ReadonlySet<string>,
  ): ReadonlySet<string> {
    if (model === null) return marked;
    const now = this.options.now();
    const byId = new Map(accounts.map((account) => [account.id, account]));

    const active = (header: ModelCatalogHeader) => {
      const account = byId.get(header.accountId);

      return (
        account !== undefined &&
        account.enabled &&
        this.options.quotas.get(account.id).error === null &&
        isActiveModelCatalog(account, header, now)
      );
    };

    const listing = this.options.quotas
      .modelCatalogHeadersListing(model)
      .filter(active);

    if (listing.length === 0) return marked;

    const listers = new Set(listing.map((header) => header.accountId));
    const versions = new Set(listing.map((header) => header.clientVersion));

    return new Set([
      ...marked,
      ...this.options.quotas
        .modelCatalogHeaders()
        .filter(
          (header) =>
            active(header) &&
            !listers.has(header.accountId) &&
            versions.has(header.clientVersion),
        )
        .map((header) => header.accountId),
    ]);
  }

  private tierAccountIds(
    accounts: readonly Account[],
    model: string | null,
    serviceTier: string | null,
  ): ReadonlySet<string> | null {
    if (model === null || serviceTier === null) return null;
    const now = this.options.now();

    const enabled = new Map(
      accounts
        .filter((account) => account.enabled)
        .map((account) => [account.id, account]),
    );

    return new Set(
      this.options.quotas
        .latestModelCatalogEntriesListing(model)
        .flatMap((catalog) => {
          const account = enabled.get(catalog.accountId);

          return account !== undefined &&
            isActiveModelCatalog(account, catalog, now) &&
            advertisesServiceTier(catalog.entry, serviceTier)
            ? [account.id]
            : [];
        }),
    );
  }

  private anotherAccountMayServe(
    accounts: readonly Account[],
    account: Account,
    model: string,
    serviceTier: string | null,
  ): boolean {
    const excluded = this.modelExclusions(
      accounts,
      model,
      this.markedAccountIds(accounts, model),
    );

    const entitled = this.tierAccountIds(accounts, model, serviceTier);

    return accounts.some(
      (other) =>
        other.enabled &&
        other.id !== account.id &&
        !excluded.has(other.id) &&
        entitled?.has(other.id) !== false,
    );
  }

  private recordModelRejection(account: Account, model: string): void {
    this.options.quotas.recordModelRejection({
      accountId: account.id,
      model,
      plan: account.subscriptionType,
      observedAt: this.options.now(),
    });
    this.options.onAccountsChanged();
  }

  private clearModelRejection(account: Account, model: string): void {
    this.options.quotas.clearModelRejection(account.id, model);
    this.options.onAccountsChanged();
  }

  private accountAvailability(
    accounts: readonly Account[],
    family: ModelFamily,
    model: string | null,
    entitled: ReadonlySet<string> | null,
  ): RetryAvailability {
    const enabled = accounts.filter((account) => account.enabled);

    if (enabled.length === 0)
      return { kind: "unavailable", reason: "no-enabled-account" };

    const excluded = routingExclusions(
      enabled,
      this.modelExclusions(
        enabled,
        model,
        this.markedAccountIds(enabled, model),
      ),
    );

    if (entitled?.size === 0)
      return { kind: "unavailable", reason: "source-unavailable" };

    const compatible = enabled.filter(
      (account) =>
        !excluded.has(account.id) && entitled?.has(account.id) !== false,
    );

    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const resets: number[] = [];
    let unknown = false;

    for (const account of compatible) {
      const quota = this.options.quotas.get(account.id);

      if (quota.error !== null) continue;

      const rank = routeRank(account, quota, family, threshold, now);

      const resetAt =
        rank === null ? rejoinAt(quota, family, threshold, now) : now;

      if (resetAt === null) {
        unknown = true;
        continue;
      }

      const availableAt = Math.max(resetAt, quota.heldUntil ?? 0);

      if (availableAt <= now) return { kind: "ready" };
      resets.push(availableAt);
    }

    return resets.length > 0
      ? { kind: "blocked", retryAt: Math.min(...resets) }
      : {
          kind: "unavailable",
          reason: unknown ? "reset-unknown" : "authentication",
        };
  }

  private noEligibleResponse(
    accounts: readonly Account[],
    family: ModelFamily,
    model: string | null,
    serviceTier: string | null,
    adapter: ProviderAdapter,
  ): Response {
    if (!accounts.some((account) => account.enabled)) {
      return adapter.errorResponse(
        503,
        "Account Pooler has no enabled account",
      );
    }

    const now = this.options.now();
    const entitled = this.tierAccountIds(accounts, model, serviceTier);

    if (entitled?.size === 0)
      return adapter.errorResponse(
        400,
        `No enabled Account Pooler account advertises service tier "${serviceTier}" for model "${model}". Refresh Codex's model catalog to update account capabilities.`,
      );

    const availability = this.accountAvailability(
      accounts,
      family,
      model,
      entitled,
    );

    const next =
      availability.kind === "blocked" ? availability.retryAt : undefined;

    const retryAfter = Math.max(
      1,
      Math.ceil(((next ?? now + 1_000) - now) / 1_000),
    );

    return adapter.errorResponse(
      429,
      next === undefined
        ? "No Account Pooler account is currently eligible."
        : `No Account Pooler account is currently eligible. Next account is expected to be available at ${new Date(next).toISOString()} (in ${retryAfter} seconds).`,
      { "retry-after": String(retryAfter) },
    );
  }

  private holdUpstreamRejection(
    accountId: string,
    accessToken: string,
    error: TransientOAuthRefreshError,
  ): void {
    this.refreshBackoffs.delete(accountId);
    this.refreshBackoffs.set(accountId, {
      kind: "upstream",
      accessToken,
      retryAt: this.options.now() + UPSTREAM_REJECTION_HOLD_MS,
      delayMs: UPSTREAM_REJECTION_HOLD_MS,
      error,
    });

    while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
      const oldest = this.refreshBackoffs.keys().next();

      if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
    }
  }

  private setError(accountId: string, message: string | null): void {
    const quota = this.options.quotas.get(accountId);
    const error = message?.slice(0, 1_000) ?? null;

    if (quota.error === error) return;
    this.options.quotas.put({ ...quota, error });
    this.options.onAccountsChanged();
  }

  private releasePacing(accountId: string, pacing: PacingFlight): void {
    if (this.pacingByAccount.get(accountId) === pacing)
      this.pacingByAccount.delete(accountId);
  }

  private adapter(provider: PoolProvider): ProviderAdapter {
    const adapter = this.options.adapters.get(provider);

    if (adapter === undefined)
      throw new Error(`Missing ${provider} Account Pooler adapter.`);

    return adapter;
  }

  private increment(accountId: string): void {
    this.inFlightByAccount.set(
      accountId,
      (this.inFlightByAccount.get(accountId) ?? 0) + 1,
    );
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.inFlightByAccount.get(accountId) ?? 1) - 1);

    if (next === 0) this.inFlightByAccount.delete(accountId);
    else this.inFlightByAccount.set(accountId, next);

    if (this.inFlightCount() !== 0) return;

    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private inFlightCount(): number {
    let total = 0;

    for (const count of this.inFlightByAccount.values()) total += count;

    return total;
  }
}

export function createHub(options: {
  telemetry?: PoolTelemetry;
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  hubTokens: HubTokenStore;
  getSettings: () => AccountPoolConfig;
  fetch?: typeof fetch;
  now?: () => number;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  drainTimeoutMs?: number;
  maxAffinityBindings?: number;
  getParentRoute?: () => ParentPool | null;
  onAccountsChanged?: () => void;
  onUpstreamError?: (provider: PoolProvider, error: unknown) => void;
  onUpstreamDiagnostic?: HubOptions["onUpstreamDiagnostic"];
  onOAuthRefresh?: HubOptions["onOAuthRefresh"];
}): AccountPoolHub {
  const adapters: ReadonlyMap<PoolProvider, ProviderAdapter> = new Map([
    ["claude", createClaudeAdapter()],
    [
      "codex",
      createCodexAdapter({
        refreshUrl: options.codexRefreshUrl ?? DEFAULT_CODEX_REFRESH_URL,
        usageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
        now: options.now,
      }),
    ],
  ]);

  return new AccountPoolHub({
    codexUsageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
    telemetry: options.telemetry,
    accounts: options.accounts,
    quotas: options.quotas,
    affinity: options.affinity,
    maxAffinityBindings: options.maxAffinityBindings ?? MAX_AFFINITY_BINDINGS,
    hubTokens: options.hubTokens,
    getSettings: options.getSettings,
    adapters,
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    drainTimeoutMs:
      options.drainTimeoutMs ?? DEFAULT_ACCOUNT_POOL_DRAIN_TIMEOUT_MS,
    getParentRoute: options.getParentRoute ?? (() => null),
    onAccountsChanged: options.onAccountsChanged ?? (() => {}),
    onUpstreamError: options.onUpstreamError ?? (() => {}),
    onUpstreamDiagnostic: options.onUpstreamDiagnostic ?? (() => {}),
    onOAuthRefresh: options.onOAuthRefresh ?? (() => {}),
  });
}

function readBearer(value: string | null): string | null {
  if (value === null) return null;

  return /^Bearer\s+(.+)$/iu.exec(value)?.[1] ?? null;
}

function accessTokenUnexpired(
  secret: Extract<AccountSecret, { kind: "oauth" }>,
  now: number,
): boolean {
  return secret.expiresAt === null || secret.expiresAt > now;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestedCodexServiceTier(tier: string | null): string | null {
  return tier === null || tier === "default" || tier === "auto"
    ? null
    : codexServiceTierId(tier);
}

function routingExclusions(
  accounts: readonly Account[],
  marked: ReadonlySet<string>,
): ReadonlySet<string> {
  return accounts.some((account) => account.enabled && !marked.has(account.id))
    ? marked
    : new Set();
}

function transientRetryDelay(
  retries: number,
  retryAfter: string | null,
  now: number,
): number | null {
  const backoffMs = TRANSIENT_RETRY_DELAYS_MS[retries];

  if (backoffMs === undefined) return null;

  const delayMs =
    retryAfter === null ? backoffMs : retryAfterMilliseconds(retryAfter, now);

  return delayMs <= MAX_INLINE_HOLD_MS ? delayMs : null;
}

function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);

    timeout.unref();

    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };

    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readCatalogText(
  response: Response,
  signal: AbortSignal,
): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > MAX_MODEL_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined);

        return null;
      }

      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
