import { startEventLoopDelaySampler } from "@omnyo/process-utils";
import type { ServerLogger } from "../../types.js";
import { takeEventLoopWorkWindowSnapshot } from "./event-loop-work.js";
import { startStallResourceTrace } from "./stall-resource-trace.js";

export interface EventLoopStallMonitorOptions {
  logger: Pick<ServerLogger, "info">;
  now?: () => number;
  thresholdMs?: number | (() => number);
  resourceSamplerPath?: string;
}

export interface EventLoopStallMonitor {
  stop: () => void;
}

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions,
): EventLoopStallMonitor {
  const resourceTrace =
    options.resourceSamplerPath === undefined
      ? undefined
      : startStallResourceTrace(options.resourceSamplerPath);

  const now = options.now ?? Date.now;

  const monitor = startEventLoopDelaySampler({
    now,
    thresholdMs: options.thresholdMs,
    onSample: ({ stall }) => {
      const work = takeEventLoopWorkWindowSnapshot();

      const resources = resourceTrace?.sample(
        now(),
        stall?.sampleGapMs ?? 0,
        stall !== null,
      );

      if (stall !== null) {
        const hasCandidate =
          work.longestSynchronousWorkWallMs !== null &&
          work.longestSynchronousWorkWallMs + stall.resolutionMs >=
            stall.maxDelayMs;

        options.logger.info(
          {
            ...stall,
            ...work,
            ...(resources === undefined ? {} : { resources }),
            stallAttribution: hasCandidate ? "candidate" : "unattributed",
            stallCauseCandidate: hasCandidate
              ? work.longestSynchronousWork
              : null,
          },
          "Event loop stalled",
        );
      }
    },
  });

  return {
    stop() {
      monitor.stop();
      resourceTrace?.stop();
    },
  };
}
