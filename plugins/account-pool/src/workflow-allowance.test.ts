import { describe, expect, it } from "vitest";
import { validatePooledWorkflowAllowance } from "./workflow-allowance.js";

const now = Date.now();

const account = {
  provider: "codex",
  subscriptionType: "promax",
  codexAccountId: "subscription",
} as const;

const codex = () => ({
  account_id: "subscription",
  plan_type: "promax",
  credits: { has_credits: false, unlimited: false, balance: "0" },
  spend_control: { reached: false },
  rate_limit_reached_type: null,
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 20, reset_at: now / 1000 + 3600 },
  },
});

const claude = () => ({
  seven_day: {
    utilization: 20,
    resets_at: new Date(now + 3600000).toISOString(),
  },
  extra_usage: { is_enabled: false, credits_can_pay: "no" },
});

describe("protected pooled workflow spend evidence", () => {
  it("accepts explicit included-only quota for the bound subscription", () => {
    expect(() =>
      validatePooledWorkflowAllowance(codex(), account, now),
    ).not.toThrow();
  });
  it.each([
    "missing-credit-flag",
    "missing-balance",
    "unknown-ordinary",
    "credits",
    "unlimited",
    "wrong-account",
    "exhausted",
  ])("rejects ambiguous or unsafe Codex evidence: %s", (kind) => {
    const data = codex();

    if (kind === "missing-credit-flag")
      Reflect.deleteProperty(data.credits, "has_credits");

    if (kind === "missing-balance")
      Reflect.deleteProperty(data.credits, "balance");

    if (kind === "unknown-ordinary")
      Reflect.deleteProperty(data.rate_limit, "allowed");

    if (kind === "credits") data.credits.has_credits = true;

    if (kind === "unlimited") data.credits.unlimited = true;

    if (kind === "wrong-account") data.account_id = "different";

    if (kind === "exhausted") data.rate_limit.limit_reached = true;
    expect(() => validatePooledWorkflowAllowance(data, account, now)).toThrow();
  });
  it("does not authorize a Claude workflow even with legacy allowance data", () => {
    expect(() =>
      validatePooledWorkflowAllowance(
        claude(),
        { provider: "claude", subscriptionType: "max" },
        now,
      ),
    ).toThrow(
      "Claude workflow steps cannot verify included-only usage through Claude Code.",
    );
  });
});
