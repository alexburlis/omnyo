import type { z } from "zod";
import type { creditBalanceSchema } from "./pool-contracts.ts";

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

export function providerDisplayName(provider: {
  id: string;
  displayName?: string;
}): string {
  if (provider.displayName !== undefined && provider.displayName !== "")
    return provider.displayName;

  return provider.id
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export interface Until {
  relative: boolean;
  text: string;
}

export function formatUntil(at: number | null, now: number): Until | null {
  if (at === null) return null;
  const delta = at - now;

  if (delta <= MINUTE) return { relative: false, text: "now" };

  if (delta < DAY) {
    const totalMinutes = Math.round(delta / MINUTE);

    if (totalMinutes < 60) return { relative: true, text: `${totalMinutes}m` };
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    return {
      relative: true,
      text: minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`,
    };
  }

  return {
    relative: false,
    text: new Date(at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  };
}

export function untilPhrase(prefix: string, until: Until): string {
  return `${prefix} ${until.relative ? "in " : ""}${until.text}`;
}

export function formatReset(
  resetAt: number | null,
  now: number,
): string | null {
  const until = formatUntil(resetAt, now);

  return until === null ? null : untilPhrase("resets", until);
}

export function formatAbsolute(at: number | null): string | null {
  if (at === null) return null;

  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatAgo(at: number | null, now: number): string | null {
  if (at === null) return null;
  const delta = now - at;

  if (delta < MINUTE) return "just now";

  if (delta < HOUR) return `${Math.round(delta / MINUTE)}m ago`;

  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;

  return `${Math.floor(delta / DAY)}d ago`;
}

export function timeMarkerPercent(
  resetAt: number | null,
  windowMinutes: number | null,
  now: number,
): number | null {
  if (resetAt === null || windowMinutes === null || windowMinutes <= 0)
    return null;
  const remaining = (resetAt - now) / (windowMinutes * MINUTE);

  if (!Number.isFinite(remaining)) return null;

  return Math.min(100, Math.max(0, remaining * 100));
}

type CreditBalance = z.infer<typeof creditBalanceSchema>;

export function formatCreditBalance(balance: CreditBalance): string {
  return balance.unit === "points"
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(balance.amount)} points`
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: balance.currency,
        maximumFractionDigits: 8,
      }).format(balance.amount);
}

export function formatCreditCompact(balance: CreditBalance): string {
  const digits = balance.amount !== 0 && balance.amount < 10 ? 1 : 0;

  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: digits,
    ...(balance.unit === "currency"
      ? { style: "currency", currency: balance.currency }
      : {}),
  }).format(balance.amount);
}
