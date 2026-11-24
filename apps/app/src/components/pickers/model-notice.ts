import type { SystemExecutionOptionsModelNotice } from "@omnyo/server-contract";

export interface ModelPickerNotice {
  providerId: string;
  summary: string;
  detail: string | null;
}

const SOON_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const LATER_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

export function resolveModelPickerNotice(
  notice: SystemExecutionOptionsModelNotice | null,
  now: number,
): ModelPickerNotice | null {
  if (notice === null) return null;

  if (notice.until === null) {
    return {
      providerId: notice.providerId,
      summary: notice.message,
      detail: notice.detail,
    };
  }

  if (notice.until <= now) return null;

  const format = notice.until - now < SIX_DAYS_MS ? SOON_FORMAT : LATER_FORMAT;

  return {
    providerId: notice.providerId,
    summary: `${notice.message} until ${format.format(notice.until)}`,
    detail: notice.detail,
  };
}

export function modelPickerNoticeLine(notice: ModelPickerNotice): string {
  return notice.detail === null
    ? notice.summary
    : `${notice.summary} · ${notice.detail}`;
}
