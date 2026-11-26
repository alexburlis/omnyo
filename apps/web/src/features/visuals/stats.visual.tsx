import type { ReactNode } from "react";

export const label =
  "The Stats page live: agents running ticks from 5 to 6 as a subagent starts, output throughput moves with the work, and the charts of agents working in parallel and output throughput draw in.";

interface Metric {
  kicker: string | null;
  title: string;
  scope: string;
  value: ReactNode;
  unit: string | null;
  caption: ReactNode;
  foot: ReactNode;
  tone: "live" | "speed" | null;
}

const Sub = () => <span className="fv-stats-sub" />;

const METRICS: readonly Metric[] = [
  {
    kicker: "Live now",
    title: "Agents running",
    scope: "global",
    value: <span className="fv-stats-run" />,
    unit: null,
    caption: (
      <>
        3 active chats · <Sub /> native agents
      </>
    ),
    foot: (
      <>
        <span>
          <b>3</b> main
        </span>
        <span>
          <b>
            <Sub />
          </b>{" "}
          subagent
        </span>
        <span>
          <b>0</b> unknown
        </span>
      </>
    ),
    tone: "live",
  },
  {
    kicker: null,
    title: "Output throughput",
    scope: "All agents · 5m average",
    value: <span className="fv-stats-tps" />,
    unit: "tok/s",
    caption: "42.6K output tokens · 300/300s observed",
    foot: "Wall-clock throughput",
    tone: "speed",
  },
  {
    kicker: null,
    title: "Generated all time",
    scope: "Output tokens · global",
    value: "18.6M",
    unit: null,
    caption: "4.1M reasoning tokens included",
    foot: "Retained after chat deletion",
    tone: null,
  },
  {
    kicker: null,
    title: "Input all time",
    scope: "All providers · global",
    value: "92.4M",
    unit: null,
    caption: "61.2M cached · 172.2M provider total",
    foot: "Local, durable SQLite",
    tone: null,
  },
];

const TABS = ["Overview", "Model speed", "Coverage & storage"] as const;

const CHARTS = [
  {
    metric: "agents",
    eyebrow: "Execution density",
    title: "Agents working in parallel",
    value: "6",
    unit: "agents · peak",
    line: "M48 150 C70 148 84 128 104 124 S138 132 158 112 S196 76 220 82 S252 108 276 98 S318 54 342 58 S382 92 408 84 S446 62 470 66 S514 104 538 96 S586 72 610 76 L672 80",
    peak: "M48 132 L104 104 L158 92 L220 58 L276 76 L342 38 L408 62 L470 46 L538 74 L610 54 L672 60",
    end: 80,
  },
  {
    metric: "tps",
    eyebrow: "Token velocity",
    title: "Total output throughput",
    value: "310",
    unit: "tok/s · peak",
    line: "M48 160 C66 152 80 118 100 122 S132 150 150 136 S182 70 204 78 S236 128 258 118 S290 52 314 60 S352 118 376 110 S414 84 436 92 S470 136 494 126 S536 66 560 72 S604 112 628 104 L672 100",
    peak: null,
    end: 100,
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-stats" aria-hidden="true">
      <div className="fv-stats-page">
        <header className="fv-stats-mast">
          <span className="fv-stats-brand">
            <svg viewBox="0 0 24 24">
              <path d="M4 17V7h6l4 10h6V7M4 12h16" />
              <circle cx="4" cy="7" r="2" />
              <circle cx="20" cy="17" r="2" />
              <circle cx="12" cy="12" r="2" />
            </svg>
          </span>
          <div>
            <p className="fv-stats-eyebrow">Agent observatory</p>
            <h3 className="fv-stats-title">Stats</h3>
          </div>
          <span className="fv-stats-status">
            <i />
            Live telemetry
          </span>
          <span className="fv-stats-refresh">
            <svg viewBox="0 0 16 16">
              <path d="M13 6a5 5 0 1 0 .3 3M13 2v4H9" />
            </svg>
            Refresh
          </span>
        </header>
        <ul className="fv-stats-summary">
          {METRICS.map((metric) => (
            <li
              key={metric.title}
              className={metric.tone ? `is-${metric.tone}` : ""}
            >
              <p className="fv-stats-head">
                {metric.kicker ? (
                  <span className="fv-stats-kicker">{metric.kicker}</span>
                ) : (
                  <span>{metric.title}</span>
                )}
                <span>
                  {metric.kicker
                    ? `${metric.title} · ${metric.scope}`
                    : metric.scope}
                </span>
              </p>
              <p className="fv-stats-value">
                <span>{metric.value}</span>
                {metric.unit ? <small>{metric.unit}</small> : null}
              </p>
              <p className="fv-stats-caption">{metric.caption}</p>
              <p className="fv-stats-foot">{metric.foot}</p>
            </li>
          ))}
        </ul>
        <ul className="fv-stats-nav">
          {TABS.map((tab, index) => (
            <li key={tab} className={index === 0 ? "is-on" : ""}>
              {tab}
            </li>
          ))}
        </ul>
        <div className="fv-stats-charts">
          {CHARTS.map((chart) => (
            <section
              key={chart.metric}
              className={`fv-stats-chart is-${chart.metric}`}
            >
              <div className="fv-stats-chart-head">
                <div>
                  <p className="fv-stats-eyebrow">{chart.eyebrow}</p>
                  <h4>{chart.title}</h4>
                  <p className="fv-stats-stat">
                    {chart.value}
                    <small>{chart.unit}</small>
                  </p>
                </div>
                <p className="fv-stats-meta">5 min buckets</p>
              </div>
              <div className="fv-stats-plot">
                <svg viewBox="0 0 704 190" preserveAspectRatio="none">
                  {[36, 71, 106, 141, 176].map((y) => (
                    <line
                      key={y}
                      className="fv-stats-rule"
                      x1="48"
                      x2="672"
                      y1={y}
                      y2={y}
                    />
                  ))}
                </svg>
                <div className="fv-stats-ink">
                  <svg
                    className="fv-stats-area"
                    viewBox="0 0 704 190"
                    preserveAspectRatio="none"
                  >
                    <path d={`${chart.line} L672 176 L48 176 Z`} />
                  </svg>
                  <svg viewBox="0 0 704 190" preserveAspectRatio="none">
                    {chart.peak ? (
                      <path className="fv-stats-peak" d={chart.peak} />
                    ) : null}
                    <path className="fv-stats-line" d={chart.line} />
                  </svg>
                </div>
                <span
                  className="fv-stats-now"
                  style={{ top: `${(chart.end / 190) * 100}%` }}
                />
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
