import type { ExperimentalPluginProviderModelNotice } from "@omnyo/plugin-sdk";
import type { AccountSummary, PoolProvider } from "./contracts.js";
import { rejoinAt } from "./quota.js";

const PROVIDER_LABELS: Record<PoolProvider, string> = {
  codex: "OpenAI",
  claude: "Claude",
};

function shortLabel(label: string): string {
  const at = label.indexOf("@");

  return at > 0 ? label.slice(0, at + 1) : label;
}

function servesNow(account: AccountSummary): boolean {
  return account.status === "ready" || account.status === "held";
}

function resetAt(
  account: AccountSummary,
  threshold: number,
  now: number,
): number | null {
  const at = rejoinAt(account, null, threshold, now);

  return at !== null && at > now ? at : null;
}

export function poolModelNotice(
  accounts: readonly AccountSummary[],
  provider: PoolProvider,
  activeAccountId: string | null,
  threshold: number,
  now: number,
): ExperimentalPluginProviderModelNotice | null {
  const enabled = accounts
    .filter((account) => account.provider === provider && account.enabled)
    .sort((left, right) => left.priority - right.priority);

  const [primary] = enabled;

  if (primary === undefined) return null;

  const activeIndex = enabled.findIndex(
    (account) => account.id === activeAccountId,
  );

  const fromActive =
    activeIndex < 0
      ? enabled
      : [...enabled.slice(activeIndex), ...enabled.slice(0, activeIndex)];

  const serving = fromActive.find(servesNow);

  if (serving === undefined) {
    const resets = enabled
      .map((account) => resetAt(account, threshold, now))
      .filter((at) => at !== null);

    const everyUsedUp = enabled.every(
      (account) => account.status === "exhausted",
    );

    return {
      message: everyUsedUp
        ? `${PROVIDER_LABELS[provider]} used up`
        : `${PROVIDER_LABELS[provider]} accounts unavailable`,
      detail: null,
      until: everyUsedUp && resets.length > 0 ? Math.min(...resets) : null,
    };
  }

  if (serving.id === primary.id) return null;

  if (servesNow(primary)) return null;

  const first = shortLabel(primary.label);
  const current = shortLabel(serving.label);

  const usedUp = primary.status === "exhausted";

  return {
    message: `${first} ${usedUp ? "used up" : "unavailable"}`,
    detail: `Using ${current}`,
    until: usedUp ? resetAt(primary, threshold, now) : null,
  };
}
