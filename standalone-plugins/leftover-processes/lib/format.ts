const KIB = 1024;

const MIB = KIB * 1024;

const GIB = MIB * 1024;

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

const DAY_MS = 24 * HOUR_MS;

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;

  const megabytes = bytes / MIB;

  return megabytes >= 10 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < MINUTE_MS) return "under a minute";

  if (milliseconds < HOUR_MS) return `${Math.round(milliseconds / MINUTE_MS)} min`;

  if (milliseconds < DAY_MS) return `${Math.round(milliseconds / HOUR_MS)} h`;

  return `${Math.round(milliseconds / DAY_MS)} d`;
}

export function formatProcessCount(count: number): string {
  return `${count} ${count === 1 ? "process" : "processes"}`;
}
