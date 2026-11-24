import { describe, expect, it } from "vitest";
import {
  validateNativeCodexAllowance,
  nativeWorkflowEligibility,
} from "./native-workflow-eligibility.js";

const now = 1_800_000_000_000;

function snapshot() {
  return {
    account: { account: { type: "chatgpt", planType: "promax" } },
    quota: {
      accountId: "same-account",
      ordinaryUsageAllowed: true,
      rateLimits: {
        planType: "promax",
        primary: {
          usedPercent: 63,
          resetsAt: now / 1000 + 3600,
          windowDurationMins: 10080,
        },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: "0" },
        spendControlReached: false,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    },
  };
}

describe("native Codex included-only allowance", () => {
  it("accepts a current personal subscription with no credit balance", () => {
    expect(() =>
      validateNativeCodexAllowance(snapshot(), "same-account", now),
    ).not.toThrow();
  });
  it("binds the snapshot to the account used for inference", () => {
    expect(() =>
      validateNativeCodexAllowance(snapshot(), "different-account", now),
    ).toThrow();
  });
  it.each([
    "paid",
    "unlimited",
    "unknown-balance",
    "exhausted",
    "stale",
    "blocked",
    "unknown",
    "api-key",
    "metered",
  ])("rejects %s", (kind) => {
    const value = snapshot();

    if (kind === "paid") value.quota.rateLimits.credits.hasCredits = true;

    if (kind === "unlimited") value.quota.rateLimits.credits.unlimited = true;

    if (kind === "unknown-balance")
      value.quota.rateLimits.credits.balance = "unknown";

    if (kind === "exhausted") value.quota.rateLimits.primary.usedPercent = 100;

    if (kind === "stale")
      value.quota.rateLimits.primary.resetsAt = now / 1000 - 1;

    if (kind === "blocked") value.quota.ordinaryUsageAllowed = false;

    if (kind === "unknown")
      Reflect.deleteProperty(value.quota, "ordinaryUsageAllowed");

    if (kind === "api-key") value.account.account.type = "apiKey";

    if (kind === "metered")
      value.account.account.planType = "business_usage_based";
    expect(() =>
      validateNativeCodexAllowance(value, "same-account", now),
    ).toThrow();
  });
});

it("reports Claude workflow as unavailable without native allowance probing", async () => {
  await expect(
    nativeWorkflowEligibility(
      { providerId: "claude-code", model: "claude-sonnet-4-6" },
      new AbortController().signal,
    ),
  ).resolves.toEqual({
    available: false,
    code: "allowance_unavailable",
    message:
      "Claude workflow steps cannot verify included-only usage through Claude Code.",
  });
});
