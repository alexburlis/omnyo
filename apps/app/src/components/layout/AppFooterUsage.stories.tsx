import { useEffect, useState } from "react";
import { installTestPluginRuntime } from "@omnyo/plugin-sdk/testing/app";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { collectPluginAppRegistrations } from "@/lib/plugin-app-definition";
import { loadPluginAppDefinition } from "../../../.ladle/plugin-app-module";
import {
  installStoryPluginRpc,
  installStoryRealtimeConnected,
} from "../../../.ladle/story-shell-stubs";

installTestPluginRuntime();

const usageApp = collectPluginAppRegistrations(
  await loadPluginAppDefinition(
    import.meta.glob<unknown>("../../../../../plugins/account-usage/app.tsx"),
  ),
);

const usageCard = usageApp.sidebarFooterCards.find(
  (card) => card.id === "usage",
)!;

type AccountStatus = "disabled" | "ready" | "held" | "exhausted" | "error";

type Serving = "serving" | "next" | "idle";

type WindowTone = "ok" | "warn" | "blocked" | "elapsed" | "unknown";

export default { title: "plugins/Account usage" };

const PLUGIN_ID = "omnyo--account-usage";

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

interface WindowFixture {
  label: string;
  used: number;
  tone: WindowTone;
}

interface AccountFixture {
  id: string;
  name: string;
  plan: string | null;
  remaining: number | null;
  resetIn: number | null;
  windowMinutes?: number;
  status?: AccountStatus;
  serving?: Serving;
  usedAgo?: number;
  observedAgo?: number;
  stale?: boolean;
  error?: string;
  fiveHour?: { remaining: number; resetIn: number };
  credits?: number;
  canResetCredits?: boolean;
  windows?: WindowFixture[];
}

function group(
  providerId: string,
  poolProvider: "claude" | "codex",
  accounts: AccountFixture[],
  now: number,
) {
  const labels = [
    "7D",
    ...new Set(
      accounts.flatMap((account) =>
        (account.windows ?? []).map((window) => window.label),
      ),
    ),
  ];

  const ready = accounts.filter(
    (account) => (account.status ?? "ready") === "ready",
  ).length;

  const blockedResets = accounts.flatMap((account) =>
    account.status === "exhausted" && account.resetIn !== null
      ? [now + account.resetIn]
      : [],
  );

  return {
    providerId,
    poolProvider,
    routingEnabled: true,
    readyCount: ready,
    totalCount: accounts.length,
    nextCapacityAt:
      ready === 0 && blockedResets.length > 0
        ? Math.min(...blockedResets)
        : null,
    columns: labels.map((label) => ({ key: label, label })),
    weeklyBars: accounts.map((account) => {
      const fiveHour = account.fiveHour;

      return {
        accountId: account.id,
        name: account.name,
        plan: account.plan,
        remainingPercent: account.remaining,
        resetAt: account.resetIn === null ? null : now + account.resetIn,
        windowMinutes: account.windowMinutes ?? 10_080,
        status: account.status ?? "ready",
        serving: account.serving ?? "idle",
        fiveHourWarning:
          fiveHour === undefined
            ? null
            : {
                remainingPercent: fiveHour.remaining,
                exhausted: fiveHour.remaining === 0,
                resetAt: now + fiveHour.resetIn,
              },
        credits:
          account.credits === undefined
            ? null
            : {
                balance: { unit: "points", amount: account.credits },
                unlimited: false,
                observedAt: now - 2 * MINUTE,
              },
      };
    }),
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      plan: account.plan,
      enabled: account.status !== "disabled",
      canResetCredits: account.canResetCredits ?? false,
      extraUsage:
        account.credits === undefined
          ? null
          : {
              observedAt: now - 2 * MINUTE,
              creditBalance: { unit: "points", amount: account.credits },
            },
      status: account.status ?? "ready",
      statusLabel:
        account.status === "held"
          ? "Rate limited"
          : account.status === "exhausted"
            ? "Exhausted"
            : account.status === "error"
              ? "Error"
              : account.status === "disabled"
                ? "Disabled"
                : "Ready",
      serving: account.serving ?? "idle",
      resetAt: account.resetIn === null ? null : now + account.resetIn,
      lastUsedAt: account.usedAgo === undefined ? null : now - account.usedAgo,
      observedAt: now - (account.observedAgo ?? MINUTE),
      stale: account.stale ?? false,
      error: account.error ?? null,
      cells: labels.map((label) => {
        const window = account.windows?.find(
          (candidate) => candidate.label === label,
        );

        return window === undefined
          ? null
          : {
              key: `${account.id}:${label}`,
              percent: window.used,
              tone: window.tone,
              resetAt: null,
              gating: false,
            };
      }),
    })),
  };
}

function poolSnapshot(now: number) {
  return {
    fetchedAt: now,
    error: null,
    poolUnavailable: false,
    groups: [
      group(
        "claude-code",
        "claude",
        [
          {
            id: "acct_claude_2",
            name: "claude2@burlis.de",
            plan: "max",
            remaining: 41,
            resetIn: 5 * DAY,
            serving: "serving",
            usedAgo: 41 * MINUTE,
            windows: [{ label: "FABLE", used: 12, tone: "ok" }],
          },
          {
            id: "acct_claude_3",
            name: "claude3@burlis.de",
            plan: "max",
            remaining: 0,
            resetIn: 4 * HOUR + 48 * MINUTE,
            status: "exhausted",
            usedAgo: 3 * DAY,
            windows: [{ label: "FABLE", used: 55, tone: "ok" }],
          },
          {
            id: "acct_claude_4",
            name: "claude4@burlis.de",
            plan: "max",
            remaining: 0,
            resetIn: 3 * DAY,
            status: "exhausted",
            usedAgo: DAY,
            windows: [{ label: "FABLE", used: 0, tone: "ok" }],
          },
        ],
        now,
      ),
      group(
        "codex",
        "codex",
        [
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a1001",
            name: "openai@burlis.de",
            plan: "promax",
            remaining: 0,
            resetIn: 3 * DAY,
            status: "exhausted",
            usedAgo: DAY,
            credits: 0,
            canResetCredits: true,
          },
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a1002",
            name: "openai2@burlis.de",
            plan: "prolite",
            remaining: 0,
            resetIn: 4 * DAY,
            status: "exhausted",
            usedAgo: 19 * HOUR,
            credits: 0,
            canResetCredits: true,
          },
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a1003",
            name: "openai3@burlis.de",
            plan: "free",
            remaining: 100,
            resetIn: 30 * DAY,
            windowMinutes: 43_200,
            windows: [{ label: "30D", used: 0, tone: "ok" }],
          },
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a1004",
            name: "openai4@burlis.de",
            plan: "free",
            remaining: 100,
            resetIn: 30 * DAY,
            windowMinutes: 43_200,
            credits: 53_499.480526,
            windows: [{ label: "30D", used: 0, tone: "ok" }],
          },
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a1006",
            name: "openai6@burlis.de",
            plan: "free",
            remaining: 100,
            resetIn: 30 * DAY,
            windowMinutes: 43_200,
            usedAgo: HOUR,
            credits: 57_774.5915255,
            windows: [{ label: "30D", used: 0, tone: "ok" }],
          },
        ],
        now,
      ),
    ],
  };
}

function edgeSnapshot(now: number) {
  return {
    fetchedAt: now - 3 * MINUTE,
    error: null,
    poolUnavailable: false,
    groups: [
      group(
        "claude-code",
        "claude",
        [
          {
            id: "acct_edge_pace",
            name: "Over pace",
            plan: "max",
            remaining: 38,
            resetIn: 5 * DAY,
            serving: "serving",
          },
          {
            id: "acct_edge_low5h",
            name: "Five hour low",
            plan: "max",
            remaining: 80,
            resetIn: 2 * DAY,
            fiveHour: { remaining: 6, resetIn: 140 * MINUTE },
          },
          {
            id: "acct_edge_out5h",
            name: "Five hour out",
            plan: "pro",
            remaining: 62,
            resetIn: 6 * DAY,
            status: "held",
            fiveHour: { remaining: 0, resetIn: 100 * MINUTE },
          },
          {
            id: "acct_edge_fable",
            name: "Model limit",
            plan: "max",
            remaining: 70,
            resetIn: 4 * DAY,
            windows: [{ label: "FABLE", used: 92, tone: "warn" }],
          },
          {
            id: "acct_edge_low",
            name: "Weekly low",
            plan: "max",
            remaining: 15,
            resetIn: DAY + 3 * HOUR,
          },
        ],
        now,
      ),
      group(
        "codex",
        "codex",
        [
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a2001",
            name: "Stale reading",
            plan: "plus",
            remaining: 50,
            resetIn: 2 * DAY,
            stale: true,
            observedAgo: 20 * MINUTE,
          },
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a2002",
            name: "Not read yet",
            plan: "plus",
            remaining: null,
            resetIn: null,
          },
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a2003",
            name: "Sign-in failed",
            plan: "pro",
            remaining: 90,
            resetIn: 3 * DAY,
            status: "error",
            error: "Sign in again in the Account Pooler settings.",
          },
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a2004",
            name: "On credits",
            plan: "pro",
            remaining: 1,
            resetIn: 2 * DAY,
            credits: 1_250.5,
          },
          {
            id: "6b1f9c64-1d7e-4f1e-9a51-1d2c0e7a2005",
            name: "Switched off",
            plan: "plus",
            remaining: null,
            resetIn: null,
            status: "disabled",
          },
        ],
        now,
      ),
    ],
  };
}

function resetCredits(input: unknown) {
  const accountId =
    typeof input === "object" &&
    input !== null &&
    "accountId" in input &&
    typeof input.accountId === "string"
      ? input.accountId
      : "";

  const available = accountId.endsWith("1002");

  return {
    accountId,
    availableCount: available ? 2 : 0,
    credits: available
      ? [
          {
            id: "credit-1",
            status: "available",
            expiresAt: new Date(Date.now() + 23 * DAY).toISOString(),
          },
          {
            id: "credit-2",
            status: "available",
            expiresAt: new Date(Date.now() + 40 * DAY).toISOString(),
          },
        ]
      : [],
    fetchedAt: Date.now(),
  };
}

function telemetry() {
  const now = Date.now();

  return {
    from: now - 30 * DAY,
    to: now,
    collectionErrors: 0,
    truncated: false,
    rows: [],
    windows: [],
    speedRows: [
      {
        model: "gpt-6.1-sol",
        effort: "high",
        requestedTier: "default",
        medianTps: 27,
        measuredTurns: 100,
      },
      {
        model: "gpt-6.1-sol",
        effort: "high",
        requestedTier: "fast",
        medianTps: 41.7,
        measuredTurns: 7,
      },
      {
        model: "gpt-6.1-sol",
        effort: "high",
        requestedTier: "ultrafast",
        medianTps: 58.2,
        measuredTurns: 4,
      },
    ],
  };
}

function UsageFooter({ snapshot }: { snapshot: (now: number) => unknown }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const restores = [
      installStoryRealtimeConnected(),
      installStoryPluginRpc({
        [PLUGIN_ID]: {
          snapshot: () => snapshot(Date.now()),
          refresh: () => snapshot(Date.now()),
          codexResetCredits: resetCredits,
          telemetry,
        },
      }),
    ];

    setReady(true);

    return () => {
      for (const restore of restores.reverse()) restore();
    };
  }, [snapshot]);

  useEffect(() => {
    if (!ready) return;

    const timer = window.setTimeout(() => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label$="Show usage details"]',
        )
        ?.click();
    }, 500);

    return () => window.clearTimeout(timer);
  }, [ready]);

  const Card = usageCard.component;

  return (
    <footer className="@container/app-footer fixed inset-x-0 bottom-0 flex h-8 items-center border-t-[0.5px] border-(--material-line) bg-(--material-chrome) px-4 text-xs text-muted-foreground">
      {ready ? (
        <PluginSlotMount
          pluginId={PLUGIN_ID}
          slotKind="sidebarFooterCard"
          slotId="usage"
        >
          <Card experimental_placement="footer" />
        </PluginSlotMount>
      ) : null}
    </footer>
  );
}

export function PooledAccounts() {
  return <UsageFooter snapshot={poolSnapshot} />;
}

export function EdgeStates() {
  return <UsageFooter snapshot={edgeSnapshot} />;
}
