// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type RenderedSlot } from "@omnyo/plugin-sdk/testing/app";
import type { Snapshot } from "../contract.ts";
import {
  telemetryInputSchema,
  type TelemetryReport,
} from "../lib/telemetry-contract.ts";

import { SpeedAllowance } from "./speed-allowance.tsx";

const mounts: RenderedSlot[] = [];

const id = "11111111-1111-4111-8111-111111111111";

const snapshot: Snapshot = {
  fetchedAt: Date.now(),
  error: null,
  poolUnavailable: false,
  groups: [
    {
      providerId: "codex",
      poolProvider: "codex",
      routingEnabled: true,
      readyCount: 1,
      totalCount: 1,
      nextCapacityAt: null,
      columns: [],
      accounts: [
        {
          id,
          name: "Work",
          plan: null,
          enabled: true,
          canResetCredits: false,
          canSignInAgain: false,
          status: "ready",
          statusLabel: "Ready",
          serving: "serving",
          resetAt: null,
          lastUsedAt: null,
          observedAt: Date.now(),
          stale: false,
          error: null,
          cells: [],
        },
      ],
      weeklyBars: [
        {
          accountId: id,
          name: "Work",
          plan: null,
          remainingPercent: 80,
          resetAt: Date.now() + 86400000,
          windowMinutes: 10080,
          status: "ready",
          serving: "serving",
          fiveHourWarning: null,
          credits: null,
        },
      ],
    },
  ],
};

const empty: TelemetryReport = {
  truncated: false,
  from: 0,
  to: Date.now(),
  collectionErrors: 0,
  rows: [],
  windows: [],
  speedRows: [],
};

const unmeasuredRow: TelemetryReport["rows"][number] = {
  accountId: id,
  model: "gpt-6-astra",
  requestedTier: "default",
  servedTier: null,
  effort: "xhigh",
  requests: 100,
  completed: 0,
  failed: 0,
  unmeasured: 100,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  medianTps: null,
  medianFirstEventMs: 80,
};

function mount(
  telemetry: (input: {
    accountId: string | null;
  }) => TelemetryReport | Promise<TelemetryReport>,
) {
  const mounted = renderSlot(
    { component: SpeedAllowance },
    { accounts: snapshot.groups[0]!.accounts, fetchedAt: snapshot.fetchedAt },
    {
      pluginId: "omnyo--account-usage",
      rpc: {
        snapshot: () => snapshot,
        telemetry: (input) => telemetry(telemetryInputSchema.parse(input)),
      },
    },
  );

  mounts.push(mounted);

  return mounted;
}

afterEach(() => {
  mounts.splice(0).forEach((mount) => mount.lifecycle.unmount());
  cleanup();
});

async function open(mounted: RenderedSlot) {
  fireEvent.click(await mounted.findByRole("button", { name: /Codex speed/ }));

  return within(
    await mounted.findByRole("region", { name: "Codex speed and allowance" }),
  );
}

describe("account speed and allowance", () => {
  it("keeps measurements hidden and does not request them until expanded", async () => {
    let requests = 0;

    const mounted = mount(() => {
      requests += 1;

      return empty;
    });

    const toggle = await mounted.findByRole("button", {
      name: /Codex speed/,
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(mounted.queryByRole("combobox")).toBeNull();
    expect(requests).toBe(0);
    fireEvent.click(toggle);
    expect(await mounted.findByText(/No measured speed yet/)).toBeDefined();
    expect(requests).toBe(1);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(mounted.queryByRole("combobox")).toBeNull();
  });
  it("starts collecting without presenting absent measurements as zero", async () => {
    const view = await open(mount(() => empty));
    expect(await view.findByText(/No measured speed yet/)).toBeDefined();
    expect(view.queryByRole("table")).toBeNull();
  });
  it("explains historical requests without speed measurements instead of showing zeros", async () => {
    const report: TelemetryReport = {
      ...empty,
      rows: [unmeasuredRow],
    };

    const view = await open(mount(() => report));
    expect(await view.findByText(/No measured speed yet/)).toBeDefined();
    expect(view.queryByRole("table")).toBeNull();
    expect(view.queryByText("0/100")).toBeNull();
  });
  it("shows recorded turn speed independently of proxy measurements and filters allowance", async () => {
    const calls: (string | null)[] = [];

    const report: TelemetryReport = {
      ...empty,
      truncated: true,
      speedRows: [
        {
          model: "gpt-6.1-sol",
          requestedTier: "fast",
          effort: "high",
          medianTps: 41.7,
          measuredTurns: 7,
        },
        {
          model: "gpt-6.1-sol",
          requestedTier: "default",
          effort: "high",
          medianTps: 27,
          measuredTurns: 100,
        },
        {
          model: "gpt-6.1-sol",
          requestedTier: "ultrafast",
          effort: "high",
          medianTps: 28.1,
          measuredTurns: 6,
        },
        {
          model: "gpt-6-astra",
          requestedTier: "default",
          effort: "high",
          medianTps: 22.7,
          measuredTurns: 10,
        },
        {
          model: "gpt-6.1-sol",
          requestedTier: "default",
          effort: "xhigh",
          medianTps: 28.8,
          measuredTurns: 15,
        },
        {
          model: "gpt-6.1-sol",
          requestedTier: "fast",
          effort: "xhigh",
          medianTps: 39.6,
          measuredTurns: 8,
        },
        {
          model: "gpt-6-astra",
          requestedTier: "ultrafast",
          effort: "xhigh",
          medianTps: 48,
          measuredTurns: 5,
        },
      ],
      rows: [
        {
          accountId: id,
          model: "gpt-6.1-sol",
          requestedTier: "fast",
          servedTier: null,
          effort: "high",
          requests: 4,
          completed: 3,
          failed: 1,
          unmeasured: 0,
          inputTokens: 1200,
          cachedInputTokens: 800,
          outputTokens: 100,
          reasoningTokens: 50,
          medianTps: 32.5,
          medianFirstEventMs: 80,
        },
        unmeasuredRow,
      ],
    };

    const view = await open(
      mount((input) => {
        calls.push(input.accountId);

        return report;
      }),
    );

    expect(await view.findByText("41.7")).toBeDefined();
    expect(view.getAllByText("gpt-6.1-sol")).toHaveLength(1);

    const comparison = within(
      view.getByRole("region", { name: "gpt-6.1-sol vs Standard" }),
    );

    expect(comparison.getByText("1.5×")).toBeDefined();
    expect(comparison.getByText("1.0×")).toBeDefined();
    expect(view.getByText("7 turns")).toBeDefined();
    expect(view.getByRole("columnheader", { name: "Standard" })).toBeDefined();
    expect(view.getByRole("columnheader", { name: "Fast" })).toBeDefined();
    expect(view.getByRole("columnheader", { name: "Ultrafast" })).toBeDefined();
    const sol = within(view.getByRole("row", { name: /gpt-6.1-sol/ }));
    expect(sol.getByText("27")).toBeDefined();
    expect(sol.getByText("28.1")).toBeDefined();
    const astra = within(view.getByRole("row", { name: /gpt-6-astra/ }));
    expect(astra.getAllByText("—")).toHaveLength(2);
    fireEvent.change(view.getByRole("combobox", { name: "Thinking effort" }), {
      target: { value: "xhigh" },
    });
    expect(view.getByText("28.8")).toBeDefined();
    expect(view.queryByText("41.7")).toBeNull();
    expect(comparison.getByText("1.4×")).toBeDefined();
    expect(comparison.getByText("—")).toBeDefined();
    expect(
      view.queryByRole("combobox", { name: "Allowance account" }),
    ).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Allowance details" }));
    expect(view.queryByText(/bounded sample|Tiers are requested/)).toBeNull();
    fireEvent.change(
      view.getByRole("combobox", { name: "Allowance account" }),
      { target: { value: id } },
    );
    await waitFor(() => expect(calls).toEqual([null, id]));
    expect(await view.findByText("28.8")).toBeDefined();
    expect(
      view.getByRole("button", { name: "Allowance details", expanded: true }),
    ).toBeDefined();
    expect(
      view.getByRole("option", { name: "Extra high", selected: true }),
    ).toBeDefined();
  });
  it("surfaces unavailable telemetry with a retry action", async () => {
    const mounted = mount(() => Promise.reject(new Error("Unavailable")));
    const view = await open(mounted);
    expect(
      await view.findByText(/Couldn’t load speed measurements/),
    ).toBeDefined();
    expect(view.getByRole("button", { name: "Retry" })).toBeDefined();
  });
});
