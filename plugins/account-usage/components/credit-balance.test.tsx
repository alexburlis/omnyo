import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { accountRowSchema } from "../contract.ts";
import { CreditBalance } from "./credit-balance.tsx";

const now = 1_790_000_000_000;

function render(extraUsage: unknown) {
  const row = accountRowSchema.parse({
    id: "one",
    name: "One",
    plan: null,
    enabled: true,
    canResetCredits: false,
    canSignInAgain: true,
    status: "ready",
    statusLabel: "Ready",
    serving: "idle",
    resetAt: null,
    lastUsedAt: null,
    observedAt: now,
    stale: false,
    error: null,
    cells: [],
    extraUsage,
  });

  return renderToStaticMarkup(<CreditBalance row={row} now={now} />);
}

describe("account credit balances", () => {
  it("renders provider points including zero and fractional balances", () => {
    for (const amount of [0, 1250.5]) {
      expect(
        render({ observedAt: now, creditBalance: { unit: "points", amount } }),
      ).toContain(
        `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(amount)} points`,
      );
    }
  });
  it("renders the supplied currency without treating it as points", () => {
    const html = render({
      observedAt: now,
      creditBalance: { unit: "currency", amount: 12.5, currency: "EUR" },
    });

    expect(html).toContain("12.50");
    expect(html).toContain("€");
    expect(html).not.toContain("points");
  });
  it("distinguishes unlimited and unknown amounts from zero", () => {
    expect(render({ observedAt: now, unlimited: true })).toContain("Unlimited");
    expect(render({ observedAt: now, hasCredits: true })).toContain(
      "balance unknown",
    );
    expect(render({ observedAt: now, hasCredits: false })).toBe("");
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });
  it("shows a compact amount while keeping the exact balance readable", () => {
    const html = render({
      observedAt: now,
      creditBalance: { unit: "points", amount: 53_499.480526 },
    });

    const compact = new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 0,
    }).format(53_499.480526);

    const exact = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 8,
    }).format(53_499.480526);

    expect(html).toContain(`<span aria-hidden="true">${compact}</span>`);
    expect(html).toContain(`title="Credits · ${exact} points`);
    expect(html).toContain(
      `<span class="sr-only">Credits · ${exact} points</span>`,
    );
  });
  it("marks a balance stale using its own observation time", () => {
    expect(
      render({
        observedAt: now - 12 * 60_000,
        creditBalance: { unit: "points", amount: 100 },
      }),
    ).toContain(" · stale");
  });
  it("rejects invalid amounts and currency codes at the boundary", () => {
    for (const amount of [-1, Infinity, NaN])
      expect(() =>
        render({ observedAt: now, creditBalance: { unit: "points", amount } }),
      ).toThrow();
    expect(() =>
      render({
        observedAt: now,
        creditBalance: { unit: "currency", amount: 1, currency: "bogus" },
      }),
    ).toThrow();
  });
});
