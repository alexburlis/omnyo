// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import type { RenderedSlot } from "@omnyo/plugin-sdk/testing/app";
import plugin from "../server.ts";
import { UsagePanel } from "./usage-panel.tsx";
import type { AccountSummary } from "../lib/pool-contracts.ts";
import { accountProblem } from "../lib/account-problem.ts";
import { invalidateResetCredits } from "./reset-credits-cache.ts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const VERIFICATION_URL = "https://auth.openai.com/codex/device";

const mounts: RenderedSlot[] = [];

const account = (
  provider: "claude" | "codex",
  kind: string,
  error: string | null,
): AccountSummary => ({
  id: ACCOUNT_ID,
  provider,
  kind,
  enabled: true,
  label: null,
  email: "work@example.com",
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
  observedAt: Date.now(),
  heldUntil: null,
  error,
  inFlight: 0,
  status: error === null ? "ready" : "error",
});

type PoolHandler = (input: unknown) => unknown;

async function mountPanel(
  pooled: AccountSummary,
  handlers: Record<string, PoolHandler>,
) {
  let current = pooled;
  const poolCalls: Array<{ method: string; input: unknown }> = [];

  const { api, harness } = createFakePluginHost({
    pluginId: "omnyo--account-usage",
    sdk: {
      plugins: {
        callRpc: (request) => {
          poolCalls.push({ method: request.method, input: request.input });

          switch (request.method) {
            case "status.get":
              return {
                accepting: true,
                inFlight: 0,
                enabledAccountCount: 1,
                routing: { claude: true, codex: true },
                accounts: [current],
              };
            case "config.get":
              return { switchThreshold: 0.98 };
            case "experimental_codex-resets.v1.credits":
              return {
                accountId: ACCOUNT_ID,
                availableCount: 0,
                credits: [],
                fetchedAt: Date.now(),
              };
            case "account.refreshUsage":
              current = { ...current, error: null, status: "ready" };

              return { account: current };
            default: {
              const handler = handlers[request.method];

              if (handler === undefined)
                throw new Error(`Unexpected owner method: ${request.method}`);

              return handler(request.input);
            }
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
      openUrl: () => true,
      experimental_copyToClipboard: async () => true,
      rpc: {
        snapshot: () => harness.callRpc("snapshot", null),
        refresh: () => harness.callRpc("refresh", null),
        codexResetCredits: (input) =>
          harness.callRpc("codexResetCredits", input),
        codexRedeemReset: (input) => harness.callRpc("codexRedeemReset", input),
        refreshAccount: (input) => harness.callRpc("refreshAccount", input),
        signInStart: (input) => harness.callRpc("signInStart", input),
        signInFinish: (input) => harness.callRpc("signInFinish", input),
        signInPoll: (input) => harness.callRpc("signInPoll", input),
        signInCancel: (input) => harness.callRpc("signInCancel", input),
      },
    },
  );

  mounts.push(mounted);
  fireEvent.click(
    await mounted.findByRole("button", { name: /show usage details/i }),
  );

  const details = await mounted.findByRole("dialog", {
    name: /account usage details/i,
  });

  return { mounted, details, harness, poolCalls };
}

afterEach(() => {
  for (const mount of mounts.splice(0)) mount.lifecycle.unmount();
  document.body.replaceChildren();
  sessionStorage.clear();
  invalidateResetCredits();
});

describe("account problems", () => {
  it.each([
    [
      "OAuth refresh failed with HTTP 400. invalid_grant.",
      "login expired or was revoked",
    ],
    [
      "OAuth refresh failed with HTTP 401. refresh_token_expired.",
      "login expired",
    ],
    ["OAuth refresh failed with HTTP 400.", "HTTP 400"],
  ])("reads %s as signed out", (error, detail) => {
    expect(accountProblem(error, true)).toMatchObject({
      kind: "signed-out",
      title: "Signed out",
      detail,
    });
  });

  it("keeps API-key and unrelated failures out of the sign-in path", () => {
    expect(
      accountProblem(
        "OAuth refresh failed with HTTP 400. invalid_grant.",
        false,
      ).kind,
    ).toBe("failed");
    expect(accountProblem("Upstream returned HTTP 500.", true)).toMatchObject({
      kind: "failed",
      title: "Unavailable",
      detail: "Upstream returned HTTP 500",
    });
  });
});

describe("repairing an account from the usage details", () => {
  it("does not offer or forward subscription sign-in for a legacy Claude account", async () => {
    const { details, harness, poolCalls } = await mountPanel(
      account(
        "claude",
        "oauth",
        "OAuth refresh failed with HTTP 400. invalid_grant.",
      ),
      {},
    );

    expect(
      within(details).queryByRole("button", { name: "Sign in again" }),
    ).toBeNull();
    await expect(
      harness.callRpc("signInStart", { accountId: ACCOUNT_ID }),
    ).rejects.toThrow("sign in directly in Claude Code");
    await expect(
      harness.callRpc("signInFinish", {
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        code: "synthetic-code",
      }),
    ).resolves.toMatchObject({ status: "error" });
    await expect(
      harness.callRpc("refreshAccount", { accountId: ACCOUNT_ID }),
    ).rejects.toThrow("Run /usage in Claude Code");
    await harness.callRpc("refresh", null);
    expect(
      poolCalls.filter(
        ({ method }) =>
          method.startsWith("login.") || method === "account.refreshUsage",
      ),
    ).toEqual([]);
  });

  it("walks a Codex account through the device code until it completes", async () => {
    let polls = 0;

    const { mounted, details, poolCalls } = await mountPanel(
      account(
        "codex",
        "oauth",
        "OAuth refresh failed with HTTP 401. refresh_token_expired.",
      ),
      {
        "codexLogin.start": () => ({
          sessionId: SESSION_ID,
          verificationUri: VERIFICATION_URL,
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 900_000,
          intervalMs: 20,
        }),
        "codexLogin.poll": () =>
          ++polls < 2
            ? { status: "pending" }
            : { status: "complete", account: { id: ACCOUNT_ID } },
      },
    );

    expect(
      within(details).queryByRole("group", { name: /reset credits/i }),
    ).toBeNull();

    fireEvent.click(
      within(details).getByRole("button", { name: "Sign in again" }),
    );
    await within(details).findByText("ABCD-1234");

    fireEvent.click(
      within(details).getByRole("button", { name: "Copy & open" }),
    );
    expect(mounted.inspection.experimental_clipboardWrites).toEqual([
      { text: "ABCD-1234" },
    ]);
    expect(mounted.inspection.navigateCalls).toContainEqual({
      method: "openUrl",
      url: VERIFICATION_URL,
    });

    await within(details).findByText("Signed in again.");
    expect(polls).toBe(2);
    expect(poolCalls.map((call) => call.method)).toContain(
      "account.refreshUsage",
    );
  });

  it("shows a sign-in failure plainly and offers to start over", async () => {
    const { details } = await mountPanel(
      account(
        "codex",
        "oauth",
        "OAuth refresh failed with HTTP 400. invalid_grant.",
      ),
      {
        "codexLogin.start": () => {
          throw new Error("Account Pooler is busy");
        },
      },
    );

    fireEvent.click(
      within(details).getByRole("button", { name: "Sign in again" }),
    );

    const failure = await within(details).findByRole("alert");

    expect(failure.textContent).toBe("Sign-in failed · Account Pooler is busy");
    expect(
      within(details).getByRole("button", { name: "Try again" }),
    ).toBeDefined();
  });

  it("retries an account whose failure is not a sign-in problem", async () => {
    const { details, poolCalls } = await mountPanel(
      account("claude", "api-key", "Upstream returned HTTP 500."),
      {},
    );

    expect(within(details).getByText("Unavailable")).toBeDefined();
    expect(
      within(details).queryByRole("button", { name: "Sign in again" }),
    ).toBeNull();

    fireEvent.click(within(details).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(within(details).queryByText("Unavailable")).toBeNull(),
    );
    expect(poolCalls).toContainEqual({
      method: "account.refreshUsage",
      input: { accountId: ACCOUNT_ID },
    });
  });

  it("refuses sign-in requests from other plugins", async () => {
    const { harness } = await mountPanel(
      account(
        "claude",
        "oauth",
        "OAuth refresh failed with HTTP 400. invalid_grant.",
      ),
      {},
    );

    await expect(
      harness.callRpc(
        "signInStart",
        { accountId: ACCOUNT_ID },
        { experimental_caller: { kind: "plugin", pluginId: "other" } },
      ),
    ).rejects.toThrow(/not authorized/);
  });
});
