import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { PluginKvStorage, PluginSecrets } from "@omnyo/plugin-sdk";
import {
  accountSchema,
  accountSecretSchema,
  CLAUDE_POOL_LOGIN_RETIRED,
  EMPTY_FAMILY_WEEKLY,
  isLegacyClaudeAccount,
  hubTokenSummarySchema,
  modelRejectionSchema,
  predictionRejectionSchema,
  providerSchema,
  quotaSchema,
  type Account,
  type AccountQuota,
  type AccountSecret,
  type HubTokenSummary,
  type ModelRejection,
  type PoolProvider,
  type PredictionRejection,
} from "./contracts.js";
import {
  modelCatalogSchema,
  type ModelCatalog,
  type ModelCatalogHeader,
} from "./model-catalog.js";

const ACCOUNTS_KEY = "accounts:v1";

const ACCOUNT_LAST_USED_PERSIST_MS = 60 * 1_000;

const accountsSchema = z.array(accountSchema);

const ACCOUNT_SECRETS_DIRECTORY = "accounts/";

const HUB_TOKEN_PREFIX = `${ACCOUNT_SECRETS_DIRECTORY}hub-token-`;

const HUB_TOKEN_GRACE_MS = 10 * 60 * 1_000;

const HUB_TOKEN_LAST_USED_PERSIST_MS = 60 * 1_000;

const REJECTED_REFRESH_PREFIX = "rejected-refresh:";

const rejectedRefreshSchema = z
  .object({
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    message: z.string(),
  })
  .strict();

interface RefreshRejection {
  message: string;
  sameToken: boolean;
}

function refreshTokenFingerprint(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

const tokenValueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

const priorHubTokenSchema = z
  .object({
    value: tokenValueSchema,
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

const storedHubTokenSchema = z
  .object({
    hostId: z.string().min(1),
    value: tokenValueSchema,
    mintedAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
    previous: z.array(priorHubTokenSchema),
  })
  .strict();

type StoredHubToken = z.infer<typeof storedHubTokenSchema>;

const routedThreadSchema = z
  .object({
    hostId: z.string().min(1),
    routedAt: z.number().int().nonnegative(),
  })
  .strict();

export type RoutedThread = z.infer<typeof routedThreadSchema> & {
  threadId: string;
};

export class AccountStore {
  private mutationLock: Promise<void> | null = null;

  constructor(
    private readonly kv: PluginKvStorage,
    private readonly secrets: PluginSecrets,
  ) {}

  async list(): Promise<Account[]> {
    const value = await this.kv.get(ACCOUNTS_KEY);

    if (value === undefined) return [];

    return accountsSchema.parse(value);
  }

  async listRoutable(): Promise<Account[]> {
    return (await this.list()).filter(
      (account) => !isLegacyClaudeAccount(account),
    );
  }

  async get(id: string): Promise<Account | null> {
    return (await this.list()).find((account) => account.id === id) ?? null;
  }

  async add(
    input: Omit<Account, "id" | "createdAt" | "lastUsedAt" | "lastUsedHostId">,
    secret: AccountSecret,
  ): Promise<Account> {
    return this.serialized(async () => {
      const account = accountSchema.parse({
        ...input,
        id: randomUUID(),
        createdAt: Date.now(),
        lastUsedAt: null,
        lastUsedHostId: null,
      });

      await this.storeSecret(account, secret);

      try {
        const accounts = await this.list();
        accounts.push(account);
        await this.kv.set(ACCOUNTS_KEY, accounts);
      } catch (error) {
        await this.secrets.delete(this.accountSecretName(account.id));
        throw error;
      }

      return account;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const next = accounts.filter((account) => account.id !== id);

      if (next.length === accounts.length) return false;
      await this.kv.set(ACCOUNTS_KEY, next);
      await this.secrets.delete(this.accountSecretName(id));
      await this.kv.delete(this.rejectedRefreshKey(id));

      return true;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<Account | null> {
    return this.update(id, (account) => {
      if (enabled && isLegacyClaudeAccount(account))
        throw new Error(CLAUDE_POOL_LOGIN_RETIRED);

      return { ...account, enabled };
    });
  }

  async setPriority(id: string, priority: number): Promise<Account | null> {
    return this.update(id, (account) => ({ ...account, priority }));
  }

  async setSubscriptionType(
    id: string,
    subscriptionType: string,
  ): Promise<Account | null> {
    return this.update(id, (account) => ({ ...account, subscriptionType }));
  }

  async reorder(provider: PoolProvider, accountIds: string[]): Promise<void> {
    return this.serialized(async () => {
      const accounts = await this.list();

      const current = accounts.filter(
        (account) => account.provider === provider,
      );

      const positions = new Map(accountIds.map((id, index) => [id, index]));

      if (
        positions.size !== accountIds.length ||
        current.length !== positions.size ||
        current.some((account) => !positions.has(account.id))
      ) {
        throw new Error(
          "Include every account for this provider exactly once. Refresh the account list and try again.",
        );
      }

      await this.kv.set(
        ACCOUNTS_KEY,
        accounts.map((account) => {
          const position = positions.get(account.id);

          return position === undefined
            ? account
            : { ...account, priority: position + 1 };
        }),
      );
    });
  }

  async recordUsed(
    id: string,
    lastUsedAt: number,
    lastUsedHostId: string,
  ): Promise<boolean> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const index = accounts.findIndex((account) => account.id === id);
      const current = accounts[index];

      if (index < 0 || current === undefined) return false;

      if (
        current.lastUsedAt !== null &&
        current.lastUsedHostId === lastUsedHostId &&
        lastUsedAt - current.lastUsedAt < ACCOUNT_LAST_USED_PERSIST_MS
      ) {
        return false;
      }

      accounts[index] = accountSchema.parse({
        ...current,
        lastUsedAt,
        lastUsedHostId,
      });
      await this.kv.set(ACCOUNTS_KEY, accounts);

      return true;
    });
  }

  async applyLogin(
    id: string,
    identity: Pick<
      Account,
      "email" | "accountUuid" | "subscriptionType" | "rateLimitTier"
    >,
  ): Promise<Account | null> {
    return this.update(id, (account) => ({
      ...account,
      email: identity.email ?? account.email,
      accountUuid: identity.accountUuid ?? account.accountUuid,
      subscriptionType: identity.subscriptionType ?? account.subscriptionType,
      rateLimitTier: identity.rateLimitTier ?? account.rateLimitTier,
    }));
  }

  private async update(
    id: string,
    change: (account: Account) => Account,
  ): Promise<Account | null> {
    return this.serialized(async () => {
      const accounts = await this.list();
      const index = accounts.findIndex((account) => account.id === id);
      const current = accounts[index];

      if (index < 0 || current === undefined) return null;
      const updated = accountSchema.parse(change(current));
      accounts[index] = updated;
      await this.kv.set(ACCOUNTS_KEY, accounts);

      return updated;
    });
  }

  async readSecret(account: Account): Promise<AccountSecret> {
    if (isLegacyClaudeAccount(account))
      throw new Error(CLAUDE_POOL_LOGIN_RETIRED);
    const { id } = account;
    const name = this.accountSecretName(id);
    const value = await this.secrets.get(name);

    if (value === undefined) {
      throw Object.assign(
        new Error(`ENOENT: no stored credentials for account ${id} (${name})`),
        { code: "ENOENT" },
      );
    }

    const secret = accountSecretSchema.parse(JSON.parse(value));

    if (secret.kind !== account.kind)
      throw new Error(`Stored credential type does not match account ${id}.`);

    return secret;
  }

  async writeSecret(id: string, secret: AccountSecret): Promise<void> {
    await this.serialized(async () => {
      const account = await this.get(id);

      if (account === null) throw new Error(`Account ${id} no longer exists.`);
      await this.storeSecret(account, secret);
    });
  }

  private async storeSecret(
    account: Account,
    secret: AccountSecret,
  ): Promise<void> {
    if (isLegacyClaudeAccount(account))
      throw new Error(CLAUDE_POOL_LOGIN_RETIRED);

    if (account.kind !== secret.kind)
      throw new Error(`Credential type does not match account ${account.id}.`);
    await this.secrets.set(
      this.accountSecretName(account.id),
      `${JSON.stringify(accountSecretSchema.parse(secret))}\n`,
    );
  }

  async rejectedRefresh(
    id: string,
    refreshToken: string,
  ): Promise<RefreshRejection | null> {
    const value = await this.kv.get(this.rejectedRefreshKey(id));

    if (value === undefined) return null;
    const rejected = rejectedRefreshSchema.parse(value);

    return {
      message: rejected.message,
      sameToken: rejected.fingerprint === refreshTokenFingerprint(refreshToken),
    };
  }

  async recordRejectedRefresh(
    id: string,
    refreshToken: string,
    message: string,
  ): Promise<void> {
    await this.serialized(async () => {
      if (!(await this.list()).some((account) => account.id === id)) return;
      await this.kv.set(this.rejectedRefreshKey(id), {
        fingerprint: refreshTokenFingerprint(refreshToken),
        message,
      });
    });
  }

  async clearRejectedRefresh(id: string): Promise<void> {
    await this.kv.delete(this.rejectedRefreshKey(id));
  }

  private rejectedRefreshKey(id: string): string {
    return `${REJECTED_REFRESH_PREFIX}${z.string().uuid().parse(id)}`;
  }

  private accountSecretName(id: string): string {
    return `${ACCOUNT_SECRETS_DIRECTORY}account-${z.string().uuid().parse(id)}.json`;
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutationLock ?? Promise.resolve();
    let release = () => {};

    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = previous.then(() => current);
    this.mutationLock = tail;
    await previous;

    try {
      return await action();
    } finally {
      release();

      if (this.mutationLock === tail) this.mutationLock = null;
    }
  }
}

export class HubTokenStore {
  private readonly hostLocks = new Map<string, Promise<void>>();
  private readonly tokens = new Map<string, StoredHubToken>();
  private readonly persistedLastUsedAt = new Map<string, number | null>();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly secrets: PluginSecrets,
    private readonly now: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    this.initialization ??= this.load();
    await this.initialization;
  }

  private async load(): Promise<void> {
    for (const name of await this.secrets.list(HUB_TOKEN_PREFIX)) {
      if (!name.endsWith(".json")) continue;
      const value = await this.secrets.get(name);

      if (value === undefined) continue;
      const token = storedHubTokenSchema.parse(JSON.parse(value));

      this.tokens.set(token.hostId, token);
      this.persistedLastUsedAt.set(token.hostId, token.lastUsedAt);
    }
  }

  async forHost(hostId: string): Promise<string> {
    await this.initialize();

    return this.serialized(hostId, async () => {
      const existing = this.read(hostId);

      if (existing !== null) return existing.value;
      const created = this.create(hostId);
      await this.write(hostId, created);

      return created.value;
    });
  }

  async rotate(hostId: string): Promise<HubTokenSummary> {
    await this.initialize();

    return this.serialized(hostId, async () => {
      const current = this.read(hostId);
      const now = this.now();
      const next = this.create(hostId);

      if (current !== null) {
        next.previous = [
          { value: current.value, expiresAt: now + HUB_TOKEN_GRACE_MS },
          ...current.previous.filter((token) => token.expiresAt > now),
        ];
      }

      await this.write(hostId, next);

      return this.summary(next);
    });
  }

  async authenticate(presented: string | null): Promise<string | null> {
    if (presented === null) return null;
    await this.initialize();
    const now = this.now();
    let matchedHostId: string | null = null;

    for (const token of this.readAll()) {
      if (matchesStoredToken(token, presented, now))
        matchedHostId = token.hostId;
    }

    if (matchedHostId === null) return null;

    return this.serialized(matchedHostId, async () => {
      const matched = this.read(matchedHostId);

      if (
        matched === null ||
        !matchesStoredToken(matched, presented, this.now())
      )
        return null;
      const usedAt = this.now();

      const next = storedHubTokenSchema.parse({
        ...matched,
        lastUsedAt: usedAt,
        previous: matched.previous.filter((token) => token.expiresAt > usedAt),
      });

      const persistedAt = this.persistedLastUsedAt.get(matched.hostId) ?? null;

      if (
        persistedAt === null ||
        usedAt - persistedAt >= HUB_TOKEN_LAST_USED_PERSIST_MS
      ) {
        await this.write(matched.hostId, next);
      } else {
        this.tokens.set(matched.hostId, next);
      }

      return matched.hostId;
    });
  }

  async list(): Promise<HubTokenSummary[]> {
    await this.initialize();

    return this.readAll()
      .map((token) => this.summary(token))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
  }

  async prune(hostIds: readonly string[]): Promise<void> {
    await this.initialize();
    const enrolled = new Set(hostIds);

    const stale = [...this.tokens.keys()].filter(
      (hostId) => !enrolled.has(hostId),
    );

    await Promise.all(
      stale.map((hostId) =>
        this.serialized(hostId, async () => {
          await this.secrets.delete(this.tokenName(hostId));
          this.tokens.delete(hostId);
          this.persistedLastUsedAt.delete(hostId);
        }),
      ),
    );
  }

  private create(hostId: string): StoredHubToken {
    return storedHubTokenSchema.parse({
      hostId,
      value: randomBytes(32).toString("base64url"),
      mintedAt: this.now(),
      lastUsedAt: null,
      previous: [],
    });
  }

  private summary(token: StoredHubToken): HubTokenSummary {
    return hubTokenSummarySchema.parse({
      hostId: token.hostId,
      hostName: null,
      mintedAt: token.mintedAt,
      lastUsedAt: token.lastUsedAt,
    });
  }

  private read(hostId: string): StoredHubToken | null {
    const token = this.tokens.get(hostId);

    if (token === undefined) return null;

    const previous = token.previous.filter(
      (candidate) => candidate.expiresAt > this.now(),
    );

    if (previous.length === token.previous.length) return token;
    const pruned = storedHubTokenSchema.parse({ ...token, previous });
    this.tokens.set(hostId, pruned);

    return pruned;
  }

  private readAll(): StoredHubToken[] {
    return [...this.tokens.keys()].flatMap((hostId) => {
      const token = this.read(hostId);

      return token === null ? [] : [token];
    });
  }

  private async write(hostId: string, token: StoredHubToken): Promise<void> {
    await this.initialize();
    await this.secrets.set(
      this.tokenName(hostId),
      `${JSON.stringify(storedHubTokenSchema.parse(token))}\n`,
    );
    this.tokens.set(hostId, token);
    this.persistedLastUsedAt.set(hostId, token.lastUsedAt);
  }

  private tokenName(hostId: string): string {
    const safeHostId = z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .parse(hostId);

    return `${HUB_TOKEN_PREFIX}${safeHostId}.json`;
  }

  private async serialized<T>(
    hostId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.hostLocks.get(hostId) ?? Promise.resolve();
    let release = () => {};

    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = previous.then(() => current);
    this.hostLocks.set(hostId, tail);
    await previous;

    try {
      return await action();
    } finally {
      release();

      if (this.hostLocks.get(hostId) === tail) this.hostLocks.delete(hostId);
    }
  }
}

function matchesStoredToken(
  token: StoredHubToken,
  presented: string,
  now: number,
): boolean {
  const currentMatches = safeTokenEqual(presented, token.value);
  let previousMatches = false;

  for (const previous of token.previous) {
    const equal = safeTokenEqual(presented, previous.value);

    if (previous.expiresAt > now && equal) previousMatches = true;
  }

  return currentMatches || previousMatches;
}

export class RoutingStore {
  constructor(
    private readonly kv: PluginKvStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async isBypassed(threadId: string): Promise<boolean> {
    return (await this.kv.get(this.bypassKey(threadId))) === true;
  }

  async isProviderEnabled(provider: PoolProvider): Promise<boolean> {
    return (await this.kv.get(`routing.${provider}`)) !== false;
  }

  async setProviderEnabled(
    provider: PoolProvider,
    enabled: boolean,
  ): Promise<void> {
    await this.kv.set(`routing.${provider}`, enabled);
  }

  async setBypassed(threadId: string, bypassed: boolean): Promise<void> {
    if (bypassed) await this.kv.set(this.bypassKey(threadId), true);
    else await this.kv.delete(this.bypassKey(threadId));
  }

  async recordRouted(threadId: string, hostId: string): Promise<void> {
    await this.kv.set(this.routedKey(threadId), {
      hostId,
      routedAt: this.now(),
    });
  }

  async listRoutedSince(cutoff: number): Promise<RoutedThread[]> {
    const routed: RoutedThread[] = [];

    for (const key of await this.kv.list("routed:")) {
      const value = routedThreadSchema.parse(await this.kv.get(key));

      if (value.routedAt < cutoff) {
        await this.kv.delete(key);
        continue;
      }

      routed.push({ threadId: key.slice("routed:".length), ...value });
    }

    return routed;
  }

  private bypassKey(threadId: string): string {
    return `bypass:${z.string().min(1).parse(threadId)}`;
  }

  private routedKey(threadId: string): string {
    return `routed:${z.string().min(1).parse(threadId)}`;
  }
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

const quotaRowSchema = z
  .object({
    account_id: z.string().uuid(),
    five_hour_utilization: z.number().nullable(),
    five_hour_reset_at: z.number().int().nullable(),
    five_hour_status: z.string().nullable(),
    seven_day_utilization: z.number().nullable(),
    seven_day_reset_at: z.number().int().nullable(),
    seven_day_status: z.string().nullable(),
    representative_claim: z.string().nullable(),
    bucket_exhaustion_json: z.string(),
    family_weekly_json: z.string(),
    limit_windows_json: z.string(),
    extra_usage_json: z.string(),
    usage_restriction_json: z.string(),
    observed_at: z.number().int().nullable(),
    held_until: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .strict();

const EMPTY_QUOTA = {
  usageRestriction: null,
  extraUsage: null,
  fiveHourUtilization: null,
  fiveHourResetAt: null,
  fiveHourStatus: null,
  sevenDayUtilization: null,
  sevenDayResetAt: null,
  sevenDayStatus: null,
  representativeClaim: null,
  familyWeekly: EMPTY_FAMILY_WEEKLY,
  limitWindows: [],
  observedAt: null,
  heldUntil: null,
  error: null,
};

export class QuotaStore {
  constructor(
    private readonly db: Database.Database,
    private readonly observe?: (quota: AccountQuota) => void,
  ) {}

  get(accountId: string): AccountQuota {
    const row = quotaRowSchema
      .optional()
      .parse(
        this.db
          .prepare("SELECT * FROM account_quota WHERE account_id = ?")
          .get(accountId),
      );

    if (row === undefined) {
      return quotaSchema.parse({ accountId, ...EMPTY_QUOTA });
    }

    return quotaSchema.parse({
      accountId: row.account_id,
      fiveHourUtilization: row.five_hour_utilization,
      fiveHourResetAt: row.five_hour_reset_at,
      fiveHourStatus: row.five_hour_status,
      sevenDayUtilization: row.seven_day_utilization,
      sevenDayResetAt: row.seven_day_reset_at,
      sevenDayStatus: row.seven_day_status,
      representativeClaim: row.representative_claim,
      familyWeekly: JSON.parse(row.family_weekly_json),
      limitWindows: JSON.parse(row.limit_windows_json),
      extraUsage: JSON.parse(row.extra_usage_json),
      usageRestriction: JSON.parse(row.usage_restriction_json),
      observedAt: row.observed_at,
      heldUntil: row.held_until,
      error: row.error,
    });
  }

  put(quota: AccountQuota): void {
    const value = quotaSchema.parse(quota);
    this.observe?.(value);
    this.db
      .prepare(
        `INSERT INTO account_quota (
          account_id, five_hour_utilization, five_hour_reset_at,
          five_hour_status, seven_day_utilization, seven_day_reset_at,
          seven_day_status, representative_claim, bucket_exhaustion_json,
          family_weekly_json, limit_windows_json, extra_usage_json, usage_restriction_json, observed_at, held_until, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          five_hour_utilization = excluded.five_hour_utilization,
          five_hour_reset_at = excluded.five_hour_reset_at,
          five_hour_status = excluded.five_hour_status,
          seven_day_utilization = excluded.seven_day_utilization,
          seven_day_reset_at = excluded.seven_day_reset_at,
          seven_day_status = excluded.seven_day_status,
          representative_claim = excluded.representative_claim,
          family_weekly_json = excluded.family_weekly_json,
          limit_windows_json = excluded.limit_windows_json,
          extra_usage_json = excluded.extra_usage_json,
          usage_restriction_json = excluded.usage_restriction_json,
          observed_at = excluded.observed_at,
          held_until = excluded.held_until,
          error = excluded.error`,
      )
      .run(
        value.accountId,
        value.fiveHourUtilization,
        value.fiveHourResetAt,
        value.fiveHourStatus,
        value.sevenDayUtilization,
        value.sevenDayResetAt,
        value.sevenDayStatus,
        value.representativeClaim,
        JSON.stringify(value.familyWeekly),
        JSON.stringify(value.limitWindows),
        JSON.stringify(value.extraUsage),
        JSON.stringify(value.usageRestriction),
        value.observedAt,
        value.heldUntil,
        value.error,
      );
  }

  modelRejections(accountId: string): ModelRejection[] {
    return this.parseModelRejections(
      this.db
        .prepare(
          "SELECT * FROM account_model_rejection WHERE account_id = ? ORDER BY model",
        )
        .all(accountId),
    );
  }

  modelRejectionsFor(model: string): ModelRejection[] {
    return this.parseModelRejections(
      this.db
        .prepare("SELECT * FROM account_model_rejection WHERE model = ?")
        .all(model),
    );
  }

  recordModelRejection(rejection: ModelRejection): void {
    const value = modelRejectionSchema.parse(rejection);
    this.db
      .prepare(
        `INSERT INTO account_model_rejection (account_id, model, plan, observed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, model) DO UPDATE SET
          plan = excluded.plan,
          observed_at = excluded.observed_at`,
      )
      .run(value.accountId, value.model, value.plan, value.observedAt);
  }

  clearModelRejection(accountId: string, model: string): void {
    this.db
      .prepare(
        "DELETE FROM account_model_rejection WHERE account_id = ? AND model = ?",
      )
      .run(accountId, model);
  }

  clearModelRejections(accountId: string): void {
    this.db
      .prepare("DELETE FROM account_model_rejection WHERE account_id = ?")
      .run(accountId);
  }

  predictionRejection(accountId: string): PredictionRejection | null {
    const row = predictionRejectionRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT * FROM account_prediction_rejection WHERE account_id = ?",
          )
          .get(accountId),
      );

    return row === undefined
      ? null
      : {
          accountId: row.account_id,
          plan: row.plan,
          observedAt: row.observed_at,
        };
  }

  recordPredictionRejection(rejection: PredictionRejection): void {
    const value = predictionRejectionSchema.parse(rejection);
    this.db
      .prepare(
        `INSERT INTO account_prediction_rejection (account_id, plan, observed_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          plan = excluded.plan,
          observed_at = excluded.observed_at`,
      )
      .run(value.accountId, value.plan, value.observedAt);
  }

  clearPredictionRejection(accountId: string): void {
    this.db
      .prepare("DELETE FROM account_prediction_rejection WHERE account_id = ?")
      .run(accountId);
  }

  modelCatalogHeader(
    accountId: string,
    clientVersion: string | null,
  ): ModelCatalogHeader | null {
    const row = modelCatalogRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT * FROM account_model_catalog WHERE account_id = ? AND client_version = ?",
          )
          .get(accountId, storedVersion(clientVersion)),
      );

    return row === undefined ? null : catalogHeader(row);
  }

  latestModelCatalogHeader(accountId: string): ModelCatalogHeader | null {
    const row = modelCatalogRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT * FROM account_model_catalog WHERE account_id = ? ORDER BY fetched_at DESC LIMIT 1",
          )
          .get(accountId),
      );

    return row === undefined ? null : catalogHeader(row);
  }

  modelCatalog(
    accountId: string,
    clientVersion: string | null,
  ): ModelCatalog | null {
    const header = this.modelCatalogHeader(accountId, clientVersion);

    if (header === null) return null;

    const rows = z
      .array(catalogModelRowSchema)
      .parse(
        this.db
          .prepare(
            "SELECT * FROM account_catalog_model WHERE account_id = ? AND client_version = ? ORDER BY position",
          )
          .all(accountId, storedVersion(clientVersion)),
      );

    return {
      ...header,
      models: rows.map((row) => ({
        slug: row.model,
        visibility: row.visibility,
        entry: z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(row.entry_json)),
      })),
    };
  }

  modelCatalogSlugs(accountId: string, clientVersion: string | null): string[] {
    return z
      .array(z.object({ model: z.string().min(1) }).strict())
      .parse(
        this.db
          .prepare(
            "SELECT model FROM account_catalog_model WHERE account_id = ? AND client_version = ? ORDER BY position",
          )
          .all(accountId, storedVersion(clientVersion)),
      )
      .map(({ model }) => model);
  }

  modelCatalogHeadersListing(model: string): ModelCatalogHeader[] {
    return z
      .array(modelCatalogRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT catalog.* FROM account_model_catalog AS catalog
            JOIN account_catalog_model AS entry
              ON entry.account_id = catalog.account_id
              AND entry.client_version = catalog.client_version
            WHERE entry.model = ?`,
          )
          .all(model),
      )
      .map(catalogHeader);
  }

  latestModelCatalogEntriesListing(
    model: string,
  ): Array<ModelCatalogHeader & { entry: Record<string, unknown> }> {
    return z
      .array(modelCatalogRowSchema.extend({ entry_json: z.string() }))
      .parse(
        this.db
          .prepare(
            `SELECT catalog.*, entry.entry_json FROM account_model_catalog AS catalog
        JOIN account_catalog_model AS entry
          ON entry.account_id = catalog.account_id
          AND entry.client_version = catalog.client_version
        WHERE entry.model = ? AND catalog.client_version = (
          SELECT latest.client_version FROM account_model_catalog AS latest
          WHERE latest.account_id = catalog.account_id
          ORDER BY latest.fetched_at DESC, latest.client_version DESC LIMIT 1
        )`,
          )
          .all(model),
      )
      .map((row) => ({
        ...catalogHeader(row),
        entry: z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(row.entry_json)),
      }));
  }

  modelCatalogHeaders(): ModelCatalogHeader[] {
    return z
      .array(modelCatalogRowSchema)
      .parse(this.db.prepare("SELECT * FROM account_model_catalog").all())
      .map(catalogHeader);
  }

  modelCatalogHeadersFor(accountId: string): ModelCatalogHeader[] {
    return z
      .array(modelCatalogRowSchema)
      .parse(
        this.db
          .prepare("SELECT * FROM account_model_catalog WHERE account_id = ?")
          .all(accountId),
      )
      .map(catalogHeader);
  }

  replaceModelCatalog(catalog: ModelCatalog): void {
    const value = modelCatalogSchema.parse(catalog);
    const version = storedVersion(value.clientVersion);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO account_model_catalog (account_id, client_version, plan, etag, fetched_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(account_id, client_version) DO UPDATE SET
            plan = excluded.plan,
            etag = excluded.etag,
            fetched_at = excluded.fetched_at`,
        )
        .run(value.accountId, version, value.plan, value.etag, value.fetchedAt);
      this.db
        .prepare(
          "DELETE FROM account_catalog_model WHERE account_id = ? AND client_version = ?",
        )
        .run(value.accountId, version);

      const insert = this.db.prepare(
        `INSERT INTO account_catalog_model (account_id, client_version, model, position, visibility, entry_json)
        VALUES (?, ?, ?, ?, ?, ?)`,
      );

      for (const [position, model] of value.models.entries())
        insert.run(
          value.accountId,
          version,
          model.slug,
          position,
          model.visibility,
          JSON.stringify(model.entry),
        );

      const retired = z
        .array(z.object({ client_version: z.string() }).strict())
        .parse(
          this.db
            .prepare(
              "SELECT client_version FROM account_model_catalog WHERE account_id = ? ORDER BY fetched_at DESC LIMIT -1 OFFSET ?",
            )
            .all(value.accountId, MAX_MODEL_CATALOG_VERSIONS),
        );

      for (const { client_version: retiredVersion } of retired) {
        this.db
          .prepare(
            "DELETE FROM account_catalog_model WHERE account_id = ? AND client_version = ?",
          )
          .run(value.accountId, retiredVersion);
        this.db
          .prepare(
            "DELETE FROM account_model_catalog WHERE account_id = ? AND client_version = ?",
          )
          .run(value.accountId, retiredVersion);
      }
    })();
  }

  clearModelCatalog(accountId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM account_catalog_model WHERE account_id = ?")
        .run(accountId);
      this.db
        .prepare("DELETE FROM account_model_catalog WHERE account_id = ?")
        .run(accountId);
    })();
  }

  remove(accountId: string): void {
    this.db
      .prepare("DELETE FROM account_quota WHERE account_id = ?")
      .run(accountId);
    this.clearModelRejections(accountId);
    this.clearPredictionRejection(accountId);
    this.clearModelCatalog(accountId);
  }

  private parseModelRejections(rows: unknown[]): ModelRejection[] {
    return z
      .array(modelRejectionRowSchema)
      .parse(rows)
      .map((row) => ({
        accountId: row.account_id,
        model: row.model,
        plan: row.plan,
        observedAt: row.observed_at,
      }));
  }
}

const modelRejectionRowSchema = z
  .object({
    account_id: z.string().uuid(),
    model: z.string().min(1),
    plan: z.string().nullable(),
    observed_at: z.number().int(),
  })
  .strict();

const predictionRejectionRowSchema = modelRejectionRowSchema
  .omit({ model: true })
  .strict();

const MAX_MODEL_CATALOG_VERSIONS = 3;

const storedVersion = (clientVersion: string | null) => clientVersion ?? "";

const modelCatalogRowSchema = z
  .object({
    account_id: z.string().uuid(),
    client_version: z.string(),
    plan: z.string().nullable(),
    etag: z.string().nullable(),
    fetched_at: z.number().int(),
  })
  .strict();

const catalogModelRowSchema = z
  .object({
    account_id: z.string().uuid(),
    client_version: z.string(),
    model: z.string().min(1),
    position: z.number().int().nonnegative(),
    visibility: z.string().nullable(),
    entry_json: z.string(),
  })
  .strict();

function catalogHeader(
  row: z.infer<typeof modelCatalogRowSchema>,
): ModelCatalogHeader {
  return {
    accountId: row.account_id,
    plan: row.plan,
    clientVersion: row.client_version === "" ? null : row.client_version,
    etag: row.etag,
    fetchedAt: row.fetched_at,
  };
}

const affinityRowSchema = z.object({
  affinity_key: z.string(),
  account_id: z.string().uuid(),
  last_used_at: z.number().int(),
});

const activeAccountRowSchema = z.object({
  provider: providerSchema,
  account_id: z.string().uuid(),
});

export interface AccountBinding {
  accountId: string;
  lastUsedAt: number;
}

export class PoolAffinityStore {
  constructor(private readonly db: Database.Database) {}

  loadBindings(since: number, limit: number): Map<string, AccountBinding> {
    this.db
      .prepare("DELETE FROM pool_affinity WHERE last_used_at <= ?")
      .run(since);
    this.db
      .prepare(
        `DELETE FROM pool_affinity WHERE affinity_key NOT IN (
        SELECT affinity_key FROM pool_affinity ORDER BY last_used_at DESC, rowid DESC LIMIT ?
      )`,
      )
      .run(limit);

    return new Map(
      z
        .array(affinityRowSchema)
        .parse(
          this.db
            .prepare("SELECT * FROM pool_affinity ORDER BY last_used_at, rowid")
            .all(),
        )
        .map((row) => [
          row.affinity_key,
          { accountId: row.account_id, lastUsedAt: row.last_used_at },
        ]),
    );
  }

  loadActiveAccounts(): Map<PoolProvider, { accountId: string }> {
    return new Map(
      z
        .array(activeAccountRowSchema)
        .parse(this.db.prepare("SELECT * FROM pool_active_account").all())
        .map((row) => [row.provider, { accountId: row.account_id }]),
    );
  }

  putBinding(key: string, binding: AccountBinding): void {
    this.db
      .prepare(
        `INSERT INTO pool_affinity (affinity_key, account_id, last_used_at) VALUES (?, ?, ?)
       ON CONFLICT(affinity_key) DO UPDATE SET account_id = excluded.account_id, last_used_at = excluded.last_used_at`,
      )
      .run(key, binding.accountId, binding.lastUsedAt);
  }

  removeBinding(key: string): void {
    this.db
      .prepare("DELETE FROM pool_affinity WHERE affinity_key = ?")
      .run(key);
  }

  putActiveAccount(provider: PoolProvider, accountId: string): void {
    this.db
      .prepare(
        `INSERT INTO pool_active_account (provider, account_id) VALUES (?, ?)
       ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id`,
      )
      .run(provider, accountId);
  }
}

export const QUOTA_MIGRATIONS = [
  `CREATE TABLE account_quota (
    account_id TEXT PRIMARY KEY,
    five_hour_utilization REAL,
    five_hour_reset_at INTEGER,
    five_hour_status TEXT,
    seven_day_utilization REAL,
    seven_day_reset_at INTEGER,
    seven_day_status TEXT,
    representative_claim TEXT,
    bucket_exhaustion_json TEXT NOT NULL DEFAULT '{}',
    observed_at INTEGER,
    held_until INTEGER,
    error TEXT
  )`,
  `ALTER TABLE account_quota ADD COLUMN family_weekly_json TEXT NOT NULL DEFAULT '{"fable":null,"sonnet":null,"opus":null,"haiku":null,"other":null}'`,
  `ALTER TABLE account_quota ADD COLUMN limit_windows_json TEXT NOT NULL DEFAULT '[]'`,
  `CREATE TABLE pool_affinity (
    affinity_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE TABLE pool_active_account (
    provider TEXT PRIMARY KEY,
    account_id TEXT NOT NULL
  )`,
  `ALTER TABLE account_quota ADD COLUMN extra_usage_json TEXT NOT NULL DEFAULT 'null'`,
  `ALTER TABLE account_quota ADD COLUMN usage_restriction_json TEXT NOT NULL DEFAULT 'null'`,
  `CREATE TABLE account_model_rejection (
    account_id TEXT NOT NULL,
    model TEXT NOT NULL,
    plan TEXT,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, model)
  )`,
  `CREATE TABLE account_prediction_rejection (
    account_id TEXT PRIMARY KEY,
    plan TEXT,
    observed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE account_model_catalog (
    account_id TEXT NOT NULL,
    client_version TEXT NOT NULL,
    plan TEXT,
    etag TEXT,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, client_version)
  );
  CREATE TABLE account_catalog_model (
    account_id TEXT NOT NULL,
    client_version TEXT NOT NULL,
    model TEXT NOT NULL,
    position INTEGER NOT NULL,
    visibility TEXT,
    entry_json TEXT NOT NULL,
    PRIMARY KEY (account_id, client_version, model)
  );
  CREATE INDEX account_catalog_model_by_model ON account_catalog_model (model)`,
];
