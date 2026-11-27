import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { PluginMessageDirectiveProps } from "@omnyo/plugin-sdk/app";
import type { Tone } from "./block-fields";
import { parseMiniChart } from "./chart-model";
import type { MiniChartData, MiniChartPoint } from "./chart-model";
import { ReadableFallback } from "./invalid";

const toneAccents: Readonly<Record<Tone, string>> = {
  neutral: "var(--primary)",
  info: "var(--primary)",
  positive: "var(--success)",
  warning: "var(--warning)",
  negative: "var(--destructive)",
  muted: "var(--muted-foreground)",
};

const chartHeight = 180;

const plotTop = 14;

const plotBottom = 148;

const textColor = "var(--foreground)";

const mutedColor = "var(--muted-foreground)";

const borderColor = "var(--border)";

function pointText(point: MiniChartPoint, unit: string): string {
  return `${point.label}: ${point.valueText}${unit ? ` ${unit}` : ""}`;
}

function axisText(value: number): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);

  if (magnitude < 0.001 || magnitude >= 1_000_000) {
    return value.toExponential(2).replace(/\.?0+e/u, "e");
  }

  return new Intl.NumberFormat(undefined, {
    maximumSignificantDigits: 5,
  }).format(value);
}

function domainEdge(value: number): number {
  if (value === 0) return 0;
  const absolute = Math.abs(value);
  const magnitude = 10 ** Math.floor(Math.log10(absolute));

  // Subnormal numbers have no representable power-of-ten below them.
  if (magnitude === 0) return value;

  return Math.sign(value) * Math.ceil((absolute * 1.08) / magnitude) * magnitude;
}

function visibleLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 16)}…` : label;
}

function ChartView({ data }: { data: MiniChartData }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const pointRefs = useRef<Array<SVGGElement | null>>([]);
  const [width, setWidth] = useState(360);
  const [tabPoint, setTabPoint] = useState(0);
  const [hoverPoint, setHoverPoint] = useState<number | null>(null);
  const [focusPoint, setFocusPoint] = useState<number | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const tooltipId = useId();

  useEffect(() => {
    const element = plotRef.current;

    if (!element) return;

    const measure = () => {
      const measured = element.getBoundingClientRect().width;

      if (Number.isFinite(measured) && measured > 0) {
        setWidth(Math.max(180, Math.round(measured)));
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setTabPoint((current) => Math.min(current, data.points.length - 1));
    setHoverPoint(null);
    setFocusPoint(null);
  }, [data]);

  const minimum = Math.min(0, ...data.points.map((point) => point.value));
  const maximum = Math.max(0, ...data.points.map((point) => point.value));
  const span = maximum - minimum;
  const lower = span === 0 ? -1 : domainEdge(minimum);
  const upper = span === 0 ? 1 : domainEdge(maximum);
  const domainSpan = upper - lower;

  const ticks = lower < 0 && upper > 0 ? [upper, 0, lower] : [upper, lower + domainSpan / 2, lower];

  const axisWidth = Math.min(
    82,
    Math.max(30, ...ticks.map((tick) => axisText(tick).length * 6.5 + 10)),
  );

  const plotLeft = axisWidth;
  const plotRight = width - 10;
  const plotWidth = plotRight - plotLeft;
  const step = plotWidth / data.points.length;
  const barWidth = Math.max(1, step * 0.62);

  const x = (index: number) =>
    data.kind === "bar"
      ? plotLeft + step * (index + 0.5)
      : plotLeft + (plotWidth * index) / (data.points.length - 1);

  const y = (value: number) => plotBottom - ((value - lower) / domainSpan) * (plotBottom - plotTop);

  const zeroY = y(0);
  const selectedPoint = hoverPoint ?? focusPoint;
  const activePoint = selectedPoint === null ? null : data.points[selectedPoint];

  const accent = toneAccents[data.tone];

  const lastPoint = data.points[data.points.length - 1];

  const path = data.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point.value)}`)
    .join(" ");

  const summary = `${data.label}. ${data.kind === "bar" ? "Bar" : "Line"} chart with ${data.points.length} points. First ${pointText(data.points[0], data.unit)}. Latest ${pointText(lastPoint, data.unit)}. Values range from ${Math.min(...data.points.map((point) => point.value))} to ${Math.max(...data.points.map((point) => point.value))}${data.unit ? ` ${data.unit}` : ""}.`;

  function moveFocus(event: KeyboardEvent<SVGGElement>, index: number) {
    let next: number;

    switch (event.key) {
      case "ArrowLeft":
        next = Math.max(0, index - 1);
        break;
      case "ArrowRight":
        next = Math.min(data.points.length - 1, index + 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = data.points.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    setHoverPoint(null);
    setTabPoint(next);
    pointRefs.current[next]?.focus();
  }

  return (
    <section
      className="omnyo-inline-chart"
      data-tone={data.tone}
      aria-label={data.label}
      style={frameStyle}
    >
      <div className="omnyo-inline-chart__header" style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <h3
            className="omnyo-inline-chart__heading"
            style={{ margin: 0, fontSize: "0.875rem", fontWeight: 600, overflowWrap: "anywhere" }}
          >
            {data.label}
          </h3>
          <span style={{ color: mutedColor, fontSize: "0.75rem" }}>{lastPoint.label}</span>
        </div>
        <div
          className="omnyo-inline-chart__latest"
          aria-label={`Latest ${pointText(lastPoint, data.unit)}`}
          style={{
            minWidth: 0,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            overflowWrap: "anywhere",
          }}
        >
          <strong style={{ fontSize: "1.125rem", fontWeight: 600 }}>{lastPoint.valueText}</strong>
          {data.unit ? (
            <span style={{ marginLeft: "0.35rem", color: mutedColor, fontSize: "0.75rem" }}>
              {data.unit}
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="omnyo-inline-chart__plot"
        ref={plotRef}
        style={{ position: "relative", minWidth: 0, marginTop: "0.5rem" }}
      >
        <svg
          className="omnyo-inline-chart__svg"
          width="100%"
          height={chartHeight}
          viewBox={`0 0 ${width} ${chartHeight}`}
          role="group"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          style={{ display: "block", overflow: "visible" }}
        >
          <title id={titleId}>{data.label}</title>
          <desc id={descriptionId}>
            {summary} Use Left and Right arrows, Home, or End to inspect points. The data table
            follows the chart.
          </desc>
          {ticks.map((tick, index) => (
            <g key={index} aria-hidden="true">
              <line
                x1={plotLeft}
                x2={plotRight}
                y1={y(tick)}
                y2={y(tick)}
                stroke={borderColor}
                strokeWidth={tick === 0 ? 1.25 : 0.75}
                strokeDasharray={tick === 0 ? undefined : "2 4"}
              />
              <text
                x={plotLeft - 8}
                y={y(tick) + 3.5}
                textAnchor="end"
                fill={mutedColor}
                fontSize="10"
                fontFamily="inherit"
              >
                {axisText(tick)}
              </text>
            </g>
          ))}
          {data.kind === "line" ? (
            <path
              d={path}
              fill="none"
              stroke={accent}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              aria-hidden="true"
            />
          ) : null}
          {data.points.map((point, index) => {
            const pointX = x(index);
            const pointY = y(point.value);
            const active = index === selectedPoint;
            const left = index === 0 ? plotLeft : (x(index - 1) + pointX) / 2;

            const right =
              index === data.points.length - 1 ? plotRight : (pointX + x(index + 1)) / 2;

            return (
              <g
                className="omnyo-inline-chart__point"
                key={index}
                ref={(element) => {
                  pointRefs.current[index] = element;
                }}
                role="img"
                aria-label={pointText(point, data.unit)}
                aria-describedby={active ? tooltipId : undefined}
                tabIndex={tabPoint === index ? 0 : -1}
                onKeyDown={(event) => moveFocus(event, index)}
                onFocus={() => {
                  setTabPoint(index);
                  setHoverPoint(null);
                  setFocusPoint(index);
                }}
                onBlur={() => setFocusPoint(null)}
                onMouseEnter={() => setHoverPoint(index)}
                onMouseLeave={() => setHoverPoint(null)}
                onClick={(event) => {
                  setTabPoint(index);
                  event.currentTarget.focus();
                }}
                style={{ outline: "none", cursor: "crosshair" }}
              >
                {data.kind === "bar" ? (
                  <rect
                    x={pointX - barWidth / 2}
                    y={Math.min(zeroY, pointY)}
                    width={barWidth}
                    height={Math.abs(zeroY - pointY)}
                    rx="1.5"
                    fill={accent}
                    opacity={active ? 1 : 0.72}
                    aria-hidden="true"
                  />
                ) : (
                  <circle
                    cx={pointX}
                    cy={pointY}
                    r={active ? 4 : 2.5}
                    fill={accent}
                    aria-hidden="true"
                  />
                )}
                {active ? (
                  <>
                    <line
                      x1={pointX}
                      x2={pointX}
                      y1={plotTop}
                      y2={plotBottom}
                      stroke={mutedColor}
                      strokeDasharray="2 3"
                      opacity="0.5"
                      aria-hidden="true"
                    />
                    <circle
                      cx={pointX}
                      cy={pointY}
                      r="7"
                      fill="none"
                      stroke={accent}
                      strokeWidth="1.5"
                      aria-hidden="true"
                    />
                  </>
                ) : null}
                <rect
                  x={left}
                  y={plotTop - 6}
                  width={Math.max(1, right - left)}
                  height={plotBottom - plotTop + 12}
                  fill="transparent"
                  aria-hidden="true"
                />
              </g>
            );
          })}
          <text
            x={plotLeft}
            y={chartHeight - 8}
            fill={mutedColor}
            fontSize="10"
            fontFamily="inherit"
            aria-hidden="true"
          >
            {visibleLabel(data.points[0].label)}
          </text>
          <text
            x={plotRight}
            y={chartHeight - 8}
            textAnchor="end"
            fill={mutedColor}
            fontSize="10"
            fontFamily="inherit"
            aria-hidden="true"
          >
            {visibleLabel(lastPoint.label)}
          </text>
        </svg>
        {activePoint ? (
          <div
            className="omnyo-inline-chart__tooltip"
            id={tooltipId}
            role="tooltip"
            style={tooltipStyle}
          >
            <span style={{ fontWeight: 600 }}>{activePoint.label}</span>
            <span>
              {activePoint.valueText}
              {data.unit ? ` ${data.unit}` : ""}
            </span>
          </div>
        ) : null}
      </div>
      {data.note ? (
        <p
          className="omnyo-inline-chart__note"
          style={{
            margin: "0.4rem 0 0",
            color: mutedColor,
            fontSize: "0.75rem",
            lineHeight: 1.5,
            overflowWrap: "anywhere",
          }}
        >
          {data.note}
        </p>
      ) : null}
      <details
        className="omnyo-inline-chart__details"
        style={{ marginTop: "0.5rem", fontSize: "12px" }}
      >
        <summary style={{ cursor: "pointer", color: mutedColor, width: "fit-content" }}>
          Data · {data.points.length} points
        </summary>
        <div style={{ overflowX: "auto", marginTop: "0.5rem" }}>
          <table
            className="omnyo-inline-chart__table"
            style={{
              fontSize: "inherit",
              borderCollapse: "collapse",
              width: "100%",
              textAlign: "left",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <caption style={visuallyHiddenStyle}>
              {data.label} values{data.unit ? ` in ${data.unit}` : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col" style={cellStyle}>
                  Point
                </th>
                <th scope="col" style={{ ...cellStyle, textAlign: "right" }}>
                  {data.unit || "Value"}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.points.map((point, index) => (
                <tr key={index}>
                  <th
                    scope="row"
                    style={{ ...cellStyle, fontWeight: 400, overflowWrap: "anywhere" }}
                  >
                    {point.label}
                  </th>
                  <td style={{ ...cellStyle, textAlign: "right", overflowWrap: "anywhere" }}>
                    {point.valueText}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

/** SDK directive entry point. Input that cannot be charted stays readable as text. */
export function MiniChart({ attributes, source }: PluginMessageDirectiveProps) {
  const parsed = useMemo(() => parseMiniChart(attributes), [attributes]);

  if (!parsed.ok) {
    return <ReadableFallback attributes={attributes} reason={parsed.reason} source={source} />;
  }

  return <ChartView data={parsed.data} />;
}

const frameStyle: CSSProperties = {
  minWidth: 0,
  width: "100%",
  boxSizing: "border-box",
  margin: "0.875rem 0",
  padding: "0.75rem 0",
  borderTop: `1px solid ${borderColor}`,
  borderBottom: `1px solid ${borderColor}`,
  color: textColor,
  fontFamily: "inherit",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "1rem",
};

const tooltipStyle: CSSProperties = {
  position: "absolute",
  right: "0.25rem",
  top: "0.25rem",
  zIndex: 1,
  display: "flex",
  flexDirection: "column",
  gap: "0.1rem",
  maxWidth: "min(80%, 260px)",
  padding: "0.35rem 0.5rem",
  border: `1px solid ${borderColor}`,
  borderRadius: "0.3rem",
  background: "var(--muted)",
  color: textColor,
  fontSize: "0.75rem",
  lineHeight: 1.4,
  overflowWrap: "anywhere",
  pointerEvents: "none",
  fontVariantNumeric: "tabular-nums",
};

const cellStyle: CSSProperties = {
  padding: "0.35rem 0",
  borderBottom: `1px solid ${borderColor}`,
  verticalAlign: "top",
};

const visuallyHiddenStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};
