import type { Counters, Dimension, Group, Health, Report } from "../contract";

export const dimensionLabels: Record<Dimension, string> = {
  machine: "Machine",
  project: "Project",
  chat: "Chat",
  provider: "Provider",
  model: "Model",
  effort: "Thinking effort",
  mode: "Mode",
  account: "Account",
  chatRole: "Chat role",
  agentRole: "Execution role",
};

export function number(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function compact(value: number): string {
  return value.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
}

export function rate(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function timestamp(value: number | null): string {
  return value === null ? "Not yet" : new Date(value).toLocaleString();
}

export function bytes(value: number): string {
  if (value < 1024) return `${number(value)} B`;

  if (value < 1024 * 1024) return `${rate(value / 1024)} KiB`;

  return `${rate(value / (1024 * 1024))} MiB`;
}

export function hours(value: number): string {
  return `${rate(value / 3_600_000)} h`;
}

export function label(value: string): string {
  if (!value || value === "unknown") return "Unknown";

  if (value === "default" || value === "normal") return "Normal";

  if (value === "fast") return "Fast";

  if (value === "ultrafast") return "Ultrafast";

  return value;
}

export function groupLabel(group: Group, dimension: Dimension, health: Health): string {
  if (dimension === "account")
    return health.accounts.find((account) => account.id === group.key)?.label ?? label(group.label);

  return dimension === "mode" ? label(group.label) : group.label || "Unknown";
}

function csvCell(value: string): string {
  const safe = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;

  return `"${safe.replaceAll('"', '""')}"`;
}

function counterValues(counters: Counters): string[] {
  return [
    counters.input,
    counters.output,
    counters.total,
    counters.cached,
    counters.cacheRead,
    counters.cacheWrite,
    counters.reasoning,
    counters.usageEvents,
    counters.turns,
    counters.failedTurns,
    counters.measuredTurns,
    counters.modelMs,
    counters.speedOutput,
    counters.agentMs,
  ].map(String);
}

export function downloadReport(report: Report, dimension: Dimension, format: "csv" | "json"): void {
  let content: string;

  if (format === "json") {
    content = JSON.stringify(
      { schemaVersion: 1, exportScope: "current page", groupBy: dimension, ...report },
      null,
      2,
    );
  } else {
    const rows = [
      [
        "dimension",
        "key",
        "label",
        "deleted",
        "input",
        "output",
        "provider_total",
        "cached",
        "cache_read",
        "cache_write",
        "reasoning",
        "usage_events",
        "turns",
        "failed_turns",
        "measured_turns",
        "model_ms",
        "speed_output",
        "agent_ms",
        "wall_tps",
        "model_tps",
        "median_tps",
        "active",
      ],
    ];

    for (const group of report.groups)
      rows.push([
        dimension,
        group.key,
        groupLabel(group, dimension, report.health),
        String(group.deleted),
        ...counterValues(group.counters),
        String(group.tps),
        group.modelTps === null ? "" : String(group.modelTps),
        group.medianTps === null ? "" : String(group.medianTps),
        String(group.active),
      ]);
    content = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  }

  const url = URL.createObjectURL(
    new Blob([content], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json" }),
  );

  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = `stats-${dimension}-${new Date(report.asOf).toISOString().replaceAll(":", "-")}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
