import type { Dimension, Group, Report } from "../contract";
import { Button } from "./ui/button";
import { StatsChart } from "./stats-chart";
import { StatsFabric } from "./stats-fabric";
import {
  compact,
  dimensionLabels,
  groupLabel,
  hours,
  number,
  rate,
  timestamp,
} from "./stats-format";

interface StatsOverviewProps {
  report: Report;
  groupBy: Dimension;
  offset: number;
  loading: boolean;
  onFilter: (group: Group) => void;
  onPage: (offset: number) => void;
  onOpenChat: (id: string) => void;
  onFacet: (dimension: Dimension, key: string, label: string) => void;
}

export function StatsOverview({
  report,
  groupBy,
  offset,
  loading,
  onFilter,
  onPage,
  onOpenChat,
  onFacet,
}: StatsOverviewProps) {
  return (
    <div className="stats-overview">
      <div data-testid="stats-range-totals" className="stats-range-totals stats-surface">
        <span>
          <span className="text-muted-foreground">Selected range output </span>
          <strong>{number(report.counters.output)}</strong>
        </span>
        <span>
          <span className="text-muted-foreground">Input </span>
          <strong>{number(report.counters.input)}</strong>
        </span>
        <span>
          <span className="text-muted-foreground">Agent time </span>
          <strong>{hours(report.counters.agentMs)}</strong>
        </span>
        <span>
          <span className="text-muted-foreground">Completed turns </span>
          <strong>{number(report.counters.turns)}</strong>
        </span>
        <span>
          <span className="text-muted-foreground">Failed turns </span>
          <strong>{number(report.counters.failedTurns)}</strong>
        </span>
      </div>
      <div className="stats-chart-grid">
        <StatsChart
          points={report.series}
          metric="agents"
          resolutionSeconds={report.resolutionSeconds}
        />
        <StatsChart
          points={report.series}
          metric="tps"
          resolutionSeconds={report.resolutionSeconds}
        />
      </div>
      <StatsFabric report={report} disabled={loading} onSelect={onFacet} />
      <section data-testid="stats-breakdown-frame" className="stats-breakdown stats-surface">
        <div className="stats-section-heading stats-breakdown-heading">
          <div>
            <p className="stats-eyebrow">Explore the details</p>
            <h2>By {dimensionLabels[groupBy].toLowerCase()}</h2>
          </div>
          <p>{number(report.groupCount)} groups · Select a row to filter</p>
        </div>
        <div className="stats-breakdown-scroll">
          <table data-testid="stats-breakdown" className="stats-data-table">
            <colgroup>
              <col style={{ width: "24%" }} />
              {[8, 8, 13, 8, 6, 8, 9, 9, 7].map((width, column) => (
                <col key={column} style={{ width: `${width}%` }} />
              ))}
            </colgroup>
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 text-left font-medium">
                  {dimensionLabels[groupBy]}
                </th>
                {[
                  "Output",
                  "Input",
                  "Cache read / write",
                  "Reasoning",
                  "Turns",
                  "Agent time",
                  "Total tok/s",
                  "Model tok/s",
                  "Running",
                ].map((heading) => (
                  <th scope="col" key={heading} className="px-2 py-2 text-right font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.groups.map((group) => (
                <tr key={group.key} className="border-b border-border last:border-0">
                  <th scope="row" className="py-2 pr-4 text-left font-normal">
                    <div className="stats-group-cell">
                      <span className="stats-group-rail" aria-hidden="true" />
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => onFilter(group)}
                        className="min-w-0 truncate text-left font-medium text-primary underline-offset-4 hover:underline"
                        title={groupLabel(group, groupBy, report.health)}
                      >
                        {groupLabel(group, groupBy, report.health)}
                      </button>
                      {group.deleted && (
                        <span className="text-[10px] text-muted-foreground">Deleted</span>
                      )}
                      {groupBy === "chat" && !group.deleted && group.key !== "unknown" && (
                        <button
                          type="button"
                          disabled={loading}
                          aria-label={`Open chat ${group.label}`}
                          onClick={() => onOpenChat(group.key)}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          ↗
                        </button>
                      )}
                    </div>
                  </th>
                  <td className="px-2 py-2 text-right" title={number(group.counters.output)}>
                    {compact(group.counters.output)}
                    <span className="stats-group-share" aria-hidden="true">
                      <span
                        style={{
                          width: `${report.counters.output > 0 ? Math.min(100, (group.counters.output / report.counters.output) * 100) : 0}%`,
                        }}
                      />
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right" title={number(group.counters.input)}>
                    {compact(group.counters.input)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {compact(group.counters.cacheRead)} / {compact(group.counters.cacheWrite)}
                  </td>
                  <td className="px-2 py-2 text-right">{compact(group.counters.reasoning)}</td>
                  <td
                    className="truncate px-2 py-2 text-right"
                    title={number(group.counters.turns)}
                  >
                    {number(group.counters.turns)}
                  </td>
                  <td className="px-2 py-2 text-right">{hours(group.counters.agentMs)}</td>
                  <td className="px-2 py-2 text-right">{rate(group.tps)}</td>
                  <td className="px-2 py-2 text-right">{rate(group.modelTps)}</td>
                  <td className="px-2 py-2 text-right">
                    {group.active > 0 ? (
                      <span className="stats-active-count">{number(group.active)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.groups.length === 0 && (
            <p className="py-5 text-sm text-muted-foreground">
              No recorded usage matches these filters.
            </p>
          )}
        </div>
        <div className="stats-breakdown-pagination">
          <p className="text-xs text-muted-foreground">
            {report.groups.length
              ? `${number(offset + 1)}–${number(offset + report.groups.length)} of ${number(report.groupCount)}`
              : "0 groups"}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || offset === 0}
              onClick={() => onPage(Math.max(0, offset - 50))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || report.nextOffset === null}
              onClick={() => {
                if (report.nextOffset !== null) onPage(report.nextOffset);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      </section>
      <p className="stats-range-caption">
        {timestamp(report.from)} – {timestamp(report.to)} · Total tok/s divides recorded output by
        elapsed wall time. Model tok/s estimates effective model time from measured turns. Output
        includes reported reasoning; cache fields follow provider semantics.
      </p>
    </div>
  );
}
