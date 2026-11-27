import { memoryLabel } from "../lib/task-usage.ts";
import type { TaskUsage } from "../lib/use-task-usage.ts";

export function ThreadUsage({
  usage,
  threadId,
  status,
}: {
  usage: TaskUsage;
  threadId: string;
  status: string | undefined;
}) {
  if (usage.kind === "off") return null;
  const reading = usage.kind === "ready" ? usage.readings.get(threadId) : undefined;

  if (reading?.kind !== "measured") {
    if (status !== "active" && status !== "starting" && status !== "stopping") return null;
    const loading = usage.kind === "loading";

    return (
      <span
        className="ct-thread-usage text-2xs"
        data-thread-usage={threadId}
        data-coverage="unknown"
        aria-label={loading ? "Measuring usage" : "Usage unavailable"}
      >
        {loading ? "Measuring…" : "Unavailable"}
      </span>
    );
  }

  const cpu = reading.value.cpuPercent;
  const cpuText = cpu === null ? null : `${Number(cpu.toFixed(1))}%`;
  const ramText = memoryLabel(reading.value.memoryBytes);
  const coverage = reading.coverage === "partial" ? "Partial host measurement" : "Measured usage";
  const label = `${coverage}. CPU ${cpuText ?? "unavailable"}. RAM ${ramText}.`;

  return (
    <span
      className="ct-thread-usage text-2xs"
      data-thread-usage={threadId}
      data-coverage={reading.coverage}
      title={label}
      aria-label={label}
    >
      <span>
        <small>CPU</small> {cpuText ?? "—"}
      </span>
      <span>
        <small>RAM</small> {ramText}
      </span>
    </span>
  );
}
