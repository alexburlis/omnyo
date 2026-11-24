import type { AccountRow } from "../contract.ts";
import { STALE_AFTER_MS } from "../contract.ts";
import {
  formatAbsolute,
  formatCreditBalance,
  formatCreditCompact,
} from "../lib/format.ts";
import { CreditGlyph, RefreshGlyph } from "./glyphs.tsx";

export type CreditEmphasis = "quiet" | "drawing" | "empty";

const EMPHASIS_TONE: Record<CreditEmphasis, string> = {
  quiet: "text-subtle-foreground",
  drawing: "text-muted-foreground",
  empty: "text-destructive-text",
};

export function CreditBalance({
  row,
  now,
  emphasis = "quiet",
}: {
  row: AccountRow;
  now: number;
  emphasis?: CreditEmphasis;
}): React.ReactElement | null {
  const usage = row.extraUsage;

  if (usage == null) return null;
  const balance = usage.creditBalance;

  const reading =
    balance != null
      ? {
          full: formatCreditBalance(balance),
          compact: formatCreditCompact(balance),
        }
      : usage.unlimited === true
        ? { full: "Unlimited", compact: "∞" }
        : usage.hasCredits === true
          ? { full: "Available · balance unknown", compact: "?" }
          : null;

  if (reading === null) return null;
  const stale = now - usage.observedAt > STALE_AFTER_MS;
  const label = `Credits · ${reading.full}${stale ? " · stale" : ""}`;
  const observed = formatAbsolute(usage.observedAt);

  return (
    <span
      data-usage-credit-balance=""
      className={`flex shrink-0 items-center gap-0.5 text-2xs leading-none tabular-nums ${
        stale ? "text-warning-text" : EMPHASIS_TONE[emphasis]
      }`}
      title={observed === null ? label : `${label} · read ${observed}`}
    >
      {stale ? (
        <RefreshGlyph className="size-2.5 shrink-0" strokeWidth="2.6" />
      ) : (
        <CreditGlyph />
      )}
      <span aria-hidden={true}>{reading.compact}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
