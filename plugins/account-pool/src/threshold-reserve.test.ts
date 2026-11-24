import { describe, expect, it } from "vitest";
import type { AccountSummary } from "./contracts.js";
import { isSubscriptionRank, rejoinAt, routeRank } from "./quota.js";

const NOW = 1_800_000_000_000;

const HOUR = 60 * 60 * 1000;

const THRESHOLD = 0.98;

function account(
  utilization: number,
  overrides: Partial<AccountSummary> = {},
): AccountSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    provider: "codex",
    kind: "oauth",
    label: "first@example.com",
    email: null,
    accountUuid: null,
    subscriptionType: "plus",
    rateLimitTier: null,
    enabled: true,
    priority: 1,
    createdAt: 0,
    lastUsedAt: null,
    lastUsedHostId: null,
    lastUsedHostName: null,
    usageRestriction: null,
    extraUsage: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [
      {
        slot: "primary",
        windowMinutes: 300,
        utilization,
        resetAt: NOW + HOUR,
        status: utilization >= 1 ? "rejected" : "allowed",
        observedAt: NOW,
        source: "usage",
      },
    ],
    observedAt: NOW,
    heldUntil: null,
    error: null,
    inFlight: 0,
    incompatibleModels: [],
    composerPredictionsDisabled: null,
    modelCatalog: null,
    status: "ready",
    ...overrides,
  };
}

const credits: AccountSummary["extraUsage"] = {
  status: "allowed",
  hasCredits: true,
  unlimited: false,
  creditBalance: { unit: "points", amount: 1000 },
  observedAt: NOW,
  source: "usage",
};

const rank = (summary: AccountSummary) =>
  routeRank(summary, summary, null, THRESHOLD, NOW);

describe("switch threshold reserve", () => {
  it("serves included allowance below the threshold", () => {
    expect(rank(account(0.5))).toBe(0);
  });

  it.each([0.98, 0.99])(
    "keeps the last allowance in reserve at %d when no credits are available",
    (utilization) => {
      expect(rank(account(utilization))).toBeNull();
      expect(rejoinAt(account(utilization), null, THRESHOLD, NOW)).toBe(
        NOW + HOUR,
      );
    },
  );

  it.each([0.99, 1])(
    "routes an account at %d with credits only as paid fallback",
    (utilization) => {
      const value = rank(account(utilization, { extraUsage: credits }));

      expect(value).not.toBeNull();
      expect(isSubscriptionRank(value ?? 0)).toBe(false);
    },
  );

  it("prefers an account that reached the reserve over one upstream rejected", () => {
    const reserved = rank(account(0.99, { extraUsage: credits }));
    const rejected = rank(account(1, { extraUsage: credits }));

    expect(reserved).not.toBeNull();
    expect(rejected).not.toBeNull();
    expect(reserved ?? 0).toBeLessThan(rejected ?? 0);
  });

  it("ranks an API key below any subscription with allowance", () => {
    expect(rank(account(0.1, { kind: "api-key" }))).toBeGreaterThan(
      rank(account(0.9)) ?? Infinity,
    );
  });
});
