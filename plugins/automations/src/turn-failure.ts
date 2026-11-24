import type { PluginTurnFailedEvent } from "@omnyo/plugin-sdk";

export function isTransientTurnFailure(
  failure: PluginTurnFailedEvent,
): boolean {
  const info = failure.errorInfo;

  if (info === null) return false;

  if (info.category === "overloaded" || info.category === "rate-limit") {
    return true;
  }

  const status = info.httpStatusCode;

  if (
    info.category === "stream-disconnected" ||
    info.category === "connection-failed"
  ) {
    return status === null || status === 408 || status === 499 || status >= 500;
  }

  return info.category === "internal" && status !== null && status >= 500;
}
