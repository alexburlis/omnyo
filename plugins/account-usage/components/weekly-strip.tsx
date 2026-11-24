import type { WeeklyBar } from "../contract.ts";
import {
  formatAbsolute,
  formatReset,
  timeMarkerPercent,
} from "../lib/format.ts";

export function fiveHourLabel(bar: WeeklyBar, now: number): string | null {
  const warning = bar.fiveHourWarning;

  if (warning === null || (warning.resetAt !== null && warning.resetAt <= now))
    return null;

  if (warning.exhausted) return "5h exhausted";

  if (warning.remainingPercent === null) return null;
  const remaining = warning.remainingPercent;

  const percent =
    remaining < 1
      ? "<1"
      : remaining > 9
        ? "<10"
        : String(Math.round(remaining));

  return `5h ${percent}%`;
}

export function weeklyBarHint(
  bar: WeeklyBar,
  providerName: string,
  now: number,
): string {
  const parts = [`${providerName} · ${bar.name}`];
  const fiveHour = fiveHourLabel(bar, now);
  const exhausted = fiveHour !== null && bar.fiveHourWarning!.exhausted;

  if (bar.plan !== null) parts.push(bar.plan);

  if (!exhausted) {
    parts.push(
      bar.remainingPercent === null
        ? "no weekly usage observed yet"
        : `${bar.remainingPercent}% of the week left`,
    );
  }

  const marker = timeMarkerPercent(bar.resetAt, bar.windowMinutes, now);

  if (!exhausted && marker !== null)
    parts.push(`${Math.round(100 - marker)}% of the week elapsed`);

  if (bar.serving === "serving") parts.push("serving a request right now");
  else if (bar.serving === "next") parts.push("most recently used");
  const reset = formatReset(bar.resetAt, now);

  if (!exhausted && reset !== null)
    parts.push(`${formatAbsolute(bar.resetAt)} (${reset})`);

  if (fiveHour !== null) {
    parts.push(
      `5-hour usage limit: ${fiveHour.slice(3)}${exhausted ? "" : " left"}`,
    );
    const fiveHourReset = formatReset(bar.fiveHourWarning!.resetAt, now);

    parts.push(
      fiveHourReset !== null ? `5h ${fiveHourReset}` : "5h reset time unknown",
    );
  }

  return parts.join(" · ");
}
