import { describe, expect, it } from "vitest";
import type { AccountSummary } from "./contracts.js";
import { poolModelNotice } from "./model-notice.js";

const NOW = 1_800_000_000_000;

const HOUR = 60 * 60 * 1000;

function account(
  label: string,
  priority: number,
  status: AccountSummary["status"],
  resetAt: number | null = null,
): AccountSummary {
  return {
    id: `00000000-0000-4000-8000-00000000000${priority}`,
    provider: "codex",
    kind: "oauth",
    label,
    email: null,
    accountUuid: null,
    subscriptionType: "pro",
    rateLimitTier: null,
    enabled: true,
    priority,
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
    limitWindows:
      status === "exhausted"
        ? [
            {
              slot: "primary",
              windowMinutes: 10080,
              utilization: 1,
              resetAt,
              status: "rejected",
              observedAt: NOW,
              source: "usage",
            },
          ]
        : [],
    observedAt: NOW,
    heldUntil: null,
    error: null,
    inFlight: 0,
    incompatibleModels: [],
    modelCatalog: null,
    composerPredictionsDisabled: null,
    status,
  };
}

describe("poolModelNotice", () => {
  it("says nothing while the first account serves", () => {
    expect(
      poolModelNotice(
        [
          account("first@example.com", 1, "ready"),
          account("second@example.com", 2, "exhausted", NOW + HOUR),
        ],
        "codex",
        null,
        0.98,
        NOW,
      ),
    ).toBeNull();
  });

  it("names the used-up first account, when it is back and the account in use", () => {
    expect(
      poolModelNotice(
        [
          account("second@example.com", 2, "ready"),
          account("first@example.com", 1, "exhausted", NOW + 5 * HOUR),
        ],
        "codex",
        null,
        0.98,
        NOW,
      ),
    ).toEqual({
      message: "first@ used up",
      detail: "Using second@",
      until: NOW + 5 * HOUR,
    });
  });

  it("reports the provider as used up until the earliest account returns", () => {
    expect(
      poolModelNotice(
        [
          account("first@example.com", 1, "exhausted", NOW + 9 * HOUR),
          account("second@example.com", 2, "exhausted", NOW + 3 * HOUR),
        ],
        "codex",
        null,
        0.98,
        NOW,
      ),
    ).toEqual({
      message: "OpenAI used up",
      detail: null,
      until: NOW + 3 * HOUR,
    });
  });

  it("skips disabled accounts and keeps a broken first account without a time", () => {
    const disabled = {
      ...account("old@example.com", 0, "ready"),
      enabled: false,
    };

    expect(
      poolModelNotice(
        [
          disabled,
          account("first@example.com", 1, "error"),
          account("second@example.com", 2, "ready"),
        ],
        "codex",
        null,
        0.98,
        NOW,
      ),
    ).toEqual({
      message: "first@ unavailable",
      detail: "Using second@",
      until: null,
    });
  });

  it("stays quiet during sticky rotation when both accounts are available", () => {
    const first = account("first@example.com", 1, "ready");
    const second = account("second@example.com", 2, "ready");

    expect(
      poolModelNotice([first, second], "codex", second.id, 0.98, NOW),
    ).toBeNull();
  });

  it("moves past a used-up active account the way the pool does", () => {
    const first = account("first@example.com", 1, "exhausted", NOW + 2 * HOUR);
    const second = account("second@example.com", 2, "exhausted", NOW + HOUR);
    const third = account("third@example.com", 3, "ready");

    expect(
      poolModelNotice([first, second, third], "codex", second.id, 0.98, NOW),
    ).toEqual({
      message: "first@ used up",
      detail: "Using third@",
      until: NOW + 2 * HOUR,
    });
  });

  it("ignores accounts of another provider", () => {
    const claude = {
      ...account("claude@example.com", 0, "exhausted", NOW + HOUR),
      provider: "claude" as const,
    };

    expect(
      poolModelNotice(
        [claude, account("first@example.com", 1, "ready")],
        "codex",
        null,
        0.98,
        NOW,
      ),
    ).toBeNull();
  });
});
