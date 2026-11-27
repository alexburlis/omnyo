import { useMemo, useState } from "react";
import type { Report, SpeedGroup } from "../contract";
import { Button } from "./ui/button";
import { compact, label, number, rate } from "./stats-format";

interface StatsSpeedProps {
  report: Report;
  onInspect: (group: SpeedGroup) => void;
}

interface SpeedFilters {
  provider: string;
  model: string;
  effort: string;
  mode: string;
}

const filterKeys: (keyof SpeedFilters)[] = ["provider", "model", "effort", "mode"];

const filterLabels: Record<keyof SpeedFilters, string> = {
  provider: "Speed provider",
  model: "Speed model",
  effort: "Speed thinking effort",
  mode: "Speed mode",
};

export function StatsSpeed({ report, onInspect }: StatsSpeedProps) {
  const [filters, setFilters] = useState<SpeedFilters>({
    provider: "",
    model: "",
    effort: "",
    mode: "",
  });

  const groups = useMemo(
    () =>
      report.speeds.filter((group) =>
        filterKeys.every((key) => !filters[key] || group[key] === filters[key]),
      ),
    [report.speeds, filters],
  );

  let measured = 0;
  let output = 0;
  let modelMs = 0;

  for (const group of groups) {
    measured += group.counters.measuredTurns;
    output += group.counters.speedOutput;
    modelMs += group.counters.modelMs;
  }

  return (
    <section data-testid="stats-speed" className="stats-speed">
      <div className="flex h-10 flex-wrap content-start items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Model speed</h2>
        <p className="text-xs text-muted-foreground">
          Same model and thinking effort for mode comparisons
        </p>
      </div>
      <div data-testid="stats-speed-controls" className="stats-speed-controls">
        {filterKeys.map((key) => {
          const options = [...new Set(report.speeds.map((group) => group[key]))].sort();

          return (
            <label
              key={key}
              className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground"
            >
              {filterLabels[key]}
              <select
                aria-label={filterLabels[key]}
                className="h-[38px] w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                value={filters[key]}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, [key]: event.target.value }))
                }
              >
                <option value="">All</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {label(option)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <div
        data-testid="stats-speed-totals"
        className="stats-range-totals stats-speed-totals stats-surface"
      >
        <span>
          <span className="text-muted-foreground">Measured turns </span>
          <strong>{number(measured)}</strong>
        </span>
        <span>
          <span className="text-muted-foreground">Measured output </span>
          <strong>{compact(output)}</strong>
        </span>
        <span>
          <span className="text-muted-foreground">Pooled model speed </span>
          <strong>{rate(modelMs > 0 ? (output / modelMs) * 1000 : null)} tok/s</strong>
        </span>
      </div>
      <div data-testid="stats-speed-frame" className="stats-speed-frame stats-surface">
        <div className="h-80 overflow-auto" style={{ scrollbarGutter: "stable" }}>
          <table data-testid="model-speed" className="stats-data-table">
            <colgroup>
              <col style={{ width: "24%" }} />
              {[12, 10, 10, 10, 13, 9, 12].map((width, column) => (
                <col key={column} style={{ width: `${width}%` }} />
              ))}
            </colgroup>
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                {[
                  "Model / provider",
                  "Thinking effort",
                  "Mode",
                  "Median tok/s",
                  "Pooled tok/s",
                  "Measured turns",
                  "Output",
                  "Trend",
                ].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className={`py-2 pr-4 font-medium ${heading.includes("tok/s") || heading === "Output" || heading === "Measured turns" ? "text-right" : "text-left"}`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr
                  key={`${group.provider}:${group.model}:${group.effort}:${group.mode}`}
                  className="border-b border-border last:border-0"
                >
                  <th scope="row" className="truncate py-3 pr-4 text-left font-medium">
                    {label(group.model)}
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {label(group.provider)}
                    </span>
                  </th>
                  <td className="py-3 pr-4">
                    <span className="stats-speed-pill">{label(group.effort)}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="stats-speed-pill" data-mode={group.mode}>
                      {label(group.mode)}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right">{rate(group.medianTps)}</td>
                  <td className="py-3 pr-4 text-right">{rate(group.modelTps)}</td>
                  <td className="truncate py-3 pr-4 text-right">
                    {number(group.counters.measuredTurns)} / {number(group.counters.turns)}
                  </td>
                  <td className="py-3 pr-4 text-right">{compact(group.counters.output)}</td>
                  <td className="py-3 pr-4">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Show trend for ${label(group.model)}, ${label(group.effort)}, ${label(group.mode)}`}
                      onClick={() => onInspect(group)}
                    >
                      View trend
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {groups.length === 0 && (
            <p className="py-5 text-sm text-muted-foreground">
              No model speed cohorts match these filters.
            </p>
          )}
        </div>
      </div>
      <p className="h-36 line-clamp-9 text-xs leading-relaxed text-muted-foreground sm:h-20">
        Pooled speed divides measured output by estimated model time, excluding recorded tool and
        interaction waits. Thinking and request latency remain included. Median uses retained
        samples from the last {report.medianWindowDays} days; — means unavailable. Modes record
        Omnyo’s requested tier, and do not confirm the provider’s delivered tier.
      </p>
    </section>
  );
}
