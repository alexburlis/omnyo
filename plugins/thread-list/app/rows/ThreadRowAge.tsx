import { useMinuteNow } from "@/components/ui/hooks/use-minute-now";

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

const DAY_MS = 24 * HOUR_MS;

const WEEK_MS = 7 * DAY_MS;

const MONTH_MS = 30 * DAY_MS;

const YEAR_MS = 365 * DAY_MS;

const STARTED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

export function formatThreadAge(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);

  if (elapsed < MINUTE_MS) return "now";

  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;

  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;

  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d`;

  if (elapsed < MONTH_MS) return `${Math.floor(elapsed / WEEK_MS)}w`;

  if (elapsed < YEAR_MS) return `${Math.floor(elapsed / MONTH_MS)}mo`;

  return `${Math.floor(elapsed / YEAR_MS)}y`;
}

export function ThreadRowAge({ createdAt }: { createdAt: number }) {
  const now = useMinuteNow();
  const started = new Date(createdAt);

  return (
    <time
      data-sidebar-thread-age=""
      dateTime={started.toISOString()}
      title={`Started ${STARTED_AT_FORMAT.format(started)}`}
      className="pointer-events-none shrink-0 select-none whitespace-nowrap pr-2 text-2xs tabular-nums text-subtle-foreground"
    >
      {formatThreadAge(createdAt, now)}
    </time>
  );
}
