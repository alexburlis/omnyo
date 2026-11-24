import "./stats-speed.css";

import type { CSSProperties } from "react";

export const label =
  "The Model speed tab in Omnyo Stats: four model and thinking effort pairs with their median tokens per second, measured turns and a trend line. The medians fill in as bars, the trend lines draw, and a new measured turn nudges Opus 5.5 from 78.4 to 79.1 tokens per second.";

interface SpeedRow {
  model: string;
  provider: string;
  effort: string;
  median: string;
  next: string | null;
  bar: number;
  turns: string;
  trend: string;
}

const ROWS: readonly SpeedRow[] = [
  {
    model: "GPT-5.6",
    provider: "Codex",
    effort: "medium",
    median: "112.6",
    next: null,
    bar: 1,
    turns: "986",
    trend: "M0 14 L12 12 L24 13 L36 9 L48 10 L60 7 L72 8 L84 5 L96 6",
  },
  {
    model: "Sonnet 5",
    provider: "Claude Code",
    effort: "medium",
    median: "96.1",
    next: null,
    bar: 0.85,
    turns: "412",
    trend: "M0 9 L12 10 L24 8 L36 11 L48 9 L60 9 L72 7 L84 8 L96 7",
  },
  {
    model: "Opus 5.5",
    provider: "Claude Code",
    effort: "high",
    median: "78.4",
    next: "79.1",
    bar: 0.7,
    turns: "1,204",
    trend: "M0 12 L12 13 L24 11 L36 12 L48 10 L60 11 L72 9 L84 10 L96 7",
  },
  {
    model: "GPT-5.6",
    provider: "Codex",
    effort: "high",
    median: "64.0",
    next: null,
    bar: 0.57,
    turns: "230",
    trend: "M0 8 L12 9 L24 11 L36 10 L48 12 L60 11 L72 12 L84 11 L96 12",
  },
];

export function Visual() {
  return (
    <div className="fv fv-stats-speed" aria-hidden="true">
      <ul className="fv-ss-tabs">
        <li>Overview</li>
        <li className="is-on">Model speed</li>
        <li>Coverage &amp; storage</li>
      </ul>
      <p className="fv-ss-summary">
        <span>
          <span className="fv-dim">Measured turns </span>2,832
        </span>
        <span>
          <span className="fv-dim">Measured output </span>9.4M
        </span>
        <span>
          <span className="fv-dim">Pooled model speed </span>88.2 tok/s
        </span>
      </p>
      <div className="fv-ss-table">
        <p className="fv-ss-row is-head">
          <span>Model / provider</span>
          <span>Thinking effort</span>
          <span className="is-num">Median tok/s</span>
          <span className="is-num">Measured turns</span>
          <span>Trend</span>
        </p>
        {ROWS.map((row, index) => (
          <div
            key={`${row.model}-${row.effort}`}
            className={`fv-ss-row ${row.next ? "is-live" : ""}`}
            style={{ "--ss-i": index, "--ss-bar": row.bar } as CSSProperties}
          >
            <span className="fv-ss-model">
              <b>{row.model}</b>
              <span className="fv-dim">{row.provider}</span>
            </span>
            <span className="fv-soft">{row.effort}</span>
            <span className="fv-ss-median is-num">
              <i className="fv-ss-bar" />
              {row.next ? (
                <span className="fv-ss-swap">
                  <b className="is-old">{row.median}</b>
                  <b className="is-new">{row.next}</b>
                </span>
              ) : (
                <b>{row.median}</b>
              )}
            </span>
            <span className="is-num fv-soft">{row.turns}</span>
            <span className="fv-ss-trend">
              <svg viewBox="0 0 96 18" preserveAspectRatio="none">
                <path d={row.trend} />
              </svg>
              <i />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
