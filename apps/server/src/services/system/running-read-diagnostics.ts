import { randomUUID } from "node:crypto";
import type { FetchImplementation } from "@omnyo/sdk";
import type { ServerLogger } from "../../types.js";

const HEADER = "x-omnyo-local-read-diagnostic";

interface ReadTiming {
  startedAt: number;
  handlerStartedAt: number | null;
  readElapsedMs: number | null;
  readCpuMs: number | null;
  responseCreatedAt: number | null;
}

const pending = new Map<string, ReadTiming>();

export function diagnosticRunningReadFetch(
  fetchImpl: FetchImplementation,
  enabled: () => boolean,
  logger: Pick<ServerLogger, "info">,
): FetchImplementation {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    if (
      !enabled() ||
      new URL(url).pathname !== "/api/v1/threads/running" ||
      pending.size >= 64
    )
      return fetchImpl(input, init);
    const operationId = randomUUID();

    const timing: ReadTiming = {
      startedAt: performance.now(),
      handlerStartedAt: null,
      readElapsedMs: null,
      readCpuMs: null,
      responseCreatedAt: null,
    };

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    headers.set(HEADER, operationId);
    pending.set(operationId, timing);
    let outcome: "received" | "failed" = "failed";

    try {
      const result = await fetchImpl(input, { ...init, headers });
      outcome = "received";

      return result;
    } finally {
      pending.delete(operationId);

      if (enabled())
        logger.info(
          {
            operationId,
            outcome,
            enqueueToHandlerMs:
              timing.handlerStartedAt === null
                ? null
                : Math.round(timing.handlerStartedAt - timing.startedAt),
            readElapsedMs: timing.readElapsedMs,
            readCpuMs: timing.readCpuMs,
            handlerToResponseMs:
              timing.handlerStartedAt === null ||
              timing.responseCreatedAt === null
                ? null
                : Math.round(
                    timing.responseCreatedAt - timing.handlerStartedAt,
                  ),
            responseHeadersMs: Math.round(performance.now() - timing.startedAt),
          },
          "Local running-thread read timing",
        );
    }
  };
}

export function observeRunningRead<T>(
  headers: { header(name: string): string | undefined },
  read: () => T,
  respond: (value: T) => Response,
): Response {
  const timing = pending.get(headers.header(HEADER) ?? "");

  if (timing === undefined) return respond(read());
  timing.handlerStartedAt = performance.now();
  const cpuStart = process.threadCpuUsage();
  const value = read();
  const cpu = process.threadCpuUsage(cpuStart);
  timing.readElapsedMs = Math.round(
    performance.now() - timing.handlerStartedAt,
  );
  timing.readCpuMs = (cpu.user + cpu.system) / 1_000;
  const response = respond(value);
  timing.responseCreatedAt = performance.now();

  return response;
}
