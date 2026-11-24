import { describe, expect, it } from "vitest";
import { RELAY_RATE_LIMITS } from "./contracts.js";
import {
  IPV6_SITE_LIMIT_FACTOR,
  RATE_LIMIT_MAX_BUCKETS,
  createTokenBucketRateLimiter,
} from "./rate-limit.js";

const RULE = { limit: 3, periodMs: 60_000 };

async function exhaust(
  limiter: ReturnType<typeof createTokenBucketRateLimiter>,
  key: string,
): Promise<void> {
  for (let index = 0; index < RULE.limit; index += 1) {
    expect((await limiter.limit({ key })).success).toBe(true);
  }

  expect((await limiter.limit({ key })).success).toBe(false);
}

async function admitted(
  limiter: ReturnType<typeof createTokenBucketRateLimiter>,
  key: string,
): Promise<boolean> {
  return (await limiter.limit({ key })).success;
}

describe("token bucket rate limiter", () => {
  it("refuses a key past its limit and refills it over the period", async () => {
    let at = 0;
    const limiter = createTokenBucketRateLimiter(RULE, () => at);

    await exhaust(limiter, "203.0.113.1");
    at += RULE.periodMs / RULE.limit;

    expect(await admitted(limiter, "203.0.113.1")).toBe(true);
    expect(await admitted(limiter, "203.0.113.1")).toBe(false);
  });

  it("shares one bucket across an IPv6 /64 and keeps IPv4 addresses apart", async () => {
    const limiter = createTokenBucketRateLimiter(RULE, () => 0);

    await exhaust(limiter, "2001:db8:1:2::1");

    expect(await admitted(limiter, "2001:db8:1:2:ffff:ffff:ffff:fffe")).toBe(
      false,
    );
    expect(await admitted(limiter, "[2001:DB8:1:2::9]")).toBe(false);
    expect(await admitted(limiter, "2001:db8:1:3::1")).toBe(true);

    await exhaust(limiter, "198.51.100.7");

    expect(await admitted(limiter, "::ffff:198.51.100.7")).toBe(false);
    expect(await admitted(limiter, "198.51.100.8")).toBe(true);
  });

  it("keeps keys that are not addresses as they are", async () => {
    const limiter = createTokenBucketRateLimiter(RULE, () => 0);

    await exhaust(limiter, "sawyer");

    expect(await admitted(limiter, "sawyer-2")).toBe(true);
  });

  it("holds at most RATE_LIMIT_MAX_BUCKETS buckets and evicts the least recently used bucket that still has a token", async () => {
    const limiter = createTokenBucketRateLimiter(RULE, () => 0);

    expect(await admitted(limiter, "spare")).toBe(true);
    await exhaust(limiter, "kept");

    for (let index = 0; index < RATE_LIMIT_MAX_BUCKETS - 2; index += 1) {
      await limiter.limit({ key: `198.51.${index >> 8}.${index & 0xff}` });
    }

    expect(await admitted(limiter, "one-more")).toBe(true);
    expect(await admitted(limiter, "kept")).toBe(false);
    expect(await admitted(limiter, "spare")).toBe(true);
    expect(await admitted(limiter, "spare")).toBe(true);
    expect(await admitted(limiter, "spare")).toBe(true);
    expect(await admitted(limiter, "spare")).toBe(false);
  });

  it("never evicts an exhausted bucket and refuses a new key while only exhausted buckets remain", async () => {
    let at = 0;
    const limiter = createTokenBucketRateLimiter(RULE, () => at);

    await exhaust(limiter, "first");

    for (let index = 0; index < RATE_LIMIT_MAX_BUCKETS - 1; index += 1) {
      await exhaust(
        limiter,
        `10.${index >> 16}.${(index >> 8) & 0xff}.${index & 0xff}`,
      );
    }

    expect(await admitted(limiter, "newcomer")).toBe(false);
    expect(await admitted(limiter, "first")).toBe(false);

    at += RULE.periodMs;

    expect(await admitted(limiter, "newcomer")).toBe(true);
  });

  it("keeps an exhausted key refused while one attacker rotates RATE_LIMIT_MAX_BUCKETS /64s of one /48", async () => {
    const limiter = createTokenBucketRateLimiter(RULE, () => 0);

    await exhaust(limiter, "203.0.113.9");
    await exhaust(limiter, "2001:db8:aa:1::1");
    let admittedFromSite = 0;

    for (let index = 0; index < RATE_LIMIT_MAX_BUCKETS; index += 1) {
      if (await admitted(limiter, `2001:db8:bb:${index.toString(16)}::1`)) {
        admittedFromSite += 1;
      }
    }

    expect(admittedFromSite).toBe(RULE.limit * IPV6_SITE_LIMIT_FACTOR);
    expect(await admitted(limiter, "203.0.113.9")).toBe(false);
    expect(await admitted(limiter, "2001:db8:aa:1::1")).toBe(false);
    expect(await admitted(limiter, "2001:db8:aa:2::1")).toBe(true);
    expect(await admitted(limiter, "2001:db8:bb:ffff::1")).toBe(false);
  });

  it("does not spend a /48 token on a request its own /64 refuses", async () => {
    const limiter = createTokenBucketRateLimiter(RULE, () => 0);

    await exhaust(limiter, "2001:db8:cc:1::1");

    for (let index = 0; index < 100; index += 1) {
      expect(await admitted(limiter, "2001:db8:cc:1::1")).toBe(false);
    }

    let siblings = 0;

    for (let index = 2; index < 100; index += 1) {
      if (await admitted(limiter, `2001:db8:cc:${index.toString(16)}::1`)) {
        siblings += 1;
      }
    }

    expect(siblings).toBe(RULE.limit * (IPV6_SITE_LIMIT_FACTOR - 1));
  });

  it("keeps the cost of a check flat while 30,000 addresses are inside one refill window", async () => {
    const limiter = createTokenBucketRateLimiter(
      RELAY_RATE_LIMITS.failedBearer,
      () => 0,
    );

    for (let index = 0; index < 30_000; index += 1) {
      await limiter.limit({ key: `2001:db8:${index.toString(16)}::1` });
    }

    const startedAt = performance.now();

    for (let index = 0; index < 10_000; index += 1) {
      await limiter.limit({ key: `2001:db9:${index.toString(16)}::1` });
    }

    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
