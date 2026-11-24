// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type RenderedSlot,
} from "@omnyo/plugin-sdk/testing/app";
import type { ExperimentalSidebarFooterCardProps } from "@omnyo/plugin-sdk/app";
import {
  USAGE_CHANGED_CHANNEL,
  type Group,
  type Snapshot,
  type WeeklyBar,
} from "../contract.ts";

const app = await loadPluginApp(() => import("../app.tsx"));

const mounts: RenderedSlot[] = [];

function group(provider: "claude" | "codex", remaining = 75): Group {
  return {
    providerId: provider,
    poolProvider: provider,
    routingEnabled: true,
    readyCount: 1,
    totalCount: 1,
    nextCapacityAt: null,
    columns: [],
    accounts: [
      {
        id: provider,
        name: `${provider} work`,
        plan: null,
        enabled: true,
        canResetCredits: false,
        canSignInAgain: true,
        status: "ready",
        statusLabel: "Ready",
        serving: "idle",
        resetAt: Date.now() + 86_400_000,
        lastUsedAt: null,
        observedAt: Date.now(),
        stale: false,
        error: null,
        cells: [],
      },
    ],
    weeklyBars: [
      {
        accountId: provider,
        name: `${provider} work`,
        plan: null,
        remainingPercent: remaining,
        resetAt: Date.now() + 86_400_000,
        windowMinutes: 10_080,
        status: "ready",
        serving: "idle",
        fiveHourWarning: null,
        credits: null,
      },
    ],
  };
}

function snapshot(groups = [group("claude"), group("codex", 40)]): Snapshot {
  return { fetchedAt: Date.now(), error: null, poolUnavailable: false, groups };
}

function mount(
  read: () => Snapshot | Promise<Snapshot>,
  props: ExperimentalSidebarFooterCardProps = {},
  refresh?: () => Snapshot | Promise<Snapshot>,
) {
  const registration = app.sidebarFooterCards.find(
    (card) => card.id === "usage",
  );

  if (!registration)
    throw new Error("Account usage has no always-visible rail contribution");

  const mounted = renderSlot(registration, props, {
    pluginId: "omnyo--account-usage",
    rpc: { snapshot: read, ...(refresh === undefined ? {} : { refresh }) },
  });

  mounts.push(mounted);

  return mounted;
}

afterEach(() => {
  for (const mounted of mounts.splice(0)) mounted.lifecycle.unmount();
  cleanup();
  vi.useRealTimers();
});

function rings(trigger: HTMLElement) {
  return trigger.querySelector('[data-usage-layout="rings"]')?.textContent;
}

function ring(trigger: HTMLElement, provider: string): HTMLElement {
  const element = trigger.querySelector<HTMLElement>(
    `[data-usage-ring="${provider}"]`,
  );

  if (element === null) throw new Error(`${provider} has no usage ring`);

  return element;
}

describe("live usage in the navigation rail", () => {
  it("shows every provider's bars and reset details without opening a page", async () => {
    const mounted = mount(() => snapshot());

    const claude = await mounted.findByRole("img", {
      name: /claude.*work.*75%/i,
    });

    expect(claude.getAttribute("aria-label")).toMatch(/resets/i);
    expect(within(claude).getByText("75")).toBeDefined();

    const codex = await mounted.findByRole("img", {
      name: /codex.*work.*40%/i,
    });

    expect(within(codex).getByText("40")).toBeDefined();
    expect(mounted.inspection.navigateCalls).toEqual([]);
  });

  it("replaces readings on live updates and refreshes after reconnecting", async () => {
    let current = snapshot();
    const mounted = mount(() => current);
    await mounted.findByRole("img", { name: /claude.*75%/i });
    current = snapshot([group("claude", 30)]);
    await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
    await mounted.findByRole("img", { name: /claude.*30%/i });
    await mounted.behavior.setRealtimeConnectionState("reconnecting");
    expect(mounted.getByText(/offline/i)).toBeDefined();
    expect(mounted.getByRole("img", { name: /claude.*30%/i })).toBeDefined();
    current = snapshot([group("claude", 20)]);
    await mounted.behavior.setRealtimeConnectionState("connected");
    await mounted.findByRole("img", { name: /claude.*20%/i });
  });

  it("keeps the last reading visible and labels it stale when a read fails", async () => {
    let failed = false;

    const mounted = mount(() => {
      if (failed) throw new Error("Usage service unavailable");

      return snapshot();
    });

    await mounted.findByRole("img", { name: /claude.*75%/i });
    failed = true;
    await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
    await mounted.findByRole("status", { name: /stale/i });
    expect(mounted.getByRole("img", { name: /claude.*75%/i })).toBeDefined();
    failed = false;
    await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
    await mounted.findByRole("img", { name: /claude.*75%/i });
    expect(mounted.queryByRole("status")).toBeNull();
  });

  it("coalesces concurrent read requests and cancels retry work after unmount", async () => {
    vi.useFakeTimers();
    let release: ((reading: Snapshot) => void) | undefined;

    const pending = new Promise<Snapshot>((resolve) => {
      release = resolve;
    });

    const mounted = mount(() => pending);
    await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
    await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
    expect(mounted.inspection.rpcCalls).toHaveLength(1);
    await act(async () =>
      release?.({ ...snapshot([]), error: "fetch failed" }),
    );
    expect(mounted.getByRole("status", { name: /unavailable/i })).toBeDefined();
    mounted.lifecycle.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(mounted.inspection.rpcCalls).toHaveLength(1);
  });

  it("retries failed reads promptly and stops retrying after recovery", async () => {
    vi.useFakeTimers();
    let failed = false;

    const mounted = mount(() => {
      if (failed) throw new Error("fetch failed");

      return snapshot([group("claude", 60)]);
    });

    await act(async () => {});
    expect(mounted.getByRole("img", { name: /claude.*60%/i })).toBeDefined();
    failed = true;
    await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
    expect(mounted.getByRole("status", { name: /stale/i })).toBeDefined();
    expect(mounted.inspection.rpcCalls).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(mounted.inspection.rpcCalls).toHaveLength(2);
    failed = false;
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mounted.inspection.rpcCalls).toHaveLength(3);
    expect(mounted.queryByRole("status")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(7_000));
    expect(mounted.inspection.rpcCalls).toHaveLength(3);
  });

  it("bounds automatic retries to reads before returning to normal polling", async () => {
    vi.useFakeTimers();

    const mounted = mount(() => {
      throw new Error("fetch failed");
    });

    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mounted.inspection.rpcCalls).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(mounted.inspection.rpcCalls).toHaveLength(3);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(mounted.inspection.rpcCalls).toHaveLength(4);
    await act(async () => vi.advanceTimersByTimeAsync(22_999));
    expect(mounted.inspection.rpcCalls.map((call) => call.method)).toEqual([
      "snapshot",
      "snapshot",
      "snapshot",
      "snapshot",
    ]);
  });

  it.each([true, false])(
    "removes the card after an authoritative empty pool response, disabled=%s",
    async (poolUnavailable) => {
      let current = snapshot();
      const mounted = mount(() => current);
      await mounted.findByRole("img", { name: /claude.*75%/i });
      current = { ...snapshot([]), poolUnavailable };
      await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
      expect(mounted.container.innerHTML).toBe("");
    },
  );

  it.each([
    {
      name: "disabled pool",
      reading: { ...snapshot([]), poolUnavailable: true },
    },
    { name: "empty pool", reading: snapshot([]) },
  ])("renders no card for a $name", async ({ reading }) => {
    const mounted = mount(() => reading);
    await waitFor(() => expect(mounted.container.innerHTML).toBe(""));
    expect(mounted.inspection.rpcCalls.map((call) => call.method)).toEqual([
      "snapshot",
    ]);
  });

  it("shows a pool error visibly", async () => {
    const mounted = mount(() => ({ ...snapshot([]), error: "Pool failed" }));
    await mounted.findByRole("status", { name: /unavailable/i });
    expect(mounted.queryAllByRole("img")).toEqual([]);
  });

  it("labels stale readings and expired reset windows rather than implying fresh capacity", async () => {
    const stale = group("claude");
    stale.accounts[0]!.stale = true;
    const expired = group("codex");
    expired.weeklyBars[0]!.resetAt = Date.now() - 60_000;
    const mounted = mount(() => snapshot([stale, expired]));

    const staleGauge = await mounted.findByRole("img", {
      name: /^stale reading/i,
    });

    const expiredGauge = await mounted.findByRole("img", {
      name: /reset passed/i,
    });

    expect(staleGauge.textContent).toBe("–");
    expect(expiredGauge.textContent).toBe("–");
    await waitFor(() => expect(mounted.queryByText("75")).toBeNull());
  });

  it("shows when a five-hour-exhausted account is usable again instead of its weekly reading", async () => {
    const limited = group("codex", 80);
    limited.weeklyBars[0]!.fiveHourWarning = {
      remainingPercent: 0,
      exhausted: true,
      resetAt: Date.now() + 140 * 60_000,
    };
    const mounted = mount(() => snapshot([limited]));

    const gauge = await mounted.findByRole("img", {
      name: /5.hour.*exhausted.*reset/i,
    });

    expect(gauge.textContent).toBe("2h");
    expect(mounted.queryByText("80")).toBeNull();
  });

  it("keeps the weekly reading when the five-hour window is only running low", async () => {
    const low = group("claude", 80);
    low.weeklyBars[0]!.fiveHourWarning = {
      remainingPercent: 6,
      exhausted: false,
      resetAt: Date.now() + 140 * 60_000,
    };
    const mounted = mount(() => snapshot([low]));

    const gauge = await mounted.findByRole("img", {
      name: /5.hour usage limit: 6% left/i,
    });

    expect(gauge.textContent).toBe("80");
  });

  it("shows when a nearly exhausted weekly limit resets", async () => {
    const empty = group("claude", 1);
    empty.weeklyBars[0]!.resetAt = Date.now() + 145 * 3_600_000;
    const mounted = mount(() => snapshot([empty]));
    const gauge = await mounted.findByRole("img", { name: /claude.*1%/i });
    expect(gauge.textContent).toBe("6d");
  });
});

function withBars(provider: "claude" | "codex", bars: Partial<WeeklyBar>[]) {
  const base = group(provider);
  const template = base.weeklyBars[0]!;

  base.weeklyBars = bars.map((bar, index) => ({
    ...template,
    accountId: `${provider}-${index}`,
    name: `${provider} ${index + 1}`,
    ...bar,
  }));
  base.accounts = base.weeklyBars.map((bar) => ({
    ...base.accounts[0]!,
    id: bar.accountId,
    name: bar.name,
  }));

  return base;
}

describe("live usage in the app footer", () => {
  it.each(["rejected read", "empty error snapshot"])(
    "keeps the last successful timestamp and values after a %s",
    async (failureKind) => {
      const last = { ...snapshot(), fetchedAt: Date.now() - 120_000 };
      let failed = false;

      const mounted = mount(
        () => {
          if (!failed) return last;

          if (failureKind === "rejected read") throw new Error("fetch failed");

          return { ...snapshot([]), error: "fetch failed" };
        },
        { experimental_placement: "footer" },
      );

      const trigger = await mounted.findByRole("button", {
        name: /claude.*75%.*show usage details/i,
      });

      fireEvent.click(trigger);
      await mounted.findByText(/^updated 2m ago$/i);
      failed = true;
      await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
      expect(mounted.getByRole("status", { name: /stale/i })).toBeDefined();
      expect(rings(trigger)).toBe("75%40%");
      expect(mounted.getByText(/^last reading 2m ago$/i)).toBeDefined();
      expect(mounted.getByText(/fetch failed/i)).toBeDefined();
      expect(mounted.queryByText(/^updated just now$/i)).toBeNull();
    },
  );

  it("keeps a newer explicit refresh when an older read finishes late", async () => {
    let pending = false;
    let release: ((reading: Snapshot) => void) | undefined;

    const mounted = mount(
      () =>
        pending
          ? new Promise<Snapshot>((resolve) => {
              release = resolve;
            })
          : snapshot([group("claude", 75)]),
      { experimental_placement: "footer" },
      () => snapshot([group("claude", 20)]),
    );

    const trigger = await mounted.findByRole("button", {
      name: /claude.*75%.*show usage details/i,
    });

    fireEvent.click(trigger);

    const refresh = await mounted.findByRole("button", {
      name: "Refresh account usage from the providers",
    });

    pending = true;
    await mounted.behavior.emitRealtime(USAGE_CHANGED_CHANNEL, null);
    fireEvent.click(refresh);
    await waitFor(() => expect(rings(trigger)).toBe("20%"));
    await act(async () => release?.(snapshot([group("claude", 70)])));
    expect(rings(trigger)).toBe("20%");
  });

  it("shows one ring per provider for the account serving now and names every account for assistive tech", async () => {
    const mounted = mount(
      () =>
        snapshot([
          withBars("claude", [
            { remainingPercent: 60 },
            { remainingPercent: 17, serving: "serving" },
          ]),
          group("codex", 40),
        ]),
      { experimental_placement: "footer" },
    );

    const trigger = await mounted.findByRole("button", {
      name: /^claude: claude 1 60% of the week left; claude 2 17% of the week left, serving now\. codex: codex work 40% of the week left\. show usage details$/i,
    });

    expect(rings(trigger)).toBe("17%40%");
    expect(ring(trigger, "claude").getAttribute("title")).toMatch(
      /claude 2.*serving a request right now/i,
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("summarises a provider with nothing usable as its next capacity", async () => {
    const blocked = {
      ...withBars("claude", [
        {
          remainingPercent: 0,
          status: "exhausted",
          resetAt: Date.now() + 2 * 86_400_000,
        },
        { remainingPercent: null, status: "disabled" },
      ]),
      readyCount: 0,
      nextCapacityAt: Date.now() + 2 * 86_400_000,
    };

    const mounted = mount(() => snapshot([blocked]), {
      experimental_placement: "footer",
    });

    const trigger = await mounted.findByRole("button", {
      name: /claude 2 is disabled/i,
    });

    expect(rings(trigger)).toBe("2d");
    expect(ring(trigger, "claude").getAttribute("title")).toMatch(
      /^claude · no account usable · back /i,
    );
  });

  it("shows credits left once included usage is spent, neutral while credits remain and red when they run out", async () => {
    const spent = {
      remainingPercent: 0,
      resetAt: Date.now() + 3 * 86_400_000,
      credits: {
        balance: { unit: "points" as const, amount: 1250 },
        unlimited: false,
        observedAt: Date.now(),
      },
    };

    const drawing = withBars("codex", [spent]);

    const mounted = mount(() => snapshot([drawing]), {
      experimental_placement: "footer",
    });

    const trigger = await mounted.findByRole("button", {
      name: /codex 1 spent its included usage, 1,250 points credit left/i,
    });

    const compact = new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 0,
    }).format(1250);

    expect(rings(trigger)).toBe(compact);

    const healthy = ring(trigger, "codex").querySelector(
      "[data-usage-credits]",
    );

    expect(healthy?.className).toContain("text-muted-foreground");
    expect(healthy?.className).not.toContain("text-warning-text");
    expect(healthy?.querySelector("svg")).toBeNull();
    expect(
      ring(trigger, "codex")
        .querySelector("circle[stroke-dasharray='100 100']")
        ?.getAttribute("class"),
    ).toContain("stroke-muted-foreground");

    const empty = withBars("codex", [
      {
        ...spent,
        status: "exhausted",
        credits: { ...spent.credits, balance: { unit: "points", amount: 0 } },
      },
      { remainingPercent: 0, resetAt: Date.now() + 86_400_000 },
    ]);

    const zero = mount(() => snapshot([empty]), {
      experimental_placement: "footer",
    });

    const emptyTrigger = await zero.findByRole("button", {
      name: /codex 1 spent its included usage, credits used up/i,
    });

    expect(rings(emptyTrigger)).toBe("0");

    const low = ring(emptyTrigger, "codex").querySelector(
      "[data-usage-credits]",
    );

    expect(low?.className).toContain("text-destructive-text");
    expect(low?.querySelector("svg")).not.toBeNull();
    expect(
      ring(emptyTrigger, "codex").querySelector(
        "circle[stroke-dasharray='100 100']",
      ),
    ).toBeNull();
  });

  it("keeps unlimited and unknown credit balances neutral", async () => {
    const creditReading = (credits: {
      balance: null;
      unlimited: boolean;
    }): Snapshot =>
      snapshot([
        withBars("codex", [
          {
            remainingPercent: 0,
            resetAt: Date.now() + 3 * 86_400_000,
            credits: { ...credits, observedAt: Date.now() },
          },
        ]),
      ]);

    const unlimited = mount(
      () => creditReading({ balance: null, unlimited: true }),
      { experimental_placement: "footer" },
    );

    const unlimitedTrigger = await unlimited.findByRole("button", {
      name: /unlimited credits/i,
    });

    expect(
      ring(unlimitedTrigger, "codex").querySelector("[data-usage-credits]")
        ?.className,
    ).toContain("text-muted-foreground");

    const unknown = mount(
      () => creditReading({ balance: null, unlimited: false }),
      { experimental_placement: "footer" },
    );

    const unknownTrigger = await unknown.findByRole("button", {
      name: /credits available, balance unknown/i,
    });

    expect(
      ring(unknownTrigger, "codex").querySelector("[data-usage-credits]")
        ?.className,
    ).toContain("text-muted-foreground");
  });

  it("keeps the reset countdown when a spent account reports no credits", async () => {
    const mounted = mount(
      () =>
        snapshot([
          withBars("codex", [
            { remainingPercent: 0, resetAt: Date.now() + 2 * 86_400_000 },
          ]),
        ]),
      { experimental_placement: "footer" },
    );

    const trigger = await mounted.findByRole("button", {
      name: /codex 1 spent its week/i,
    });

    expect(rings(trigger)).toBe("2d");
    expect(trigger.querySelector("[data-usage-credits]")).toBeNull();
  });

  it("opens account details in a popover without a separate usage page", async () => {
    const limited = withBars("claude", [
      { remainingPercent: 80, plan: "Max" },
      {
        remainingPercent: 50,
        fiveHourWarning: {
          remainingPercent: 0,
          exhausted: true,
          resetAt: Date.now() + 100 * 60_000,
        },
      },
    ]);

    const mounted = mount(() => snapshot([limited]), {
      experimental_placement: "footer",
    });

    const trigger = await mounted.findByRole("button", {
      name: /show usage details/i,
    });

    expect(trigger.getAttribute("aria-label")).toMatch(
      /claude 2 hit its 5-hour limit, resets in 1h 40m/i,
    );
    expect(rings(trigger)).toBe("65%");
    fireEvent.click(trigger);

    const details = await mounted.findByRole("dialog", {
      name: /account usage details/i,
    });

    expect(within(details).getByText("claude 1")).toBeDefined();
    expect(within(details).getByText("Max")).toBeDefined();
    expect(within(details).getByText("1 of 1 ready")).toBeDefined();
    expect(within(details).getByText(/^updated /i)).toBeDefined();

    const blockedRow = within(details)
      .getByText("5-hour limit reached, resets in 1h 40m")
      .closest("li")!;

    expect(within(blockedRow).getByText("claude 2")).toBeDefined();
    expect(within(blockedRow).getByText("1h 40m")).toBeDefined();
    expect(
      within(details).getByRole("img", {
        name: /claude 1.*80% of the week left/i,
      }),
    ).toBeDefined();
    expect(
      within(details).queryByRole("button", { name: /open usage page/i }),
    ).toBeNull();
    expect(app.navPanels).toEqual([]);
  });

  it("keeps every account's colour and the serving mark in the details behind the ring", async () => {
    const mounted = mount(
      () =>
        snapshot([
          withBars("claude", [
            { remainingPercent: 83, serving: "serving" },
            { remainingPercent: 100 },
            { remainingPercent: 31 },
            { remainingPercent: 15 },
            { remainingPercent: 4 },
          ]),
        ]),
      { experimental_placement: "footer" },
    );

    const trigger = await mounted.findByRole("button", {
      name: /claude 1 83% of the week left, serving now; claude 2 100% of the week left;/i,
    });

    expect(rings(trigger)).toBe("83%");
    fireEvent.click(trigger);

    const details = await mounted.findByRole("dialog", {
      name: /account usage details/i,
    });

    const meters = within(details).getAllByRole("img");

    const fills = (tone: string) =>
      meters.filter((meter) => meter.querySelector(`.${tone}`) !== null);

    expect(meters).toHaveLength(5);
    expect(fills("bg-success")).toHaveLength(3);
    expect(fills("bg-warning")).toHaveLength(1);
    expect(fills("bg-destructive")).toHaveLength(1);
    expect(details.querySelectorAll('[title$="serving now"]')).toHaveLength(1);
  });

  it("names a nearly spent five-hour window instead of recoloring the weekly percentage", async () => {
    const low = withBars("claude", [
      {
        remainingPercent: 80,
        fiveHourWarning: {
          remainingPercent: 6,
          exhausted: false,
          resetAt: Date.now() + 140 * 60_000,
        },
      },
    ]);

    const mounted = mount(() => snapshot([low]), {
      experimental_placement: "footer",
    });

    const trigger = await mounted.findByRole("button", {
      name: /claude 1 80% of the week left, 6% of the 5-hour limit left/i,
    });

    const claude = ring(trigger, "claude");

    expect(claude.textContent).toBe("80%5h");
    expect(
      [...claude.querySelectorAll(".text-warning-text")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["5h"]);
    expect(claude.getAttribute("title")).toMatch(/5-hour usage limit: 6% left/);
  });

  it("marks a stale serving reading apart from a missing one and says how old it is", async () => {
    const stale = withBars("claude", [
      { remainingPercent: 70 },
      { remainingPercent: 50, serving: "serving" },
      { remainingPercent: null },
    ]);

    stale.accounts[1]!.stale = true;
    stale.accounts[1]!.observedAt = Date.now() - 20 * 60_000;

    const mounted = mount(() => snapshot([stale]), {
      experimental_placement: "footer",
    });

    const trigger = await mounted.findByRole("button", {
      name: /claude 2 has a stale reading/i,
    });

    const claude = ring(trigger, "claude");

    expect(claude.getAttribute("title")).toMatch(/^Stale reading from 20m ago/);
    expect(claude.querySelectorAll("[data-usage-stale]")).toHaveLength(1);
    expect(claude.textContent).toBe("");
  });

  it("opens the details on hover, keeps them open when clicked and closes them when the pointer leaves", async () => {
    const mounted = mount(() => snapshot(), {
      experimental_placement: "footer",
    });

    const trigger = await mounted.findByRole("button", {
      name: /show usage details/i,
    });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await mounted.findByRole("dialog", { name: /account usage details/i });
    expect(document.activeElement).not.toBe(
      mounted.queryByRole("dialog", { name: /account usage details/i }),
    );
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await waitFor(() =>
      expect(
        mounted.queryByRole("dialog", { name: /account usage details/i }),
      ).toBeNull(),
    );

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await mounted.findByRole("dialog", { name: /account usage details/i });
    fireEvent.click(trigger);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      mounted.getByRole("dialog", { name: /account usage details/i }),
    ).toBeDefined();
  });

  it("ignores touch hover so a tap alone opens the details", async () => {
    const mounted = mount(() => snapshot(), {
      experimental_placement: "footer",
    });

    const trigger = await mounted.findByRole("button", {
      name: /show usage details/i,
    });

    fireEvent.pointerEnter(trigger, { pointerType: "touch" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      mounted.queryByRole("dialog", { name: /account usage details/i }),
    ).toBeNull();
  });

  it.each([true, false])(
    "leaves the footer empty without pooled accounts, even offline, disabled=%s",
    async (poolUnavailable) => {
      const mounted = mount(() => ({ ...snapshot([]), poolUnavailable }), {
        experimental_placement: "footer",
      });

      await waitFor(() => expect(mounted.container.innerHTML).toBe(""));
      await mounted.behavior.setRealtimeConnectionState("reconnecting");
      expect(mounted.container.innerHTML).toBe("");
    },
  );

  it("keeps the gauge column when the host gives the rail placement", async () => {
    const mounted = mount(() => snapshot(), { experimental_placement: "rail" });

    const claude = await mounted.findByRole("img", {
      name: /claude.*work.*75%/i,
    });

    expect(within(claude).getByText("75")).toBeDefined();
    expect(mounted.queryByRole("group")).toBeNull();
  });
});

it("keeps each credit balance attached to its account in usage details", async () => {
  const codex = group("codex");
  codex.accounts[0]!.extraUsage = {
    observedAt: Date.now(),
    creditBalance: { unit: "points", amount: 1250.5 },
  };
  const claude = group("claude");
  claude.accounts[0]!.extraUsage = {
    observedAt: Date.now(),
    creditBalance: { unit: "currency", amount: 12.5, currency: "EUR" },
  };

  const mounted = mount(() => snapshot([codex, claude]), {
    experimental_placement: "footer",
  });

  fireEvent.click(
    await mounted.findByRole("button", { name: /show usage details/i }),
  );

  const details = await mounted.findByRole("dialog", {
    name: /account usage details/i,
  });

  const points = within(details).getByText(/Credits.*1,250.5 points/);
  expect(points.closest("li")?.textContent).toContain("codex work");
  const money = within(details).getByText(/Credits.*12.50/);
  expect(money.closest("li")?.textContent).toContain("claude work");
});

describe("account usage details", () => {
  const minute = 60_000;

  async function openDetails(read: () => Snapshot) {
    const mounted = mount(read, { experimental_placement: "footer" });

    fireEvent.click(
      await mounted.findByRole("button", { name: /show usage details/i }),
    );

    return mounted.findByRole("dialog", { name: /account usage details/i });
  }

  function accountRow(details: HTMLElement, name: string): HTMLElement {
    const row = within(details).getByText(name, { exact: true }).closest("li");

    if (row === null) throw new Error(`${name} has no account row`);

    return row;
  }

  it("ends each account line with the next change that matters to it", async () => {
    const now = Date.now();

    const claude = withBars("claude", [
      {
        remainingPercent: 0,
        status: "exhausted",
        resetAt: now + (4 * 60 + 48) * minute,
      },
      {
        remainingPercent: 80,
        fiveHourWarning: {
          remainingPercent: 6,
          exhausted: false,
          resetAt: now + 140 * minute,
        },
      },
      { remainingPercent: 70 },
      { remainingPercent: 60, resetAt: now + 20 * 60 * minute },
      { remainingPercent: null, status: "disabled" },
      { remainingPercent: 90 },
      { remainingPercent: 50 },
    ]);

    claude.columns = [
      { key: "7d", label: "7D" },
      { key: "fam:fable", label: "FABLE" },
    ];
    claude.accounts[2]!.cells = [
      null,
      { key: "fable", percent: 92, tone: "warn", resetAt: null, gating: false },
    ];
    claude.accounts[5]!.status = "error";
    claude.accounts[5]!.statusLabel = "Error";
    claude.accounts[5]!.error = "Upstream returned HTTP 500.";
    claude.accounts[6]!.stale = true;
    claude.accounts[6]!.observedAt = now - 20 * minute;

    const details = await openDetails(() => snapshot([claude]));

    const expected = [
      ["claude 1", "4h 48m", "Weekly limit spent, resets in 4h 48m"],
      ["claude 2", "5h 6%", "6% of the 5-hour limit left, resets in 2h 20m"],
      ["claude 3", "fable 8%", "fable limit 8% left"],
      ["claude 4", "20h", "resets in 20h"],
      ["claude 5", "off", "Disabled"],
      ["claude 7", "stale", "Stale reading from 20m ago"],
    ] as const;

    for (const [name, shown, spoken] of expected) {
      const row = accountRow(details, name);

      expect(within(row).getByText(shown)).toBeDefined();
      expect(within(row).getByText(spoken)).toBeDefined();
    }

    const failed = accountRow(details, "claude 6");
    expect(within(failed).queryByText("error")).toBeNull();
    expect(within(failed).getByText("Error")).toBeDefined();
    expect(
      within(accountRow(details, "claude 6")).getByText("Unavailable"),
    ).toBeDefined();
    expect(
      within(accountRow(details, "claude 6")).getByRole("button", {
        name: "Retry",
      }),
    ).toBeDefined();
  });

  it("drops an email domain every account shares and keeps the full address on hover", async () => {
    const shared = withBars("claude", [
      { name: "one@burlis.de" },
      { name: "two@burlis.de" },
    ]);

    const details = await openDetails(() => snapshot([shared]));

    expect(
      within(details)
        .getByText("one")
        .closest("[title]")
        ?.getAttribute("title"),
    ).toBe("one@burlis.de");
    expect(within(details).getByText("two")).toBeDefined();
    expect(within(details).queryByText("one@burlis.de")).toBeNull();
  });

  it("keeps full account names when their domains differ", async () => {
    const mixed = withBars("claude", [
      { name: "one@burlis.de" },
      { name: "two@example.com" },
    ]);

    const details = await openDetails(() => snapshot([mixed]));

    expect(within(details).getByText("one@burlis.de")).toBeDefined();
    expect(within(details).getByText("two@example.com")).toBeDefined();
  });

  it("marks an account that spends its week faster than the week passes", async () => {
    const now = Date.now();

    const paced = withBars("claude", [
      { remainingPercent: 30, resetAt: now + 5 * 24 * 60 * minute },
      { remainingPercent: 80, resetAt: now + 5 * 24 * 60 * minute },
    ]);

    const details = await openDetails(() => snapshot([paced]));
    const behind = accountRow(details, "claude 1");
    const ahead = accountRow(details, "claude 2");

    expect(behind.querySelector("[data-usage-over-pace]")).not.toBeNull();
    expect(
      within(behind).getByRole("img", { name: /over pace/i }),
    ).toBeDefined();
    expect(ahead.querySelector("[data-usage-over-pace]")).toBeNull();
    expect(within(ahead).queryByRole("img", { name: /over pace/i })).toBeNull();
  });
});
