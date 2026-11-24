import { experimental_ProviderIcon as ProviderIcon } from "@omnyo/plugin-sdk/app";
import type { Group, WeeklyBar } from "../contract.ts";
import { STALE_AFTER_MS } from "../contract.ts";
import {
  formatAbsolute,
  formatAgo,
  formatCreditBalance,
  formatCreditCompact,
  providerDisplayName,
  timeMarkerPercent,
} from "../lib/format.ts";
import { fiveHourLabel, weeklyBarHint } from "./weekly-strip.tsx";

const SIZE = 26;

const STROKE = 2.5;

const RADIUS = (SIZE - STROKE) / 2;

const CENTER = SIZE / 2;

export type Tone = "ok" | "low" | "critical" | "none";

const ARC_TONE: Record<Tone, string> = {
  ok: "stroke-success",
  low: "stroke-warning",
  critical: "stroke-destructive",
  none: "stroke-subtle-foreground",
};

const TRACK_TONE: Record<Tone, string> = {
  ok: "stroke-success/20",
  low: "stroke-warning/20",
  critical: "stroke-destructive/25",
  none: "stroke-subtle-foreground/35",
};

export const TONE_FILL: Record<Tone, string> = {
  ok: "bg-success",
  low: "bg-warning",
  critical: "bg-destructive",
  none: "bg-subtle-foreground",
};

const VALUE_LARGE =
  "text-xs font-semibold text-sidebar-foreground max-md:pointer-coarse:text-2xs";

const VALUE_SMALL = "text-2xs font-semibold text-sidebar-foreground";

const VALUE_MUTED = "text-2xs font-medium text-subtle-foreground";

const VALUE_BLOCKED = "text-2xs font-semibold text-destructive-text";

export interface Reading {
  label: string;
  value: string;
  valueClass: string;
  arc: number | null;
  tone: Tone;
  dimmed: boolean;
  pace: number | null;
  unknown: boolean;
  stale: boolean;
  disabled: boolean;
  credits: boolean;
  fiveHour: "low" | "exhausted" | null;
}

export function remainingTone(percent: number | null): Tone {
  if (percent === null) return "none";

  if (percent <= 5) return "critical";

  if (percent <= 20) return "low";

  return "ok";
}

export function untilLabel(at: number | null, now: number): string {
  if (at === null) return "?";
  const minutes = (at - now) / 60_000;

  if (minutes < 60) return "<1h";
  const hours = Math.round(minutes / 60);

  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export function creditsLeft(
  credits: NonNullable<WeeklyBar["credits"]>,
): string {
  if (credits.unlimited) return "unlimited credits";

  if (credits.balance === null) return "credits available, balance unknown";

  return credits.balance.amount === 0
    ? "credits used up"
    : `${formatCreditBalance(credits.balance)} credit left`;
}

function readCredits(
  credits: NonNullable<WeeklyBar["credits"]>,
  hint: string,
): Reading {
  const empty =
    !credits.unlimited &&
    credits.balance !== null &&
    credits.balance.amount === 0;

  return {
    label: `${hint} · Included usage spent · ${creditsLeft(credits)}`,
    value: credits.unlimited
      ? "∞"
      : credits.balance === null
        ? "cr"
        : formatCreditCompact(credits.balance),
    valueClass: empty ? VALUE_BLOCKED : VALUE_SMALL,
    arc: empty ? null : 100,
    tone: empty ? "critical" : "ok",
    dimmed: false,
    pace: null,
    unknown: false,
    stale: false,
    disabled: false,
    credits: true,
    fiveHour: null,
  };
}

function readGauge(
  bar: WeeklyBar,
  providerName: string,
  now: number,
  stale: boolean,
  observedAt: number | null,
): Reading {
  if (bar.status === "disabled") {
    return {
      label: `${providerName} · ${bar.name} · Disabled`,
      value: "off",
      valueClass: VALUE_MUTED,
      arc: null,
      tone: "none",
      dimmed: false,
      pace: null,
      unknown: false,
      stale: false,
      disabled: true,
      credits: false,
      fiveHour: null,
    };
  }

  const hint = weeklyBarHint(bar, providerName, now);

  if (stale || (bar.resetAt !== null && bar.resetAt <= now)) {
    const age = formatAgo(observedAt, now);

    return {
      label: stale
        ? `Stale reading${age === null ? "" : ` from ${age}`} · ${hint}`
        : `${providerName} · ${bar.name} · Reset passed ${formatAbsolute(bar.resetAt)}; waiting for updated usage`,
      value: "–",
      valueClass: VALUE_MUTED,
      arc: null,
      tone: "none",
      dimmed: false,
      pace: null,
      unknown: true,
      stale,
      disabled: false,
      credits: false,
      fiveHour: null,
    };
  }

  const percent = bar.remainingPercent;
  const tone = remainingTone(percent);
  const fiveHour = fiveHourLabel(bar, now);

  const includedSpent =
    (fiveHour !== null && bar.fiveHourWarning!.exhausted) ||
    (percent !== null && percent < 3);

  if (includedSpent && bar.credits !== null)
    return readCredits(bar.credits, hint);

  if (fiveHour !== null && bar.fiveHourWarning!.exhausted) {
    return {
      label: hint,
      value: untilLabel(bar.fiveHourWarning!.resetAt, now),
      valueClass: VALUE_BLOCKED,
      arc: percent,
      tone,
      dimmed: true,
      pace: null,
      unknown: false,
      stale: false,
      disabled: false,
      credits: false,
      fiveHour: "exhausted",
    };
  }

  const spent = percent !== null && percent < 3 && bar.resetAt !== null;

  const value =
    percent === null
      ? "–"
      : spent
        ? untilLabel(bar.resetAt, now)
        : String(percent);

  return {
    label: hint,
    value,
    valueClass:
      percent === null || spent
        ? VALUE_MUTED
        : value.length > 2
          ? VALUE_SMALL
          : VALUE_LARGE,
    arc: percent,
    tone,
    dimmed: spent,
    pace: spent ? null : timeMarkerPercent(bar.resetAt, bar.windowMinutes, now),
    unknown: percent === null,
    stale: false,
    disabled: false,
    credits: false,
    fiveHour: fiveHour === null ? null : "low",
  };
}

function PaceTick({ percent }: { percent: number }): React.ReactElement {
  const angle = (percent / 100) * 2 * Math.PI;
  const inner = RADIUS - STROKE / 2 - 1;
  const outer = RADIUS + STROKE / 2 + 1;

  return (
    <line
      x1={CENTER + inner * Math.cos(angle)}
      y1={CENTER + inner * Math.sin(angle)}
      x2={CENTER + outer * Math.cos(angle)}
      y2={CENTER + outer * Math.sin(angle)}
      strokeWidth={1.25}
      strokeLinecap="round"
      className="stroke-sidebar-foreground/60"
    />
  );
}

function AccountGauge({
  reading,
  serving,
}: {
  reading: Reading;
  serving: boolean;
}): React.ReactElement {
  return (
    <span
      role="img"
      aria-label={reading.label}
      title={reading.label}
      className="relative grid size-6.5 shrink-0 place-items-center"
    >
      <svg
        aria-hidden={true}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        fill="none"
        className="absolute inset-0 size-full -rotate-90 overflow-visible"
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          strokeWidth={STROKE}
          strokeDasharray={reading.unknown ? "1.5 2.6" : undefined}
          className={TRACK_TONE[reading.tone]}
        />
        {reading.arc !== null && reading.arc > 0 ? (
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            strokeWidth={STROKE}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${Math.min(reading.arc, 100)} 100`}
            className={`${ARC_TONE[reading.tone]} ${reading.dimmed ? "opacity-40" : ""}`}
          />
        ) : null}
        {reading.pace === null ? null : <PaceTick percent={reading.pace} />}
      </svg>
      <span
        aria-hidden={true}
        className={`relative leading-none tracking-tight ${reading.valueClass}`}
      >
        {reading.value}
      </span>
      {serving ? (
        <span
          aria-hidden={true}
          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-sidebar-foreground"
        />
      ) : null}
      {reading.fiveHour === null ? null : (
        <span
          aria-hidden={true}
          className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${
            reading.fiveHour === "exhausted" ? "bg-destructive" : "bg-warning"
          }`}
        />
      )}
    </span>
  );
}

export interface BarReading {
  bar: WeeklyBar;
  reading: Reading;
}

export function readGroup(
  group: Group,
  providerName: string,
  now: number,
): BarReading[] {
  return group.weeklyBars.map((bar) => {
    const account = group.accounts.find((row) => row.id === bar.accountId);

    const stale =
      account?.stale === true ||
      (account?.observedAt != null &&
        now - account.observedAt > STALE_AFTER_MS);

    return {
      bar,
      reading: readGauge(
        bar,
        providerName,
        now,
        stale,
        account?.observedAt ?? null,
      ),
    };
  });
}

export function ProviderGauges({
  group,
  now,
  provider,
}: {
  group: Group;
  now: number;
  provider: { id: string; displayName?: string };
}): React.ReactElement | null {
  const providerName = providerDisplayName({
    id: group.providerId,
    displayName: provider.displayName,
  });

  if (group.weeklyBars.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <ProviderIcon
        providerKind="agent"
        provider={provider}
        fallback="Bot"
        className="size-3.5 shrink-0"
        aria-hidden={true}
      />
      <div className="flex w-full flex-wrap justify-center gap-1.5">
        {readGroup(group, providerName, now).map(({ bar, reading }) => (
          <AccountGauge
            key={bar.accountId}
            reading={reading}
            serving={bar.serving === "serving"}
          />
        ))}
      </div>
    </div>
  );
}
