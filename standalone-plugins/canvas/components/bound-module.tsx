import { useId } from "react";
import { z } from "zod";
import type { Dataset, NodeBinding, SourceRecord } from "../source-contract";

export interface BoundModuleProps {
  binding: NodeBinding;
  dataset: Dataset | null;
  source?: SourceRecord;
}

function cellText(
  value: string | number | boolean | null | undefined,
  format?: NodeBinding["format"],
): string {
  if (value === null || value === undefined) return "—";

  const numeric = z.number().safeParse(value);

  if (!numeric.success) return String(value);
  value = numeric.data;

  if (format === "percent")
    return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 }).format(
      value,
    );

  if (format === "currency")
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

function DataTable({ dataset }: { dataset: Dataset }) {
  return (
    <>
      <table className="cnv-module-table">
        <thead>
          <tr>
            {dataset.columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataset.rows.slice(0, 100).map((row, index) => (
            <tr key={index}>
              {dataset.columns.map((column) => (
                <td key={column.key}>{cellText(row[column.key], column.format)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {dataset.rows.length > 100 ? (
        <p className="cnv-module-meta">
          Showing 100 of {dataset.rows.length.toLocaleString()} rows. The complete dataset is
          available in Sources or canvas_dataset.
        </p>
      ) : null}
    </>
  );
}

export function BoundModule({ binding, dataset, source }: BoundModuleProps) {
  const chartId = useId();

  if (dataset === null)
    return (
      <p className="cnv-module-meta">
        {source?.status === "error"
          ? source.error
          : "Refresh or push the source to load this module."}
      </p>
    );

  const numeric = binding.y
    ? dataset.columns.find((column) => column.key === binding.y && column.type === "number")
    : dataset.columns.find((column) => column.type === "number");

  const xColumn = binding.x
    ? dataset.columns.find((column) => column.key === binding.x)
    : dataset.columns.find((column) => column.type === "string");

  if (
    (binding.view !== "table" && binding.y && !numeric) ||
    ((binding.view === "bar" || binding.view === "line") && binding.x && !xColumn)
  )
    return (
      <p className="cnv-module-state" role="status">
        A bound column is no longer available. Update the module binding.
      </p>
    );

  const values = numeric
    ? dataset.rows.map((row) => ({
        value: row[numeric.key],
        label: xColumn ? cellText(row[xColumn.key]) : "",
      }))
    : [];

  const valid = values.flatMap((entry) => {
    const numeric = z.number().safeParse(entry.value);

    return numeric.success ? [{ value: numeric.data, label: entry.label }] : [];
  });

  const minimum = Math.min(0, ...valid.map((entry) => entry.value));
  const maximum = Math.max(0, ...valid.map((entry) => entry.value));
  const span = maximum - minimum || 1;
  const y = (value: number) => 182 - ((value - minimum) / span) * 152;
  const x = (index: number) => 74 + ((index + 0.5) / Math.max(1, valid.length)) * 560;
  const points = valid.map((entry, index) => `${x(index)},${y(entry.value)}`).join(" ");
  const gradient = `${chartId.replace(/[^\w-]/gu, "")}-area`;
  const last = valid.at(-1);

  const area =
    valid.length > 1
      ? `M ${x(0)},${y(0)} L ${points.replaceAll(" ", " L ")} L ${x(valid.length - 1)},${y(0)} Z`
      : null;

  const provenance = [
    dataset.provenance.windowLabel,
    dataset.provenance.timezone,
    dataset.provenance.cohort,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="cnv-module">
      {source?.status === "error" ? (
        <p className="cnv-editor-error" role="status">
          Refresh failed: {source.error}. Last successful data remains below.
        </p>
      ) : null}
      {source?.definition.paused ? <p className="cnv-module-meta">Polling paused</p> : null}
      {dataset.rows.length === 0 ? (
        <p>No rows in this source window.</p>
      ) : binding.view === "table" ? (
        <DataTable dataset={dataset} />
      ) : !numeric ? (
        <p>Choose a numeric column for this module.</p>
      ) : binding.view === "metric" ? (
        <div className="cnv-bound-metric">
          <div className="cnv-module-header">{numeric.label}</div>
          <div className="cnv-module-value">
            {cellText(dataset.rows[0]?.[numeric.key], binding.format)}
          </div>
          {dataset.provenance.unit ? (
            <div className="cnv-module-meta">{dataset.provenance.unit}</div>
          ) : null}
          {dataset.rows.length > 1 ? (
            <div className="cnv-module-meta">
              First of {dataset.rows.length.toLocaleString()} source rows
            </div>
          ) : null}
        </div>
      ) : valid.length === 0 ? (
        <p>No numeric values in this source window.</p>
      ) : (
        <>
          <svg
            className="cnv-module-chart"
            viewBox="0 0 680 220"
            role="img"
            aria-labelledby={`${chartId}-title ${chartId}-description`}
          >
            <title id={`${chartId}-title`}>
              {numeric.label} by {xColumn?.label ?? "source row"}
            </title>
            <desc id={`${chartId}-description`}>
              {valid.length} values. Minimum{" "}
              {cellText(Math.min(...valid.map((entry) => entry.value)))}; maximum{" "}
              {cellText(Math.max(...valid.map((entry) => entry.value)))}. A text table follows.
            </desc>
            <line x1="70" x2="650" y1={y(0)} y2={y(0)} className="canvas-gridline" />
            <text x="60" y="28" textAnchor="end">
              {cellText(maximum, binding.format)}
            </text>
            <text x="60" y="185" textAnchor="end">
              {cellText(minimum, binding.format)}
            </text>
            {binding.view === "line" ? (
              <>
                <defs>
                  <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" className="cnv-chart-area-top" />
                    <stop offset="100%" className="cnv-chart-area-bottom" />
                  </linearGradient>
                </defs>
                {area === null ? null : <path d={area} fill={`url(#${gradient})`} />}
                <polyline points={points} className="cnv-chart-line" />
                {last === undefined ? null : (
                  <circle
                    cx={x(valid.length - 1)}
                    cy={y(last.value)}
                    r="3.5"
                    className="cnv-chart-point"
                  />
                )}
              </>
            ) : (
              valid.map((entry, index) => (
                <rect
                  key={index}
                  x={x(index) - 210 / Math.max(1, valid.length)}
                  y={Math.min(y(0), y(entry.value))}
                  width={420 / Math.max(1, valid.length)}
                  height={Math.max(1, Math.abs(y(0) - y(entry.value)))}
                  rx="2"
                  className="canvas-bar"
                >
                  <title>
                    {entry.label}: {cellText(entry.value, binding.format)}
                  </title>
                </rect>
              ))
            )}
            {valid.length ? (
              <>
                <text x="74" y="210">
                  {valid[0]?.label}
                </text>
                <text x="644" y="210" textAnchor="end">
                  {valid.at(-1)?.label}
                </text>
              </>
            ) : null}
          </svg>
          <details className="cnv-module-note">
            <summary>Read values as a table</summary>
            <DataTable dataset={dataset} />
          </details>
        </>
      )}
      {provenance ? <p className="cnv-module-meta">{provenance}</p> : null}
      <p className="cnv-module-meta">
        Captured {new Date(dataset.capturedAt).toLocaleString()} · dataset {dataset.revision}
      </p>
    </div>
  );
}
