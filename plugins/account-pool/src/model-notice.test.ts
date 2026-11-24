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
        0.98,
        NOW,
      ),
    ).toBeNull();
  });

  it("stays quiet when a backup account can serve and the primary is exhausted", () => {
    expect(
      poolModelNotice(
        [
          account("second@example.com", 2, "ready"),
          account("first@example.com", 1, "exhausted", NOW + 5 * HOUR),
        ],
        "codex",
        0.98,
        NOW,
      ),
    ).toBeNull();
  });

  it("reports the provider as used up until the earliest account returns", () => {
    expect(
      poolModelNotice(
        [
          account("first@example.com", 1, "exhausted", NOW + 9 * HOUR),
          account("second@example.com", 2, "exhausted", NOW + 3 * HOUR),
        ],
        "codex",
        0.98,
        NOW,
      ),
    ).toEqual({
      message: "OpenAI used up",
      detail: null,
      until: NOW + 3 * HOUR,
    });
  });

  it("reports an unavailable pool when the only ready account is disabled", () => {
    const disabled = {
      ...account("old@example.com", 0, "ready"),
      enabled: false,
    };

    expect(
      poolModelNotice(
        [
          disabled,
          account("first@example.com", 1, "error"),
          account("second@example.com", 2, "exhausted", NOW + HOUR),
        ],
        "codex",
        0.98,
        NOW,
      ),
    ).toEqual({
      message: "OpenAI accounts unavailable",
      detail: null,
      until: null,
    });
  });

  it("stays quiet when a held backup can serve and the primary has an error", () => {
    const first = account("first@example.com", 1, "error");
    const second = account("second@example.com", 2, "held");

    expect(poolModelNotice([first, second], "codex", 0.98, NOW)).toBeNull();
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
        0.98,
        NOW,
      ),
    ).toBeNull();
  });
});
