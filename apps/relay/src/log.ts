import type { LogFieldValue, RelayLogger } from "./contracts.js";

type LogLevel = "info" | "warn" | "error";

export function createJsonLogger(
  write: (line: string) => void,
  now: () => number = Date.now,
): RelayLogger {
  const emit =
    (level: LogLevel) =>
    (event: string, fields?: Readonly<Record<string, LogFieldValue>>) => {
      write(
        `${JSON.stringify({
          ...fields,
          at: new Date(now()).toISOString(),
          level,
          event,
        })}\n`,
      );
    };

  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}
