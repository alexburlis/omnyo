import type { ExperimentalPluginProviderModelNotice } from "@omnyo/plugin-sdk";
import type { AccountSummary, PoolProvider } from "./contracts.js";
import { rejoinAt } from "./quota.js";

const PROVIDER_LABELS: Record<PoolProvider, string> = {
  codex: "OpenAI",
  claude: "Claude",
};

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
  threshold: number,
  now: number,
): ExperimentalPluginProviderModelNotice | null {
  const enabled = accounts.filter(
    (account) => account.provider === provider && account.enabled,
  );

  if (enabled.length === 0 || enabled.some(servesNow)) return null;

  const everyUsedUp = enabled.every(
    (account) => account.status === "exhausted",
  );

  const resets = enabled
    .map((account) => resetAt(account, threshold, now))
    .filter((at) => at !== null);

  return {
    message: everyUsedUp
      ? `${PROVIDER_LABELS[provider]} used up`
      : `${PROVIDER_LABELS[provider]} accounts unavailable`,
    detail: null,
    until: everyUsedUp && resets.length > 0 ? Math.min(...resets) : null,
  };
}
