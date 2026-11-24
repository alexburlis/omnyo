import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_ProviderIcon as ProviderIcon,
} from "@omnyo/plugin-sdk/app";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import type { AccountRow, Group, Snapshot } from "../contract.ts";
import {
  formatAgo,
  formatCreditCompact,
  formatReset,
  formatUntil,
  providerDisplayName,
  timeMarkerPercent,
  untilPhrase,
} from "../lib/format.ts";
import {
  creditsLeft,
  readGroup,
  remainingTone,
  TONE_FILL,
  untilLabel,
  type BarReading,
  type Tone,
} from "./usage-rail.tsx";
import { CreditBalance, type CreditEmphasis } from "./credit-balance.tsx";
import { CreditGlyph, RefreshGlyph, RestingGlyph } from "./glyphs.tsx";
import { ResetCredits } from "./reset-credits.tsx";
import {
  AccountRepair,
  signedOut,
  type AccountSignIn,
} from "./account-repair.tsx";
import { fiveHourLabel } from "./weekly-strip.tsx";
import { SpeedAllowance } from "./speed-allowance.tsx";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";

type ProviderRecord = { id: string; displayName?: string };

const STATUS_DOT: Record<AccountRow["status"], string> = {
  ready: "bg-success",
  exhausted: "bg-destructive",
  held: "bg-warning",
  error: "bg-destructive",
  disabled: "bg-subtle-foreground",
};

const STATUS_LABEL: Record<AccountRow["status"], string> = {
  ready: "Ready",
  exhausted: "Limit reached",
  held: "Rate limited",
  error: "Needs attention",
  disabled: "Switched off",
};

const SERVING_HALO: Record<AccountRow["status"], string> = {
  ready: "ring-success/25",
  exhausted: "ring-destructive/25",
  held: "ring-warning/25",
  error: "ring-destructive/25",
  disabled: "ring-subtle-foreground/25",
};

const VALUE_TONE = {
  ok: "text-sidebar-foreground",
  low: "text-warning-text",
  critical: "text-destructive-text",
  none: "text-subtle-foreground",
} as const;

function isPercent(value: string): boolean {
  return /^\d+$/.test(value);
}

function accountPhrase({ bar, reading }: BarReading, now: number): string {
  if (reading.disabled) return `${bar.name} is disabled`;

  if (reading.stale) return `${bar.name} has a stale reading`;

  if (reading.unknown) return `${bar.name} has no current reading`;

  if (reading.credits && bar.credits !== null)
    return `${bar.name} spent its included usage, ${creditsLeft(bar.credits)}`;

  if (reading.fiveHour === "exhausted") {
    return `${bar.name} hit its 5-hour limit, ${formatReset(bar.fiveHourWarning!.resetAt, now) ?? "reset time unknown"}`;
  }

  if (!isPercent(reading.value)) {
    return `${bar.name} spent its week, ${formatReset(bar.resetAt, now) ?? "reset time unknown"}`;
  }

  const parts = [`${bar.name} ${reading.value}% of the week left`];
  const fiveHour = fiveHourLabel(bar, now);

  if (reading.fiveHour === "low" && fiveHour !== null)
    parts.push(`${fiveHour.slice(3)} of the 5-hour limit left`);

  if (bar.serving === "serving") parts.push("serving now");

  return parts.join(", ");
}

const FOOTER_VALUE_TONE = {
  ok: "text-muted-foreground",
  low: "text-warning-text",
  critical: "text-destructive-text",
  none: "text-subtle-foreground",
} as const;

function isResting({ reading }: BarReading): boolean {
  return (
    !reading.unknown &&
    !reading.disabled &&
    !reading.credits &&
    (reading.fiveHour === "exhausted" || !isPercent(reading.value))
  );
}

type MeterReading = Pick<
  BarReading["reading"],
  "arc" | "tone" | "dimmed" | "disabled" | "unknown"
>;

function meterTrack(reading: MeterReading): string {
  if (reading.disabled) return "bg-sidebar-foreground/8";

  if (reading.unknown)
    return "bg-transparent ring-1 ring-sidebar-foreground/25 ring-inset";

  return "bg-sidebar-foreground/12";
}

const FIVE_HOUR_TAG: Record<Tone, string> = {
  ok: "bg-sidebar-foreground/10 text-muted-foreground",
  low: "bg-warning/15 text-warning-text",
  critical: "bg-destructive/15 text-destructive-text",
  none: "bg-sidebar-foreground/10 text-subtle-foreground",
};

export function providerTotal(
  group: Group,
  providerName: string,
  now: number,
): {
  percent: number | null;
  usable: number;
  credits: { value: string; tone: Tone } | null;
} {
  const counted = readGroup(group, providerName, now).filter(
    ({ reading }) => !reading.disabled && !reading.unknown,
  );

  if (counted.length === 0) return { percent: null, usable: 0, credits: null };

  const sum = counted.reduce(
    (total, { bar }) => total + (bar.remainingPercent ?? 0),
    0,
  );

  const included = counted.filter(
    (entry) => !isResting(entry) && !entry.reading.credits,
  );

  return {
    percent: Math.round(sum / counted.length),
    usable: counted.filter((entry) => !isResting(entry)).length,
    credits: included.length === 0 ? totalCredits(counted) : null,
  };
}

function totalCredits(
  entries: BarReading[],
): { value: string; tone: Tone } | null {
  const credits = entries.flatMap(({ bar, reading }) =>
    reading.credits && bar.credits !== null ? [bar.credits] : [],
  );

  if (credits.length === 0) return null;

  if (credits.some((entry) => entry.unlimited))
    return { value: "∞", tone: "ok" };

  const balances = credits.flatMap((entry) =>
    entry.balance === null ? [] : [entry.balance],
  );

  const first = balances[0];

  if (
    first === undefined ||
    balances.length !== credits.length ||
    balances.some(
      (balance) =>
        balance.unit !== first.unit ||
        (balance.unit === "currency" &&
          first.unit === "currency" &&
          balance.currency !== first.currency),
    )
  )
    return { value: "cr", tone: "ok" };
  const amount = balances.reduce((total, balance) => total + balance.amount, 0);

  return {
    value: formatCreditCompact({ ...first, amount }),
    tone: amount === 0 ? "critical" : "ok",
  };
}

type RingValue =
  | { kind: "percent"; percent: number; fiveHour: Tone | null }
  | { kind: "credits"; text: string }
  | { kind: "resting"; text: string; tone: "quiet" | "critical" }
  | { kind: "stale" }
  | { kind: "none"; text: string };

interface RingModel {
  label: string;
  arc: number | null;
  tone: Tone;
  dimmed: boolean;
  unknown: boolean;
  value: RingValue;
}

const RING_ARC: Record<Tone, string> = {
  ok: "stroke-muted-foreground",
  low: "stroke-warning",
  critical: "stroke-destructive",
  none: "stroke-subtle-foreground",
};

function headlineEntry(entries: BarReading[]): BarReading | null {
  return (
    entries.find(({ bar }) => bar.serving === "serving") ??
    entries.find(({ bar }) => bar.serving === "next") ??
    (entries.length === 1 ? entries[0]! : null)
  );
}

function accountRing(entry: BarReading): RingModel {
  const { bar, reading } = entry;

  const base = {
    label: reading.label,
    arc: reading.arc,
    tone: reading.tone,
    dimmed: reading.dimmed,
    unknown: reading.unknown || reading.disabled,
  };

  if (reading.disabled)
    return { ...base, value: { kind: "none", text: "off" } };

  if (reading.stale) return { ...base, value: { kind: "stale" } };

  if (reading.unknown) return { ...base, value: { kind: "none", text: "–" } };

  if (reading.credits)
    return { ...base, value: { kind: "credits", text: reading.value } };

  if (isResting(entry)) {
    return {
      ...base,
      value: { kind: "resting", text: reading.value, tone: "quiet" },
    };
  }

  return {
    ...base,
    value: {
      kind: "percent",
      percent: Number(reading.value),
      fiveHour:
        reading.fiveHour === "low"
          ? remainingTone(bar.fiveHourWarning?.remainingPercent ?? null)
          : null,
    },
  };
}

function summaryRing(
  group: Group,
  providerName: string,
  now: number,
): RingModel {
  const { percent, usable, credits } = providerTotal(group, providerName, now);
  const tone = remainingTone(percent);
  const accounts = group.weeklyBars.length;

  const base = {
    arc: percent,
    tone,
    dimmed: usable === 0,
    unknown: percent === null,
  };

  if (percent === null) {
    return {
      ...base,
      label: `${providerName} · no current reading`,
      value: { kind: "none", text: "–" },
    };
  }

  if (credits !== null) {
    return {
      ...base,
      arc: credits.tone === "critical" ? 0 : 100,
      tone: credits.tone,
      label: `${providerName} · included usage spent on every account · credits ${credits.value}`,
      value: { kind: "credits", text: credits.value },
    };
  }

  if (usable === 0) {
    const next = formatUntil(group.nextCapacityAt, now);

    return {
      ...base,
      label: `${providerName} · no account usable · ${
        next === null ? "return time unknown" : untilPhrase("back", next)
      }`,
      value: {
        kind: "resting",
        text: untilLabel(group.nextCapacityAt, now),
        tone: "critical",
      },
    };
  }

  return {
    ...base,
    label: `${providerName} · no account in use · ${percent}% of the week left on average across ${accounts} accounts`,
    value: { kind: "percent", percent, fiveHour: null },
  };
}

function RingValueText({
  value,
  tone,
}: {
  value: RingValue;
  tone: Tone;
}): React.ReactElement {
  if (value.kind === "stale") {
    return (
      <span
        data-usage-stale=""
        className="flex items-center text-subtle-foreground"
      >
        <RefreshGlyph className="size-2.5 shrink-0" strokeWidth="2.6" />
      </span>
    );
  }

  if (value.kind === "none")
    return <span className="text-subtle-foreground">{value.text}</span>;

  if (value.kind === "credits") {
    return (
      <span
        data-usage-credits=""
        className={`flex items-center gap-0.5 ${FOOTER_VALUE_TONE[tone]}`}
      >
        {tone === "ok" ? null : <CreditGlyph />}
        {value.text}
      </span>
    );
  }

  if (value.kind === "resting") {
    return (
      <span
        className={`flex items-center gap-0.5 ${
          value.tone === "critical"
            ? "text-destructive-text"
            : "text-subtle-foreground"
        }`}
      >
        <RestingGlyph />
        {value.text}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <span className={FOOTER_VALUE_TONE[tone]}>
        {value.percent}
        <span className="text-subtle-foreground">%</span>
      </span>
      {value.fiveHour === null ? null : (
        <span
          className={`rounded-full px-1 py-px text-2xs leading-none font-semibold ${FIVE_HOUR_TAG[value.fiveHour]}`}
        >
          5h
        </span>
      )}
    </span>
  );
}

function ProviderRing({
  group,
  provider,
  now,
}: {
  group: Group;
  provider: ProviderRecord;
  now: number;
}): React.ReactElement {
  const providerName = providerDisplayName(provider);
  const headline = headlineEntry(readGroup(group, providerName, now));

  const ring =
    headline === null
      ? summaryRing(group, providerName, now)
      : accountRing(headline);

  const arc = ring.arc === null ? 0 : Math.min(Math.max(ring.arc, 0), 100);

  return (
    <span
      data-usage-ring={group.providerId}
      title={ring.label}
      className="flex shrink-0 items-center gap-1.5"
    >
      <span
        aria-hidden={true}
        className="relative grid size-4.5 shrink-0 place-items-center"
      >
        <svg
          viewBox="0 0 18 18"
          fill="none"
          className="absolute inset-0 size-full -rotate-90"
        >
          <circle
            cx={9}
            cy={9}
            r={7.5}
            strokeWidth={1.75}
            strokeDasharray={ring.unknown ? "1.5 2.4" : undefined}
            className="stroke-sidebar-foreground/15"
          />
          {ring.unknown || arc === 0 ? null : (
            <circle
              cx={9}
              cy={9}
              r={7.5}
              strokeWidth={1.75}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${arc} 100`}
              className={`${RING_ARC[ring.tone]} ${ring.dimmed ? "opacity-40" : ""}`}
            />
          )}
        </svg>
        <ProviderIcon
          providerKind="agent"
          provider={provider}
          fallback="Bot"
          className="relative size-2.5 shrink-0 opacity-80"
          aria-hidden={true}
        />
      </span>
      <RingValueText value={ring.value} tone={ring.tone} />
    </span>
  );
}

const HOVER_OPEN_DELAY_MS = 200;

const HOVER_CLOSE_DELAY_MS = 250;

type DetailsMode = "closed" | "hover" | "pinned";

function useHoverDetails() {
  const [mode, setMode] = useState<DetailsMode>("closed");
  const modeRef = useRef<DetailsMode>("closed");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const change = useCallback((next: DetailsMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const enter = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "touch") return;
      clear();

      if (modeRef.current !== "closed") return;
      timer.current = setTimeout(() => {
        timer.current = null;

        if (modeRef.current === "closed") change("hover");
      }, HOVER_OPEN_DELAY_MS);
    },
    [change, clear],
  );

  const leave = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "touch") return;
      clear();

      if (modeRef.current === "pinned") return;
      timer.current = setTimeout(() => {
        timer.current = null;

        if (modeRef.current === "hover") change("closed");
      }, HOVER_CLOSE_DELAY_MS);
    },
    [change, clear],
  );

  const pin = useCallback(() => {
    clear();

    if (modeRef.current === "hover") change("pinned");
  }, [change, clear]);

  const onTriggerClick = useCallback(
    (event: React.MouseEvent) => {
      if (modeRef.current !== "hover") return;
      event.preventDefault();
      pin();
    },
    [pin],
  );

  const onOpenChange = useCallback(
    (open: boolean) => {
      clear();
      change(open ? "pinned" : "closed");
    },
    [change, clear],
  );

  return {
    open: mode !== "closed",
    modeRef,
    enter,
    leave,
    pin,
    onTriggerClick,
    onOpenChange,
  };
}

const NOTE_TONE = {
  quiet: "text-subtle-foreground",
  strong: "text-sidebar-foreground",
  warning: "text-warning-text",
  critical: "text-destructive-text",
} as const;

type NoteTone = keyof typeof NOTE_TONE;

interface AccountNote {
  text: string;
  spoken: string;
  tone: NoteTone;
  clock: boolean;
}

interface UsageWindow {
  key: string;
  label: string;
  remaining: number;
  tone: NoteTone;
}

function usageWindows(
  group: Group,
  row: AccountRow | undefined,
): UsageWindow[] {
  if (row === undefined) return [];

  return row.cells.flatMap((cell, index) => {
    const column = group.columns[index];

    if (
      cell === null ||
      cell.percent === null ||
      column === undefined ||
      column.label === "7D" ||
      cell.tone === "elapsed"
    )
      return [];

    return [
      {
        key: cell.key,
        label: column.label.toLowerCase(),
        remaining: 100 - cell.percent,
        tone:
          cell.tone === "blocked"
            ? "critical"
            : cell.tone === "warn"
              ? "warning"
              : "quiet",
      },
    ];
  });
}

interface FiveHourState {
  label: string | null;
  exhausted: boolean;
  resetAt: number | null;
}

function fiveHourState(entry: BarReading, now: number): FiveHourState {
  const label = fiveHourLabel(entry.bar, now);
  const warning = entry.bar.fiveHourWarning;

  return {
    label,
    exhausted: label !== null && warning?.exhausted === true,
    resetAt: warning?.resetAt ?? null,
  };
}

function weeklyGone({ bar, reading }: BarReading): boolean {
  if (reading.disabled || reading.unknown) return false;

  return (
    bar.status === "exhausted" ||
    (bar.remainingPercent !== null && bar.remainingPercent < 3)
  );
}

function resetNote(
  at: number | null,
  now: number,
  spokenPrefix: string,
  tone: NoteTone,
  clock: boolean,
): AccountNote {
  const until = formatUntil(at, now);

  return {
    text: until?.text ?? "–",
    spoken:
      until === null
        ? `${spokenPrefix}, reset time unknown`
        : `${spokenPrefix}, ${untilPhrase("resets", until)}`,
    tone,
    clock,
  };
}

function accountNote(
  entry: BarReading,
  row: AccountRow | undefined,
  windows: UsageWindow[],
  fiveHour: FiveHourState,
  now: number,
): AccountNote {
  const { bar, reading } = entry;

  if (reading.disabled)
    return { text: "off", spoken: "Disabled", tone: "quiet", clock: false };

  if (row?.status === "error") {
    return {
      text: "",
      spoken: signedOut(row) ? "Signed out" : row.statusLabel,
      tone: "critical",
      clock: false,
    };
  }

  if (reading.stale) {
    const age = formatAgo(row?.observedAt ?? null, now);

    return {
      text: "stale",
      spoken: `Stale reading${age === null ? "" : ` from ${age}`}`,
      tone: "warning",
      clock: false,
    };
  }

  if (reading.unknown) {
    return {
      text: "–",
      spoken: "No current reading",
      tone: "quiet",
      clock: false,
    };
  }

  if (weeklyGone(entry))
    return resetNote(bar.resetAt, now, "Weekly limit spent", "strong", true);

  if (fiveHour.exhausted) {
    return resetNote(
      fiveHour.resetAt,
      now,
      "5-hour limit reached",
      "critical",
      true,
    );
  }

  if (bar.status === "held") {
    return {
      text: "limited",
      spoken: row?.statusLabel ?? "Rate limited",
      tone: "warning",
      clock: false,
    };
  }

  if (fiveHour.label !== null) {
    const reset = formatReset(fiveHour.resetAt, now);

    return {
      text: fiveHour.label,
      spoken: `${fiveHour.label.slice(3)} of the 5-hour limit left${reset === null ? "" : `, ${reset}`}`,
      tone: "warning",
      clock: false,
    };
  }

  const tightest = windows
    .filter(
      (window) =>
        window.tone !== "quiet" &&
        window.label !== "5h" &&
        bar.remainingPercent !== null &&
        window.remaining < bar.remainingPercent,
    )
    .sort((left, right) => left.remaining - right.remaining)[0];

  if (tightest !== undefined) {
    return {
      text: `${tightest.label} ${tightest.remaining}%`,
      spoken: `${tightest.label} limit ${tightest.remaining}% left`,
      tone: tightest.tone,
      clock: false,
    };
  }

  const reset = formatUntil(bar.resetAt, now);

  return {
    text: reset?.text ?? "",
    spoken: reset === null ? "" : untilPhrase("resets", reset),
    tone: "quiet",
    clock: false,
  };
}

interface MeterModel {
  percent: number | null;
  tone: Tone;
  dimmed: boolean;
  disabled: boolean;
  unknown: boolean;
  pace: number | null;
  overPace: boolean;
}

const PACE_EDGE = 2;

function meterModel(
  entry: BarReading,
  fiveHour: FiveHourState,
  failed: boolean,
  now: number,
): MeterModel {
  const { bar, reading } = entry;

  const percent =
    reading.disabled || reading.unknown ? null : bar.remainingPercent;

  const dimmed = weeklyGone(entry) || fiveHour.exhausted || failed;
  const marker = timeMarkerPercent(bar.resetAt, bar.windowMinutes, now);

  const pace =
    percent === null ||
    dimmed ||
    marker === null ||
    marker <= PACE_EDGE ||
    marker >= 100 - PACE_EDGE
      ? null
      : marker;

  return {
    percent,
    tone: remainingTone(percent),
    dimmed,
    disabled: reading.disabled,
    unknown: reading.unknown,
    pace,
    overPace: pace !== null && percent !== null && percent + 10 < pace,
  };
}

function DetailMeter({ meter }: { meter: MeterModel }): React.ReactElement {
  const { percent, pace } = meter;

  return (
    <span
      aria-hidden={true}
      className={`relative block h-1.5 w-full rounded-full ${meterTrack({
        arc: percent,
        tone: meter.tone,
        dimmed: meter.dimmed,
        disabled: meter.disabled,
        unknown: meter.unknown,
      })}`}
    >
      <span className="absolute inset-0 overflow-hidden rounded-full">
        {meter.overPace && percent !== null && pace !== null ? (
          <span
            data-usage-over-pace=""
            className="absolute inset-y-0 bg-warning/35"
            style={{ left: `${percent}%`, width: `${pace - percent}%` }}
          />
        ) : null}
        {percent !== null && percent > 0 ? (
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${TONE_FILL[meter.tone]} ${
              meter.dimmed ? "opacity-40" : ""
            }`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        ) : null}
      </span>
      {pace === null ? null : (
        <span
          className="absolute -top-[3px] -bottom-[3px] w-px rounded-full bg-sidebar-foreground/45"
          style={{ left: `${pace}%`, marginLeft: "-0.5px" }}
        />
      )}
    </span>
  );
}

function meterLabel(
  entry: BarReading,
  windows: UsageWindow[],
  meter: MeterModel,
): string {
  const parts = [entry.reading.label];

  if (windows.length > 0) {
    parts.push(
      windows
        .map((window) => `${window.label} ${window.remaining}% left`)
        .join(", "),
    );
  }

  if (meter.overPace)
    parts.push("Over pace: using the week faster than it passes");

  return parts.join(" · ");
}

function accountValue(
  { bar, reading }: BarReading,
  meter: MeterModel,
): { text: string; className: string } {
  const percent = bar.remainingPercent;

  if (reading.disabled || reading.unknown || percent === null)
    return { text: "–", className: "text-subtle-foreground" };

  return {
    text: `${percent}%`,
    className: meter.dimmed
      ? "text-subtle-foreground"
      : VALUE_TONE[remainingTone(percent)],
  };
}

function creditEmphasis({ reading }: BarReading): CreditEmphasis {
  if (!reading.credits) return "quiet";

  return reading.tone === "critical" ? "empty" : "drawing";
}

function sharedDomain(groups: readonly Group[]): string | null {
  const names = groups.flatMap((group) =>
    group.weeklyBars.map((bar) => bar.name),
  );

  const domains = new Set(
    names.map((name) => /^[^@\s]+(@[^@\s]+)$/.exec(name)?.[1] ?? null),
  );

  const [domain] = domains;

  return names.length > 1 && domains.size === 1 && domain != null
    ? domain
    : null;
}

const DETAIL_COLUMNS =
  "grid-cols-[0.375rem_minmax(0,1fr)_4rem_2.25rem_3.25rem]";

function DetailColumns(): React.ReactElement {
  return (
    <p
      aria-hidden={true}
      data-usage-columns=""
      className={`m-0 grid items-end gap-x-2 px-2 pt-1 text-2xs leading-4 text-subtle-foreground ${DETAIL_COLUMNS}`}
    >
      <span />
      <span>Account</span>
      <span className="col-span-2 text-right">Week left</span>
      <span />
    </p>
  );
}

function UsageLegend(): React.ReactElement {
  return (
    <p
      data-usage-legend=""
      className="m-0 mx-2 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-sidebar-border pt-2 text-2xs leading-4 text-muted-foreground"
    >
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden={true}
          className="size-1.5 rounded-full bg-success ring-[3px] ring-success/25"
        />
        Serving now
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden={true}
          className="relative block h-1.5 w-4 rounded-full bg-sidebar-foreground/12"
        >
          <span className="absolute -top-[3px] -bottom-[3px] left-1/2 w-px bg-sidebar-foreground/45" />
        </span>
        Time left this week
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden={true}
          className="block h-1.5 w-4 overflow-hidden rounded-full bg-warning/35"
        />
        Using it faster than time passes
      </span>
      <span className="flex items-center gap-1">
        <RestingGlyph />
        Back in
      </span>
    </p>
  );
}

function DetailAccount({
  entry,
  group,
  displayName,
  now,
  onUsageChanged,
  resetCreditsRevision,
  signIn,
}: {
  entry: BarReading;
  group: Group;
  displayName: string;
  now: number;
  onUsageChanged: () => Promise<void>;
  resetCreditsRevision: number;
  signIn: AccountSignIn;
}): React.ReactElement {
  const { bar, reading } = entry;
  const row = group.accounts.find((account) => account.id === bar.accountId);
  const windows = reading.disabled ? [] : usageWindows(group, row);
  const fiveHour = fiveHourState(entry, now);
  const meter = meterModel(entry, fiveHour, row?.status === "error", now);
  const note = accountNote(entry, row, windows, fiveHour, now);
  const value = accountValue(entry, meter);
  const label = meterLabel(entry, windows, meter);
  const used = formatAgo(row?.lastUsedAt ?? null, now);

  const statusTitle =
    bar.serving === "serving"
      ? `${STATUS_LABEL[bar.status]} · in use now`
      : STATUS_LABEL[bar.status];

  const nameTitle = [
    bar.name,
    bar.status === "ready" ? null : STATUS_LABEL[bar.status],
    bar.serving === "serving"
      ? "serving now"
      : used === null
        ? null
        : `used ${used}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <li
      className={`grid list-none items-center gap-x-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent/50 ${DETAIL_COLUMNS}`}
    >
      <span
        aria-hidden={true}
        title={statusTitle}
        className={`size-1.5 rounded-full ${STATUS_DOT[bar.status]} ${
          bar.serving === "serving"
            ? `ring-[3px] ${SERVING_HALO[bar.status]}`
            : ""
        }`}
      />
      <span className="flex min-w-0 items-center gap-1.5" title={nameTitle}>
        <span className="min-w-0 truncate text-xs leading-4 font-medium text-sidebar-foreground">
          {displayName}
        </span>
        {bar.plan !== null ? (
          <span className="shrink-0 text-2xs leading-none text-subtle-foreground">
            {bar.plan}
          </span>
        ) : null}
        {row ? (
          <CreditBalance row={row} now={now} emphasis={creditEmphasis(entry)} />
        ) : null}
      </span>
      <span role="img" aria-label={label} title={label}>
        <DetailMeter meter={meter} />
      </span>
      <span
        className={`text-right text-xs leading-4 font-semibold tabular-nums ${value.className}`}
      >
        {value.text}
      </span>
      <span
        className={`flex min-w-0 items-center justify-end gap-0.5 text-2xs leading-4 tabular-nums ${NOTE_TONE[note.tone]}`}
        title={note.spoken}
      >
        {note.clock ? <RestingGlyph /> : null}
        <span aria-hidden={true} className="truncate">
          {note.text}
        </span>
        <span className="sr-only">{note.spoken}</span>
      </span>
      {row === undefined ? null : (
        <div className="col-[2/-1] empty:hidden">
          <AccountRepair
            row={row}
            accountName={bar.name}
            signIn={signIn}
            onUsageChanged={onUsageChanged}
          />
        </div>
      )}
      {row?.canResetCredits === true &&
      !signedOut(row) &&
      signIn.state?.accountId !== row.id ? (
        <div className="col-[2/-1]">
          <ResetCredits
            accountId={row.id}
            accountName={bar.name}
            now={now}
            onUsageChanged={onUsageChanged}
            refreshRevision={resetCreditsRevision}
          />
        </div>
      ) : null}
    </li>
  );
}

function DetailGroup({
  group,
  provider,
  domain,
  now,
  onUsageChanged,
  resetCreditsRevision,
  signIn,
}: {
  group: Group;
  provider: ProviderRecord;
  domain: string | null;
  now: number;
  onUsageChanged: () => Promise<void>;
  resetCreditsRevision: number;
  signIn: AccountSignIn;
}): React.ReactElement | null {
  if (group.weeklyBars.length === 0) return null;
  const providerName = providerDisplayName(provider);
  const next = formatUntil(group.nextCapacityAt, now);

  const summary = !group.routingEnabled
    ? "routing off"
    : `${group.readyCount} of ${group.totalCount} ready${
        group.readyCount === 0 && next !== null
          ? ` · ${untilPhrase("back", next)}`
          : ""
      }`;

  return (
    <section aria-label={providerName} className="flex flex-col">
      <h3 className="m-0 flex items-center gap-1.5 px-2 pt-2 pb-1 text-xs leading-4 font-semibold">
        <ProviderIcon
          providerKind="agent"
          provider={provider}
          fallback="Bot"
          className="size-3.5 shrink-0"
          aria-hidden={true}
        />
        <span className="text-sidebar-foreground">{providerName}</span>
        <span
          className={`ml-auto inline-flex h-4 items-center rounded-full px-1.5 text-2xs font-medium tabular-nums ${
            !group.routingEnabled
              ? "bg-state-hover text-muted-foreground"
              : group.readyCount === 0
                ? "bg-destructive/10 text-destructive-text"
                : "bg-state-hover text-muted-foreground"
          }`}
          title={
            group.routingEnabled
              ? `${group.readyCount} of ${group.totalCount} accounts can take new requests`
              : "Account Pooler is not routing requests for this provider"
          }
        >
          {summary}
        </span>
      </h3>
      <ul className="m-0 flex list-none flex-col p-0">
        {readGroup(group, providerName, now).map((entry) => (
          <DetailAccount
            key={entry.bar.accountId}
            entry={entry}
            group={group}
            displayName={
              domain !== null && entry.bar.name.endsWith(domain)
                ? entry.bar.name.slice(0, -domain.length)
                : entry.bar.name
            }
            now={now}
            onUsageChanged={onUsageChanged}
            resetCreditsRevision={resetCreditsRevision}
            signIn={signIn}
          />
        ))}
      </ul>
    </section>
  );
}

export function FooterUsage({
  snapshot,
  status,
  failure,
  now,
  providerFor,
  refreshing,
  onRefresh,
  onUsageChanged,
  resetCreditsRevision,
  signIn,
}: {
  snapshot: Snapshot | null;
  status: string | null;
  failure: string | null;
  now: number;
  providerFor: (providerId: string) => ProviderRecord;
  refreshing: boolean;
  onRefresh: () => void;
  onUsageChanged: () => Promise<void>;
  resetCreditsRevision: number;
  signIn: AccountSignIn;
}): React.ReactElement {
  const details = useHoverDetails();
  const groups = snapshot?.groups ?? [];
  const shown = groups.filter((group) => group.weeklyBars.length > 0);
  const domain = sharedDomain(shown);

  const readings = shown
    .map((group) => {
      const provider = providerFor(group.providerId);
      const name = providerDisplayName(provider);

      return `${name}: ${readGroup(group, name, now)
        .map((entry) => accountPhrase(entry, now))
        .join("; ")}`;
    })
    .join(". ");

  const summary = [
    status === "Unavailable" ? "Usage unavailable" : status,
    readings,
  ]
    .filter(Boolean)
    .join(". ");

  const lastReading =
    status === "Offline" || failure !== null || snapshot?.error != null;

  const message =
    failure ??
    (snapshot === null
      ? null
      : snapshot.error !== null
        ? `Could not read the account pool: ${snapshot.error}`
        : status === "Disabled"
          ? "Every pooled account is disabled."
          : null);

  return (
    <Popover open={details.open} onOpenChange={details.onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${summary}. Show usage details`}
          onClick={details.onTriggerClick}
          onPointerEnter={details.enter}
          onPointerLeave={details.leave}
          className={`flex h-6 min-w-0 cursor-pointer items-center gap-3 overflow-hidden rounded-md border-0 bg-transparent px-2 text-left text-xs leading-none font-medium tabular-nums hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring data-[state=open]:bg-state-active ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK}`}
        >
          {status === "Loading" ? (
            <span role="status" className="sr-only">
              {status}
            </span>
          ) : status !== null ? (
            <span
              role="status"
              aria-label={status}
              className="text-xs leading-none whitespace-nowrap text-subtle-foreground"
            >
              {status === "Unavailable" ? "Usage unavailable" : status}
            </span>
          ) : null}
          {shown.length > 0 ? (
            <span data-usage-layout="rings" className="flex items-center gap-3">
              {shown.map((group) => (
                <ProviderRing
                  key={group.providerId}
                  group={group}
                  provider={providerFor(group.providerId)}
                  now={now}
                />
              ))}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        aria-label="Account usage details"
        mobileTitle="Account usage"
        className="flex max-h-(--radix-popover-content-available-height) w-88 max-w-[calc(100vw_-_2rem)] flex-col bg-sidebar p-0 text-sidebar-foreground"
        onPointerEnter={details.enter}
        onPointerLeave={details.leave}
        onPointerDown={details.pin}
        onFocus={details.pin}
        onOpenAutoFocus={(event) => {
          event.preventDefault();

          if (
            details.modeRef.current !== "hover" &&
            event.currentTarget instanceof HTMLElement
          )
            event.currentTarget.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <header className="flex items-center gap-2 border-b border-sidebar-border py-1.5 pr-1.5 pl-3">
          <span className="text-xs font-semibold">Account usage</span>
          <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
            {snapshot === null
              ? lastReading
                ? "No successful reading"
                : "Loading…"
              : `${lastReading ? "Last reading" : "Updated"} ${formatAgo(snapshot.fetchedAt, now) ?? "just now"}`}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh account usage from the providers"
            title="Refresh from Anthropic and OpenAI (one request per account)"
            className={`flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50 ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK}`}
          >
            <RefreshGlyph
              className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
              strokeWidth="1.5"
            />
          </button>
        </header>
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain p-1 pb-1.5">
          {message !== null ? (
            <p
              className={`m-1 mb-0 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-2xs leading-4 ${
                failure !== null || snapshot?.error != null
                  ? "border border-surface-destructive-border bg-surface-destructive text-destructive-text"
                  : "bg-state-hover text-muted-foreground"
              }`}
            >
              <Icon
                name={
                  failure !== null || snapshot?.error != null
                    ? "AlertCircle"
                    : "Info"
                }
                aria-hidden="true"
                className="mt-px size-3 shrink-0"
              />
              <span className="min-w-0 break-words">{message}</span>
            </p>
          ) : null}
          {shown.length > 0 ? <DetailColumns /> : null}
          {groups.map((group) => (
            <DetailGroup
              key={group.providerId}
              group={group}
              provider={providerFor(group.providerId)}
              domain={domain}
              now={now}
              onUsageChanged={onUsageChanged}
              resetCreditsRevision={resetCreditsRevision}
              signIn={signIn}
            />
          ))}
          {shown.length > 0 ? <UsageLegend /> : null}
          {details.open &&
          groups.some((group) => group.poolProvider === "codex") ? (
            <SpeedAllowance
              accounts={groups
                .filter((group) => group.poolProvider === "codex")
                .flatMap((group) => group.accounts)}
              fetchedAt={snapshot?.fetchedAt ?? 0}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
