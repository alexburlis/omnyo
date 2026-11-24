import { durationUnitMs, matchDuration } from "../../duration.js";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

export const FUTURE_TIME_FORMS =
  "an ISO 8601 timestamp (2026-08-25T09:00) or a duration from now (30s, 10m, 2h, 7d)";

export const SEND_AT_HELP = `Dispatch at ${FUTURE_TIME_FORMS}`;

function formatInvalid(flag: string, value: string, detail: string): Error {
  return new Error(
    `Invalid ${flag} value '${value}'. ${detail} Expected an ISO 8601 timestamp such as 2026-08-25T09:00 or a duration such as 30s, 10m, 2h, or 7d.`,
  );
}

export function parseSendAt(value: string, now = Date.now()): number {
  return parseFutureTime(value, "--send-at", now);
}

export function parseFutureTime(
  value: string,
  flag: string,
  now = Date.now(),
): number {
  const trimmed = value.trim();

  if (trimmed === "") {
    throw formatInvalid(flag, value, "It is empty.");
  }

  const duration = matchDuration(trimmed);

  if (duration !== null && duration.unit !== null) {
    const resolved = Math.round(
      now + duration.amount * durationUnitMs(duration.unit),
    );

    if (resolved <= now) {
      throw new Error(
        `${flag} must be in the future; '${value}' is zero time from now.`,
      );
    }

    return resolved;
  }

  if (DATE_ONLY_PATTERN.test(trimmed)) {
    throw formatInvalid(
      flag,
      value,
      "A date alone has no time of day, and the time zone it means is ambiguous.",
    );
  }

  if (!ISO_PATTERN.test(trimmed)) {
    throw formatInvalid(
      flag,
      value,
      "It is neither a timestamp nor a duration.",
    );
  }

  const resolved = Date.parse(trimmed.replace(" ", "T"));

  if (!Number.isFinite(resolved)) {
    throw formatInvalid(flag, value, "It is not a real date.");
  }

  if (resolved <= now) {
    throw new Error(
      `${flag} must be in the future; '${value}' resolves to ${new Date(resolved).toLocaleString()}, which has already passed.`,
    );
  }

  return resolved;
}

export function formatQueueSendCountdown(
  sendAt: number | null,
  now = Date.now(),
): string {
  if (sendAt === null) return "-";
  const remainingMs = sendAt - now;

  if (remainingMs <= 0) return "due";

  return `in ${formatApproximateDuration(remainingMs)}`;
}

function formatApproximateDuration(ms: number): string {
  if (ms < durationUnitMs("m"))
    return `${Math.max(1, Math.round(ms / durationUnitMs("s")))}s`;

  if (ms < durationUnitMs("h"))
    return `${Math.floor(ms / durationUnitMs("m"))}m`;

  if (ms < durationUnitMs("d"))
    return `${Math.floor(ms / durationUnitMs("h"))}h`;

  return `${Math.floor(ms / durationUnitMs("d"))}d`;
}

export function formatLocalTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
