import {
  RELAY_RATE_LIMITS,
  type RateLimiter,
  type RateLimitRule,
  type RelayRateLimitName,
  type RelayRateLimiters,
} from "./contracts.js";
import { clientAddressKey, clientSiteKey } from "./net/client-ip.js";

export const RATE_LIMIT_MAX_BUCKETS = 20_000;

export const IPV6_SITE_LIMIT_FACTOR = 8;

const EVICTION_SCAN_LIMIT = 64;

const FORGET_INTERVAL_MS = 1_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface BucketStore {
  available(key: string, at: number): number;
  record(key: string, at: number, consume: boolean): boolean;
}

function createBucketStore(rule: RateLimitRule): BucketStore {
  const refillPerMs = rule.limit / rule.periodMs;
  const buckets = new Map<string, Bucket>();
  let forgottenAt = Number.NEGATIVE_INFINITY;

  function refilled(bucket: Bucket, at: number): number {
    return Math.min(
      rule.limit,
      bucket.tokens + Math.max(0, at - bucket.updatedAt) * refillPerMs,
    );
  }

  function forgetRefilled(at: number): void {
    if (at - forgottenAt < FORGET_INTERVAL_MS) return;
    forgottenAt = at;

    for (const [key, bucket] of buckets) {
      if (at - bucket.updatedAt < rule.periodMs) return;
      buckets.delete(key);
    }
  }

  function makeRoom(at: number): boolean {
    if (buckets.size < RATE_LIMIT_MAX_BUCKETS) return true;
    let scanned = 0;

    for (const [key, bucket] of buckets) {
      if (scanned >= EVICTION_SCAN_LIMIT) return false;
      scanned += 1;

      if (refilled(bucket, at) >= 1) {
        buckets.delete(key);

        return true;
      }
    }

    return false;
  }

  return {
    available(key, at) {
      const bucket = buckets.get(key);

      return bucket === undefined ? rule.limit : refilled(bucket, at);
    },
    record(key, at, consume) {
      forgetRefilled(at);
      const existing = buckets.get(key);

      if (existing === undefined && !makeRoom(at)) return false;

      const tokens =
        existing === undefined ? rule.limit : refilled(existing, at);

      buckets.delete(key);
      buckets.set(key, {
        tokens: consume ? tokens - 1 : tokens,
        updatedAt: at,
      });

      return true;
    },
  };
}

export function createTokenBucketRateLimiter(
  rule: RateLimitRule,
  now: () => number = Date.now,
): RateLimiter {
  if (!Number.isInteger(rule.limit) || rule.limit < 1 || rule.periodMs <= 0) {
    throw new Error("A rate limit needs a positive integer limit and period");
  }

  const clients = createBucketStore(rule);

  const sites = createBucketStore({
    limit: rule.limit * IPV6_SITE_LIMIT_FACTOR,
    periodMs: rule.periodMs,
  });

  function take(key: string): boolean {
    const at = now();
    const clientKey = clientAddressKey(key);
    const siteKey = clientSiteKey(key);

    if (siteKey !== null && sites.available(siteKey, at) < 1) return false;
    const admitted = clients.available(clientKey, at) >= 1;

    if (!clients.record(clientKey, at, admitted) || !admitted) return false;

    return siteKey === null || sites.record(siteKey, at, true);
  }

  return {
    limit({ key }) {
      return Promise.resolve({ success: take(key) });
    },
  };
}

export function createRelayRateLimiters(
  now: () => number = Date.now,
): RelayRateLimiters {
  const limiter = (name: RelayRateLimitName) =>
    createTokenBucketRateLimiter(RELAY_RATE_LIMITS[name], now);

  return {
    signInStart: limiter("signInStart"),
    gateHandshake: limiter("gateHandshake"),
    linkStart: limiter("linkStart"),
    codeRedeem: limiter("codeRedeem"),
    tunnelDialPerLabel: limiter("tunnelDialPerLabel"),
    tunnelDialPerIp: limiter("tunnelDialPerIp"),
    failedBearer: limiter("failedBearer"),
    installerPerIp: limiter("installerPerIp"),
    previewPerIp: limiter("previewPerIp"),
  };
}
