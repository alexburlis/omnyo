import type { Event, ErrorEvent } from "@sentry/core";

export type { Event as BrowserErrorEvent } from "@sentry/core";

import {
  scrubDiagnosticErrorEvent,
  type ErrorReportIdentity,
} from "./error-reporting-privacy.js";

export const SLOW_SHELF_MOVE_MESSAGE = "Slow Shelf move";

export const SHELF_TIMING_DEADLINE_MS = 10_000;

export function scrubBrowserErrorEvent(
  event: Event,
  identity: ErrorReportIdentity,
): ErrorEvent {
  const scrubbed = scrubDiagnosticErrorEvent(event, identity);
  const timing = event.contexts?.shelfMove;

  if (event.message !== SLOW_SHELF_MOVE_MESSAGE || timing === undefined)
    return scrubbed;
  const outcome = timing.outcome;

  if (outcome !== "saved" && outcome !== "failed" && outcome !== "pending")
    return scrubbed;
  const shelfMove: Record<string, string | number> = { outcome };

  for (const field of [
    "beforeOptimisticMs",
    "optimisticCommitMs",
    "foregroundFrameMs",
    "requestMs",
    "coordinatorMs",
    "responseStartMs",
    "responseEndMs",
    "totalMs",
  ]) {
    const value: unknown = timing[field];

    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      shelfMove[field] = Math.round(Math.min(value, SHELF_TIMING_DEADLINE_MS));
  }

  return {
    ...scrubbed,
    message: SLOW_SHELF_MOVE_MESSAGE,
    level: "warning",
    fingerprint: ["slow-shelf-move"],
    contexts: { ...scrubbed.contexts, shelfMove },
  };
}
