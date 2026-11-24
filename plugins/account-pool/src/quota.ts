import type {
  Account,
  AccountQuota,
  AccountSummary,
  FamilyQuota,
  LimitWindow,
  ModelFamily,
} from "./contracts.js";

const PREFIX = "anthropic-ratelimit-unified-";

const SCOPED_HEADER =
  /^anthropic-ratelimit-unified-7d_(.+)-(utilization|reset|status)$/u;

interface ScopedHeaderValues {
  utilization: number | null;
  resetAt: number | null;
  status: string | null;
}

function parseNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

export function epochMilliseconds(value: number): number {
  return Math.round(value < 1_000_000_000_000 ? value * 1_000 : value);
}

export function parseReset(value: string | number | null): number | null {
  if (value === null) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;

    return epochMilliseconds(value);
  }

  if (value.trim() === "") return null;
  const numeric = Number(value);

  if (Number.isFinite(numeric)) return epochMilliseconds(numeric);
  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : parsed;
}

export function modelFamily(model: string | null): ModelFamily {
  if (model === null) return "other";
  const normalized = model.toLowerCase();

  if (normalized.includes("fable")) return "fable";

  if (normalized.includes("sonnet")) return "sonnet";

  if (normalized.includes("opus")) return "opus";

  if (normalized.includes("haiku")) return "haiku";

  return "other";
}

function scopedHeaderValues(headers: Headers): ScopedHeaderValues | null {
  const buckets = new Map<string, ScopedHeaderValues>();

  for (const [name, value] of headers) {
    const match = SCOPED_HEADER.exec(name.toLowerCase());
    const bucket = match?.[1];
    const field = match?.[2];

    if (bucket === undefined || field === undefined) continue;

    const current = buckets.get(bucket) ?? {
      utilization: null,
      resetAt: null,
      status: null,
    };

    if (field === "utilization") current.utilization = parseNumber(value);

    if (field === "reset") current.resetAt = parseReset(value);

    if (field === "status") current.status = value;
    buckets.set(bucket, current);
  }

  return [...buckets.values()][0] ?? null;
}

export function quotaFromHeaders(
  accountId: string,
  headers: Headers,
  previous: AccountQuota,
  family: ModelFamily,
  now: number,
): AccountQuota {
  const fiveHourUtilization = parseNumber(
    headers.get(`${PREFIX}5h-utilization`),
  );

  const fiveHourResetAt = parseReset(headers.get(`${PREFIX}5h-reset`));
  const fiveHourStatus = headers.get(`${PREFIX}5h-status`);

  const sevenDayUtilization = parseNumber(
    headers.get(`${PREFIX}7d-utilization`),
  );

  const sevenDayResetAt = parseReset(headers.get(`${PREFIX}7d-reset`));
  const sevenDayStatus = headers.get(`${PREFIX}7d-status`);
  const representativeClaim = headers.get(`${PREFIX}representative-claim`);
  const overageStatus = headers.get(`${PREFIX}overage-status`);

  const extraUsage: AccountQuota["extraUsage"] =
    overageStatus === "allowed" ||
    overageStatus === "allowed_warning" ||
    overageStatus === "rejected"
      ? {
          status: overageStatus === "rejected" ? "rejected" : "allowed",
          hasCredits: null,
          unlimited: null,
          observedAt: now,
          source: "header",
        }
      : previous.extraUsage;

  const scoped = scopedHeaderValues(headers);
  const priorFamily = previous.familyWeekly[family];

  const familyWeekly: AccountQuota["familyWeekly"] =
    scoped === null
      ? previous.familyWeekly
      : {
          ...previous.familyWeekly,
          [family]: {
            utilization: scoped.utilization ?? priorFamily?.utilization ?? null,
            resetAt: scoped.resetAt ?? priorFamily?.resetAt ?? null,
            status: scoped.status ?? priorFamily?.status ?? null,
            observedAt: now,
            source: "header",
          },
        };

  const observed =
    fiveHourUtilization !== null ||
    fiveHourResetAt !== null ||
    fiveHourStatus !== null ||
    sevenDayUtilization !== null ||
    sevenDayResetAt !== null ||
    sevenDayStatus !== null ||
    representativeClaim !== null ||
    extraUsage !== previous.extraUsage ||
    scoped !== null;

  return {
    accountId,
    usageRestriction: previous.usageRestriction,
    extraUsage,
    fiveHourUtilization: fiveHourUtilization ?? previous.fiveHourUtilization,
    fiveHourResetAt: fiveHourResetAt ?? previous.fiveHourResetAt,
    fiveHourStatus: fiveHourStatus ?? previous.fiveHourStatus,
    sevenDayUtilization: sevenDayUtilization ?? previous.sevenDayUtilization,
    sevenDayResetAt: sevenDayResetAt ?? previous.sevenDayResetAt,
    sevenDayStatus: sevenDayStatus ?? previous.sevenDayStatus,
    representativeClaim: representativeClaim ?? previous.representativeClaim,
    familyWeekly,
    limitWindows: previous.limitWindows,
    observedAt: observed ? now : previous.observedAt,
    heldUntil: previous.heldUntil,
    error: previous.error,
  };
}

interface QuotaWindow {
  utilization: number | null;
  status: string | null;
  resetAt: number | null;
}

function quotaWindows(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
): QuotaWindow[] {
  const familyQuota = family === null ? null : quota.familyWeekly[family];

  return [
    {
      utilization: quota.fiveHourUtilization,
      status: quota.fiveHourStatus,
      resetAt: quota.fiveHourResetAt,
    },
    {
      utilization: quota.sevenDayUtilization,
      status: quota.sevenDayStatus,
      resetAt: quota.sevenDayResetAt,
    },
    ...quota.limitWindows,
    ...(familyQuota === null ? [] : [familyQuota]),
  ];
}

function isBlockedUpstream(window: QuotaWindow, now: number): boolean {
  if (window.resetAt !== null && window.resetAt <= now) return false;
  const status = window.status?.toLowerCase() ?? null;

  if (status !== null) return status === "rejected";

  return window.utilization !== null && window.utilization >= 1;
}

const PAID_ROUTE_RANK = 2;

function activeOverage(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
  now: number,
): { resetAt: number | null } | null {
  if (quota.representativeClaim?.toLowerCase() !== "overage") return null;
  const resetAt = governingWeeklyResetAt(quota, family);

  if (
    resetAt !== null &&
    resetAt <= now &&
    quota.observedAt !== null &&
    quota.observedAt < resetAt
  )
    return null;

  return { resetAt: resetAt !== null && resetAt > now ? resetAt : null };
}

export function routeRank(
  account: Pick<Account, "enabled" | "kind">,
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
  threshold: number,
  now: number,
): number | null {
  if (!account.enabled || quota.error !== null || isUsageRestricted(quota, now))
    return null;
  const windows = quotaWindows(quota, family);
  const blocked = windows.some((window) => isBlockedUpstream(window, now));

  const reserved = windows.some((window) =>
    activeWindow(
      window.utilization,
      window.status,
      window.resetAt,
      threshold,
      now,
    ),
  );

  const overage = activeOverage(quota, family, now);

  if ((reserved || overage !== null) && !hasExtraUsage(quota)) return null;

  return (
    (reserved || overage !== null || account.kind === "api-key"
      ? PAID_ROUTE_RANK
      : 0) + (blocked ? 1 : 0)
  );
}

export function isSubscriptionRank(rank: number): boolean {
  return rank < PAID_ROUTE_RANK;
}

export function rejoinAt(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
  threshold: number,
  now: number,
): number | null {
  if (isUsageRestricted(quota, now))
    return quota.usageRestriction?.resetAt ?? null;
  let latest = now;
  const overage = activeOverage(quota, family, now);

  if (overage !== null && !hasExtraUsage(quota)) {
    if (overage.resetAt === null) return null;
    latest = overage.resetAt;
  }

  for (const window of quotaWindows(quota, family)) {
    if (
      !activeWindow(
        window.utilization,
        window.status,
        window.resetAt,
        threshold,
        now,
      )
    )
      continue;

    if (window.resetAt === null) return null;
    latest = Math.max(latest, window.resetAt);
  }

  return latest;
}

function activeWindow(
  utilization: number | null,
  status: string | null,
  resetAt: number | null,
  threshold: number,
  now: number,
): boolean {
  if (resetAt !== null && resetAt <= now) return false;

  return (
    status?.toLowerCase() === "rejected" ||
    (utilization !== null && utilization >= threshold)
  );
}

function activeFamilyWindow(
  quota: FamilyQuota | null,
  threshold: number,
  now: number,
): boolean {
  return (
    quota !== null &&
    activeWindow(quota.utilization, quota.status, quota.resetAt, threshold, now)
  );
}

export function blockingResetAt(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
  threshold: number,
  now: number,
): number | null {
  if (isUsageRestricted(quota, now))
    return quota.usageRestriction?.resetAt ?? null;
  let latest: number | null = null;
  let unknown = false;

  const include = (
    utilization: number | null,
    status: string | null,
    resetAt: number | null,
  ) => {
    if (!activeWindow(utilization, status, resetAt, threshold, now)) return;

    if (resetAt === null) unknown = true;
    else latest = Math.max(latest ?? resetAt, resetAt);
  };

  include(
    quota.fiveHourUtilization,
    quota.fiveHourStatus,
    quota.fiveHourResetAt,
  );
  include(
    quota.sevenDayUtilization,
    quota.sevenDayStatus,
    quota.sevenDayResetAt,
  );

  for (const window of quota.limitWindows)
    include(window.utilization, window.status, window.resetAt);

  if (family !== null) {
    const familyQuota = quota.familyWeekly[family];

    if (familyQuota !== null)
      include(familyQuota.utilization, familyQuota.status, familyQuota.resetAt);
  }

  return unknown ? null : latest;
}

export function isSharedQuotaExhausted(
  quota: AccountQuota,
  threshold: number,
  now: number,
): boolean {
  return (
    activeWindow(
      quota.fiveHourUtilization,
      quota.fiveHourStatus,
      quota.fiveHourResetAt,
      threshold,
      now,
    ) ||
    activeWindow(
      quota.sevenDayUtilization,
      quota.sevenDayStatus,
      quota.sevenDayResetAt,
      threshold,
      now,
    ) ||
    quota.limitWindows.some((window) =>
      activeWindow(
        window.utilization,
        window.status,
        window.resetAt,
        threshold,
        now,
      ),
    )
  );
}

export function longestLimitWindow(
  windows: readonly LimitWindow[],
): LimitWindow | null {
  let longest: LimitWindow | null = null;

  for (const window of windows) {
    if (
      longest === null ||
      (window.windowMinutes ?? 0) > (longest.windowMinutes ?? 0)
    )
      longest = window;
  }

  return longest;
}

export function isQuotaExhausted(
  quota: AccountQuota,
  family: ModelFamily,
  threshold: number,
  now: number,
): boolean {
  return (
    isUsageRestricted(quota, now) ||
    isSharedQuotaExhausted(quota, threshold, now) ||
    activeFamilyWindow(quota.familyWeekly[family], threshold, now)
  );
}

export function isUsageRestricted(
  quota: AccountQuota | AccountSummary,
  now: number,
): boolean {
  return (
    quota.usageRestriction !== null &&
    (quota.usageRestriction.resetAt === null ||
      quota.usageRestriction.resetAt > now)
  );
}

export function hasExtraUsage(quota: AccountQuota | AccountSummary): boolean {
  return (
    quota.extraUsage?.status === "allowed" && quota.usageRestriction === null
  );
}

export function isQuotaRejection(headers: Headers): boolean {
  for (const [name, value] of headers) {
    if (value.toLowerCase() !== "rejected") continue;
    const normalized = name.toLowerCase();

    if (
      normalized === `${PREFIX}5h-status` ||
      normalized === `${PREFIX}7d-status` ||
      SCOPED_HEADER.test(normalized)
    )
      return true;
  }

  return false;
}

export function governingWeeklyResetAt(
  quota: AccountQuota | AccountSummary,
  family: ModelFamily | null,
): number | null {
  return (
    (family === null ? null : quota.familyWeekly[family]?.resetAt) ??
    quota.sevenDayResetAt ??
    longestLimitWindow(quota.limitWindows)?.resetAt ??
    null
  );
}

export function accountStatus(
  account: Account,
  quota: AccountQuota,
  threshold: number,
  now: number,
): AccountSummary["status"] {
  if (!account.enabled) return "disabled";

  if (quota.error !== null) return "error";

  if (quota.heldUntil !== null && quota.heldUntil > now) return "held";

  if (isUsageRestricted(quota, now)) return "exhausted";

  if (routeRank(account, quota, null, threshold, now) === null)
    return "exhausted";

  return "ready";
}

export function retryAfterMilliseconds(
  value: string | null,
  now: number,
): number {
  if (value === null) return 1_000;
  const seconds = Number(value);

  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);

  return Number.isNaN(date) ? 1_000 : Math.max(0, date - now);
}
