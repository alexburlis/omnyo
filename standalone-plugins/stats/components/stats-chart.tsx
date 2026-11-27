import { useId, useMemo, useState } from "react";
import type { Point } from "../contract";
import { compact, number, rate, timestamp } from "./stats-format";

interface StatsChartProps {
  points: Point[];
  metric: "tps" | "agents";
  resolutionSeconds: number;
  skeleton?: boolean;
}

interface ChartPoint {
  source: Point;
  value: number;
  x: number;
  y: number;
}

function valueFor(point: Point, metric: "tps" | "agents" | "model"): number | null {
  if (metric === "tps") return point.output > 0 || point.observedMs > 0 ? point.tps : null;

  if (metric === "model") return point.modelTps;

  return point.observedMs > 0 ? point.agents : null;
}

function linePath(segment: ChartPoint[], stepped: boolean): string {
  return segment
    .map((point, index) =>
      index === 0
        ? `M${point.x},${point.y}`
        : stepped
          ? `H${point.x}V${point.y}`
          : `L${point.x},${point.y}`,
    )
    .join(" ");
}

export function StatsChart({
  points,
  metric,
  resolutionSeconds,
  skeleton = false,
}: StatsChartProps) {
  const gradientId = `stats-chart-${useId().replaceAll(":", "")}`;
  const [selectedAt, setSelectedAt] = useState<number | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [throughputMetric, setThroughputMetric] = useState<"output" | "model">("output");
  const selectedMetric = metric === "tps" && throughputMetric === "model" ? "model" : metric;

  const title =
    selectedMetric === "model"
      ? "Estimated model speed"
      : metric === "tps"
        ? "Total output throughput"
        : "Agents working in parallel";

  const unit = metric === "tps" ? "tok/s" : "agents";

  const chart = useMemo(() => {
    let maximum = 1;
    let measuredMaximum: number | null = null;

    for (const point of points) {
      const value = valueFor(point, selectedMetric);

      if (value !== null) {
        const upperValue = metric === "agents" ? (point.peak ?? value) : value;
        maximum = Math.max(maximum, upperValue);
        measuredMaximum = Math.max(measuredMaximum ?? 0, upperValue);
      }
    }

    const upper = maximum > 10 ? Math.ceil(maximum / 10) * 10 : Math.ceil(maximum);
    const segments: ChartPoint[][] = [];
    let segment: ChartPoint[] = [];
    const visible: ChartPoint[] = [];

    for (const [index, point] of points.entries()) {
      const value = valueFor(point, selectedMetric);

      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
        continue;
      }

      const plotted = {
        source: point,
        value,
        x: 48 + (index / Math.max(1, points.length - 1)) * 624,
        y: 176 - (value / upper) * 140,
      };

      segment.push(plotted);
      visible.push(plotted);
    }

    if (segment.length) segments.push(segment);

    return { maximum: upper, measuredMaximum, segments, visible };
  }, [points, metric, selectedMetric]);

  const selected = chart.visible.find((point) => point.source.at === selectedAt);

  return (
    <section className="stats-chart stats-surface" data-metric={metric}>
      <div className="stats-chart-heading">
        <div>
          <p className="stats-eyebrow">
            {metric === "agents" ? "Execution density" : "Token velocity"}
          </p>
          <h2>{title}</h2>
          <p className="stats-chart-stat">
            <span title={chart.measuredMaximum === null ? undefined : rate(chart.measuredMaximum)}>
              {rate(chart.measuredMaximum)}
            </span>
            <small>{unit} · peak</small>
          </p>
        </div>
        <div className="stats-chart-meta">
          <span>
            {resolutionSeconds < 3600
              ? `${rate(resolutionSeconds / 60)} min`
              : `${rate(resolutionSeconds / 3600)} h`}{" "}
            buckets
          </span>
          {metric === "tps" && (
            <select
              aria-label="Throughput metric"
              value={throughputMetric}
              disabled={skeleton}
              onChange={(event) => {
                setThroughputMetric(event.target.value === "model" ? "model" : "output");
                setSelectedAt(null);
              }}
            >
              <option value="output">Output throughput</option>
              <option value="model">Model speed</option>
            </select>
          )}
        </div>
      </div>
      <div className="stats-chart-canvas">
        <svg
          role="group"
          aria-label={title}
          viewBox="0 0 704 218"
          preserveAspectRatio="none"
          className="stats-chart-plot"
          tabIndex={skeleton ? undefined : 0}
          onPointerMove={(event) => {
            if (!points.length || skeleton) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - bounds.left) / bounds.width) * 704;

            const point =
              points[
                Math.max(
                  0,
                  Math.min(points.length - 1, Math.round(((x - 48) / 624) * (points.length - 1))),
                )
              ];

            if (point && valueFor(point, selectedMetric) !== null) setSelectedAt(point.at);
          }}
          onPointerLeave={() => setSelectedAt(null)}
          onKeyDown={(event) => {
            if (
              !chart.visible.length ||
              !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
            )
              return;
            event.preventDefault();
            const current = chart.visible.findIndex((point) => point.source.at === selectedAt);

            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? chart.visible.length - 1
                  : event.key === "ArrowRight"
                    ? Math.min(chart.visible.length - 1, current + 1)
                    : Math.max(0, current < 0 ? chart.visible.length - 1 : current - 1);

            setSelectedAt(chart.visible[index]!.source.at);
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--stats-chart-color)" stopOpacity=".22" />
              <stop offset="100%" stopColor="var(--stats-chart-color)" stopOpacity=".015" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
            <g key={fraction}>
              <line
                x1="48"
                x2="672"
                y1={176 - fraction * 140}
                y2={176 - fraction * 140}
                className="stats-chart-rule"
              />
            </g>
          ))}
          {chart.segments.map((segment) => (
            <g key={segment[0]!.source.at}>
              <path
                d={`${linePath(segment, metric === "agents")} L${segment.at(-1)!.x},176 L${segment[0]!.x},176 Z`}
                fill={`url(#${gradientId})`}
              />
              {metric === "agents" && (
                <path
                  className="stats-chart-peak"
                  d={segment
                    .map(
                      (point, index) =>
                        `${index === 0 ? "M" : "L"}${point.x},${176 - ((point.source.peak ?? point.value) / chart.maximum) * 140}`,
                    )
                    .join(" ")}
                />
              )}
              <path d={linePath(segment, metric === "agents")} className="stats-chart-line" />
              {segment.length === 1 && (
                <circle
                  cx={segment[0]!.x}
                  cy={segment[0]!.y}
                  r="2.5"
                  className="stats-chart-selected-dot"
                />
              )}
            </g>
          ))}
          {selected && (
            <g>
              <line
                x1={selected.x}
                x2={selected.x}
                y1="31"
                y2="176"
                className="stats-chart-selection"
              />
              <circle cx={selected.x} cy={selected.y} r="4" className="stats-chart-selected-dot" />
            </g>
          )}
        </svg>
        <div className="stats-chart-axes" aria-hidden="true">
          {[0, 0.5, 1].map((fraction) => (
            <span
              key={fraction}
              className="stats-chart-axis stats-chart-axis-y"
              style={{ top: `${((176 - fraction * 140) / 218) * 100}%` }}
            >
              {chart.maximum * fraction >= 1000
                ? compact(chart.maximum * fraction)
                : rate(chart.maximum * fraction)}
            </span>
          ))}
          {points[0] && (
            <span className="stats-chart-axis stats-chart-axis-start">
              {new Date(points[0].at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          {points.at(-1) && (
            <span className="stats-chart-axis stats-chart-axis-end">
              {new Date(points.at(-1)!.at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>
        {!chart.visible.length && !skeleton && (
          <p className="stats-chart-empty">
            {selectedMetric === "model"
              ? "No measured model speed samples in this range"
              : metric === "tps"
                ? "No recorded output or execution coverage in this range"
                : "No recorded execution coverage in this range"}
          </p>
        )}
      </div>
      <p className="stats-chart-description" aria-live="polite">
        {selected
          ? `${timestamp(selected.source.at)} · ${rate(selected.value)} ${unit}${selectedMetric === "model" ? " estimated model speed" : ""} · ${number(selected.source.output)} recorded output${metric === "agents" && selected.source.peak !== null ? ` · peak ${number(selected.source.peak)}` : ""}${selected.source.observedMs === 0 ? " · execution coverage unavailable" : ""}`
          : selectedMetric === "model"
            ? "Measured output divided by estimated model time. Tool and interaction waits are excluded; missing samples stay gaps."
            : metric === "tps"
              ? "Recorded output divided by bucket seconds. Hover or use arrow keys to inspect; missing coverage stays a gap."
              : "Average agents during observed execution. Dotted line shows known peak; gaps show unavailable coverage."}
      </p>
      <details onToggle={(event) => setDataOpen(event.currentTarget.open)}>
        <summary>Chart data</summary>
        {dataOpen && (
          <div className="stats-chart-data" style={{ scrollbarGutter: "stable" }}>
            <table>
              <thead>
                <tr>
                  <th scope="col" className="py-2 text-left font-medium">
                    Time
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {unit}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Execution coverage (s)
                  </th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.at} className="border-t border-border">
                    <th scope="row" className="py-1.5 text-left font-normal">
                      {timestamp(point.at)}
                    </th>
                    <td className="text-right">{rate(valueFor(point, selectedMetric))}</td>
                    <td className="text-right">{rate(point.observedMs / 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}
