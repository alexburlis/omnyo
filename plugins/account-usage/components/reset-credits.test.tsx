// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import type { RenderedSlot } from "@omnyo/plugin-sdk/testing/app";
import plugin from "../server.ts";
import { UsagePanel } from "./usage-panel.tsx";
import type { AccountSummary } from "../lib/pool-contracts.ts";
import { invalidateResetCredits } from "./reset-credits-cache.ts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

const CREDIT_ID = "provider-credit:one";

const EXPIRY = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const mounts: RenderedSlot[] = [];

const account = (
  id: string,
  provider: "codex" | "claude",
  kind: string,
  enabled: boolean,
): AccountSummary => ({
  id,
  provider,
  kind,
  enabled,
  label: null,
  email: `${id.slice(0, 3)}@example.com`,
  subscriptionType: null,
  priority: 1,
  lastUsedAt: null,
  fiveHourUtilization: null,
  fiveHourResetAt: null,
  fiveHourStatus: null,
  sevenDayUtilization: null,
  sevenDayResetAt: null,
  sevenDayStatus: null,
  familyWeekly: {},
  limitWindows: [],
  observedAt: 1_792_000_000_000,
  heldUntil: null,
  error: null,
  inFlight: 0,
  status: enabled ? "ready" : "disabled",
});

const listing = {
  accountId: ACCOUNT_ID,
  availableCount: 1,
  credits: [{ id: CREDIT_ID, status: "available", expiresAt: EXPIRY }],
  fetchedAt: 1_792_000_000_000,
};

interface Controls {
  listFailure?: string;
  list?: () => Promise<typeof listing>;
  redeem?: () => Promise<{
    accountId: string;
    code: "reset" | "already_redeemed" | "no_credit" | "nothing_to_reset";
    usageRefreshError: string | null;
  }>;
  accounts?: AccountSummary[];
  credits?: typeof listing.credits;
}

async function openDetails(mounted: RenderedSlot) {
  fireEvent.click(
    await mounted.findByRole("button", { name: /show usage details/i }),
  );
  await mounted.findByRole("group", {
    name: "Reset credits for 111@example.com",
  });
}

async function closeDetails(mounted: RenderedSlot) {
  fireEvent.keyDown(
    mounted.getByRole("dialog", { name: /account usage details/i }),
    { key: "Escape" },
  );
  await waitFor(() =>
    expect(
      mounted.queryByRole("dialog", { name: /account usage details/i }),
    ).toBeNull(),
  );
}

async function mountPanel(controls: Controls = {}) {
  const accounts = controls.accounts ?? [
    account(ACCOUNT_ID, "codex", "oauth", true),
  ];

  const { api, harness } = createFakePluginHost({
    pluginId: "omnyo--account-usage",
    sdk: {
      plugins: {
        callRpc: (request) => {
          switch (request.method) {
            case "status.get":
              return {
                accepting: true,
                inFlight: 0,
                enabledAccountCount: accounts.length,
                routing: { claude: true, codex: true },
                accounts,
              };
            case "config.get":
              return { switchThreshold: 0.98 };
            case "experimental_codex-resets.v1.credits":
              if (controls.listFailure) throw new Error(controls.listFailure);

              if (controls.list) return controls.list();

              return {
                ...listing,
                credits: controls.credits ?? listing.credits,
              };
            case "experimental_codex-resets.v1.redeem":
              return (
                controls.redeem?.() ?? {
                  accountId: ACCOUNT_ID,
                  code: "reset",
                  usageRefreshError: null,
                }
              );
            case "account.refreshUsage":
              return null;
            default:
              throw new Error(`Unexpected owner method: ${request.method}`);
          }
        },
      },
    },
  });

  plugin(api);

  const mounted = renderSlot(
    { component: UsagePanel },
    { layout: "footer" },
    {
      rpc: {
        snapshot: () => harness.callRpc("snapshot", null),
        refresh: () => harness.callRpc("refresh", null),
        codexResetCredits: (input) =>
          harness.callRpc("codexResetCredits", input),
        codexRedeemReset: (input) => harness.callRpc("codexRedeemReset", input),
      },
    },
  );

  mounts.push(mounted);
  await openDetails(mounted);

  return { mounted, harness };
}

afterEach(() => {
  for (const mount of mounts.splice(0)) mount.lifecycle.unmount();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  invalidateResetCredits();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bottom bar reset credit workflow", () => {
  it("reuses reset credits after the details close and reopen", async () => {
    const { mounted, harness } = await mountPanel();
    await mounted.findByRole("button", { name: "Use reset" });
    await closeDetails(mounted);
    await openDetails(mounted);
    expect(mounted.queryByText("Checking resets…")).toBeNull();
    expect(
      harness.inspection.sdk
        .callsTo("plugins.callRpc")
        .filter((call) => JSON.stringify(call).includes(".credits")),
    ).toHaveLength(1);
  });

  it("shares an unfinished check across closing and reopening the details", async () => {
    let release: ((value: typeof listing) => void) | undefined;

    const { mounted, harness } = await mountPanel({
      list: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    await mounted.findByText("Checking resets…");
    await closeDetails(mounted);
    await openDetails(mounted);
    expect(
      harness.inspection.sdk
        .callsTo("plugins.callRpc")
        .filter((call) => JSON.stringify(call).includes(".credits")),
    ).toHaveLength(1);
    await act(async () => release?.(listing));
    await mounted.findByRole("button", { name: "Use reset" });
  });

  it("refreshes the cached listing after three hours", async () => {
    const controls: Controls = {};
    const { mounted, harness } = await mountPanel(controls);
    await mounted.findByRole("button", { name: "Use reset" });
    await closeDetails(mounted);
    controls.credits = [];
    const later = Date.now() + 3 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await openDetails(mounted);
    await mounted.findByText("No reset credits available.");
    expect(
      harness.inspection.sdk
        .callsTo("plugins.callRpc")
        .filter((call) => JSON.stringify(call).includes(".credits")),
    ).toHaveLength(2);
  });

  it("refreshes reset credits through the existing provider refresh control", async () => {
    const controls: Controls = {};
    const { mounted, harness } = await mountPanel(controls);
    await mounted.findByRole("button", { name: "Use reset" });
    controls.credits = [];
    fireEvent.click(
      mounted.getByRole("button", {
        name: "Refresh account usage from the providers",
      }),
    );
    await mounted.findByText("No reset credits available.");
    expect(
      harness.inspection.sdk
        .callsTo("plugins.callRpc")
        .filter((call) => JSON.stringify(call).includes(".credits")),
    ).toHaveLength(2);
  });

  it("ends a stuck check with a retryable error and does not cache late results", async () => {
    let release: ((value: typeof listing) => void) | undefined;

    const controls: Controls = {};
    const { mounted } = await mountPanel(controls);
    await mounted.findByRole("button", { name: "Use reset" });
    controls.list = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    vi.useFakeTimers();
    fireEvent.click(
      mounted.getByRole("button", {
        name: "Refresh account usage from the providers",
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(80_000));
    vi.useRealTimers();
    await mounted.findByText("Reset credits check timed out. Try again.");
    expect(mounted.queryByText("Checking resets…")).toBeNull();
    expect(mounted.getByText(/1 reset available/)).toBeTruthy();
    await act(async () => release?.(listing));
    controls.list = undefined;
    controls.credits = [];
    fireEvent.click(
      mounted.getByRole("button", { name: "Refresh reset credits" }),
    );
    await mounted.findByText("No reset credits available.");
  });

  it("offers reset credits only for enabled Codex OAuth accounts", async () => {
    const { mounted } = await mountPanel({
      accounts: [
        account(ACCOUNT_ID, "codex", "oauth", true),
        account(
          "33333333-3333-4333-8333-333333333333",
          "codex",
          "api_key",
          true,
        ),
        account(
          "44444444-4444-4444-8444-444444444444",
          "codex",
          "oauth",
          false,
        ),
        account(
          "55555555-5555-4555-8555-555555555555",
          "claude",
          "oauth",
          true,
        ),
      ],
    });

    expect(
      mounted.getAllByRole("group", { name: /Reset credits for/ }),
    ).toHaveLength(1);
    expect(
      await mounted.findByRole("button", { name: "Use reset" }),
    ).toBeTruthy();
  });

  it("does not consume a listed credit until explicit confirmation and keeps the details open", async () => {
    const { mounted, harness } = await mountPanel();
    fireEvent.click(await mounted.findByRole("button", { name: "Use reset" }));
    expect(
      mounted.getByText("Use one reset for 111@example.com?"),
    ).toBeTruthy();
    expect(
      harness.inspection.sdk.callsTo("plugins.callRpc").filter((call) => {
        return JSON.stringify(call).includes(".redeem");
      }),
    ).toHaveLength(0);
    expect(
      mounted.getByRole("dialog", { name: /account usage details/i }),
    ).toBeTruthy();
    fireEvent.click(mounted.getByRole("button", { name: "Cancel" }));
    expect(mounted.queryByRole("button", { name: "Confirm reset" })).toBeNull();
  });

  it("keeps one request ID through transport uncertainty and prevents duplicate submissions", async () => {
    let calls = 0;
    let release: (() => void) | undefined;

    const controls: Controls = {
      redeem: async () => {
        calls += 1;

        if (calls === 1) throw new Error("Transport lost");
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return {
          accountId: ACCOUNT_ID,
          code: "already_redeemed",
          usageRefreshError: null,
        };
      },
    };

    const { mounted } = await mountPanel(controls);
    fireEvent.click(await mounted.findByRole("button", { name: "Use reset" }));
    fireEvent.click(mounted.getByRole("button", { name: "Confirm reset" }));
    await mounted.findByText(/Transport lost/);
    expect(calls).toBe(1);

    const first = mounted.inspection.rpcCalls.find(
      (call) => call.method === "codexRedeemReset",
    );

    fireEvent.click(mounted.getByRole("button", { name: "Retry same reset" }));
    await waitFor(() => expect(calls).toBe(2));
    const retry = mounted.getByRole("button", { name: "Resetting…" });
    expect(retry.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(retry);
    expect(calls).toBe(2);

    const attempts = mounted.inspection.rpcCalls.filter(
      (call) => call.method === "codexRedeemReset",
    );

    expect(attempts[1]?.input).toEqual(first?.input);
    expect(first?.input).toMatchObject({
      accountId: ACCOUNT_ID,
      creditId: CREDIT_ID,
      redeemRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      confirmed: true,
    });
    await act(async () => release?.());
    await mounted.findByText("Reset already applied.");
    await waitFor(() =>
      expect(
        mounted.inspection.rpcCalls.filter(
          (call) => call.method === "codexResetCredits",
        ),
      ).toHaveLength(2),
    );
    expect(
      mounted.queryByRole("button", { name: "Retry same reset" }),
    ).toBeNull();
  });

  it("retains an uncertain reset across closing the details without automatically retrying", async () => {
    let calls = 0;

    const { mounted } = await mountPanel({
      redeem: async () => {
        calls += 1;
        throw new Error("Transport lost");
      },
    });

    fireEvent.click(await mounted.findByRole("button", { name: "Use reset" }));
    fireEvent.click(mounted.getByRole("button", { name: "Confirm reset" }));
    await mounted.findByText(/Transport lost/);

    const first = mounted.inspection.rpcCalls.find(
      (call) => call.method === "codexRedeemReset",
    );

    fireEvent.keyDown(
      mounted.getByRole("dialog", { name: /account usage details/i }),
      { key: "Escape" },
    );
    await waitFor(() =>
      expect(
        mounted.queryByRole("dialog", { name: /account usage details/i }),
      ).toBeNull(),
    );
    await openDetails(mounted);
    expect(calls).toBe(1);
    fireEvent.click(
      await mounted.findByRole("button", { name: "Retry same reset" }),
    );
    await waitFor(() => expect(calls).toBe(2));

    const attempts = mounted.inspection.rpcCalls.filter(
      (call) => call.method === "codexRedeemReset",
    );

    expect(attempts[1]?.input).toEqual(first?.input);
  });

  it("rehydrates an uncertain attempt after the whole plugin remounts and blocks another credit", async () => {
    let calls = 0;

    const controls: Controls = {
      credits: [
        ...listing.credits,
        { id: "provider-credit:two", status: "available", expiresAt: EXPIRY },
      ],
      redeem: async () => {
        calls += 1;
        throw new Error("Transport lost");
      },
    };

    const firstMount = await mountPanel(controls);
    fireEvent.click(
      (
        await firstMount.mounted.findAllByRole("button", { name: "Use reset" })
      )[0]!,
    );
    fireEvent.click(
      firstMount.mounted.getByRole("button", { name: "Confirm reset" }),
    );
    await firstMount.mounted.findByText(/Transport lost/);

    const first = firstMount.mounted.inspection.rpcCalls.find(
      (call) => call.method === "codexRedeemReset",
    );

    firstMount.mounted.lifecycle.unmount();
    const remounted = await mountPanel(controls);
    await remounted.mounted.findByRole("button", { name: "Retry same reset" });
    expect(calls).toBe(1);
    expect(
      remounted.mounted.inspection.rpcCalls.some(
        (call) => call.method === "codexRedeemReset",
      ),
    ).toBe(false);
    expect(
      remounted.mounted.inspection.rpcCalls.some(
        (call) => call.method === "codexResetCredits",
      ),
    ).toBe(false);
    expect(
      remounted.mounted.queryByRole("button", { name: "Use reset" }),
    ).toBeNull();
    fireEvent.click(
      remounted.mounted.getByRole("button", { name: "Retry same reset" }),
    );
    await waitFor(() => expect(calls).toBe(2));

    const retry = remounted.mounted.inspection.rpcCalls.find(
      (call) => call.method === "codexRedeemReset",
    );

    expect(retry?.input).toEqual(first?.input);
  });

  it("retries an existing confirmed saved attempt with its original request ID", async () => {
    const redeemRequestId = "22222222-2222-4222-8222-222222222222";
    sessionStorage.setItem(
      `account-usage:reset:${ACCOUNT_ID}`,
      JSON.stringify({
        accountId: ACCOUNT_ID,
        creditId: CREDIT_ID,
        redeemRequestId,
      }),
    );
    const { mounted } = await mountPanel();
    expect(
      mounted.inspection.rpcCalls.some(
        (call) => call.method === "codexRedeemReset",
      ),
    ).toBe(false);
    fireEvent.click(
      await mounted.findByRole("button", { name: "Retry same reset" }),
    );
    await mounted.findByText("Usage reset applied.");
    expect(
      mounted.inspection.rpcCalls.find(
        (call) => call.method === "codexRedeemReset",
      )?.input,
    ).toEqual({
      accountId: ACCOUNT_ID,
      creditId: CREDIT_ID,
      redeemRequestId,
      confirmed: true,
    });
  });

  it("clears an acknowledged attempt despite usage-refresh failure before the plugin remounts", async () => {
    let calls = 0;

    const controls: Controls = {
      redeem: async () => {
        calls += 1;

        return {
          accountId: ACCOUNT_ID,
          code: "reset",
          usageRefreshError: "Usage refresh failed",
        };
      },
    };

    const firstMount = await mountPanel(controls);
    fireEvent.click(
      await firstMount.mounted.findByRole("button", { name: "Use reset" }),
    );
    fireEvent.click(
      firstMount.mounted.getByRole("button", { name: "Confirm reset" }),
    );
    await firstMount.mounted.findByText("Usage refresh failed");
    expect(firstMount.mounted.getByText("Usage reset applied.")).toBeTruthy();
    expect(
      firstMount.mounted.queryByRole("button", { name: "Retry same reset" }),
    ).toBeNull();
    firstMount.mounted.lifecycle.unmount();
    const remounted = await mountPanel(controls);
    expect(calls).toBe(1);
    expect(
      remounted.mounted.queryByRole("button", { name: "Retry same reset" }),
    ).toBeNull();
    expect(
      remounted.mounted.inspection.rpcCalls.some(
        (call) => call.method === "codexRedeemReset",
      ),
    ).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it("shows credit-list and post-reset usage failures", async () => {
    const controls: Controls = { listFailure: "Reset listing failed" };
    const { mounted } = await mountPanel(controls);
    await mounted.findByText("Reset listing failed");
    expect(mounted.queryByText("No reset credits available.")).toBeNull();
    controls.listFailure = undefined;
    controls.redeem = async () => ({
      accountId: ACCOUNT_ID,
      code: "reset",
      usageRefreshError: "Usage refresh failed",
    });
    fireEvent.click(
      mounted.getByRole("button", { name: "Refresh reset credits" }),
    );
    fireEvent.click(await mounted.findByRole("button", { name: "Use reset" }));
    fireEvent.click(mounted.getByRole("button", { name: "Confirm reset" }));
    await mounted.findByText("Usage refresh failed");
    expect(mounted.getByText("Usage reset applied.")).toBeTruthy();
  });
});
