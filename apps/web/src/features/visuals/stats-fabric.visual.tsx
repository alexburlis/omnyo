import type { CSSProperties } from "react";

export const label =
  "The Work distribution section of Omnyo Stats. Bars split 18.6M output tokens by model, provider, machine and thinking level. Clicking win-3090 filters the page to that machine, the total drops to 6.2M and every bar redraws for it.";

interface Segment {
  label: string;
  share: number;
}

interface Row {
  title: string;
  all: readonly Segment[];
  picked: readonly Segment[];
}

const ROWS: readonly Row[] = [
  {
    title: "Models",
    all: [
      { label: "Opus 5.5", share: 46 },
      { label: "GPT-5.6", share: 31 },
      { label: "Sonnet 5", share: 17 },
      { label: "Other", share: 6 },
    ],
    picked: [
      { label: "GPT-5.6", share: 58 },
      { label: "Opus 5.5", share: 34 },
      { label: "Sonnet 5", share: 8 },
    ],
  },
  {
    title: "Providers",
    all: [
      { label: "Claude Code", share: 63 },
      { label: "Codex", share: 37 },
    ],
    picked: [
      { label: "Codex", share: 58 },
      { label: "Claude Code", share: 42 },
    ],
  },
  {
    title: "Machines",
    all: [
      { label: "macbook", share: 41 },
      { label: "win-3090", share: 33 },
      { label: "mac-mini", share: 18 },
      { label: "linux-box", share: 8 },
    ],
    picked: [{ label: "win-3090", share: 100 }],
  },
  {
    title: "Thinking levels",
    all: [
      { label: "high", share: 52 },
      { label: "medium", share: 38 },
      { label: "low", share: 10 },
    ],
    picked: [
      { label: "high", share: 71 },
      { label: "medium", share: 29 },
    ],
  },
];

const TONE: Record<string, string> = {
  "Opus 5.5": "is-t0",
  "GPT-5.6": "is-t1",
  "Sonnet 5": "is-t2",
  "Claude Code": "is-t0",
  Codex: "is-t1",
  macbook: "is-t0",
  "win-3090": "is-t1",
  "mac-mini": "is-t2",
  high: "is-t0",
  medium: "is-t1",
  low: "is-t2",
};

const tone = (label: string) => TONE[label] ?? "is-t3";

function Bar({
  segments,
  layer,
  row,
}: {
  segments: readonly Segment[];
  layer: "all" | "picked";
  row: number;
}) {
  let start = 0;

  return (
    <div className={`fv-sf-bar is-${layer}`}>
      {segments.map((segment, index) => {
        const style = {
          left: `${start}%`,
          width: `${segment.share}%`,
          "--sf-delay": `${row * 0.08 + index * 0.05}s`,
        } as CSSProperties;

        start += segment.share;

        return (
          <i
            key={segment.label}
            className={`${tone(segment.label)} ${
              layer === "all" && segment.label === "win-3090" ? "is-pick" : ""
            }`}
            style={style}
          />
        );
      })}
    </div>
  );
}

function Legend({ segments }: { segments: readonly Segment[] }) {
  return (
    <ul className="fv-sf-legend">
      {segments.slice(0, 3).map((segment) => (
        <li key={segment.label}>
          <i className={tone(segment.label)} />
          {segment.label}
          <span>{segment.share}%</span>
        </li>
      ))}
    </ul>
  );
}

export function Visual() {
  return (
    <div className="fv fv-stats-fabric" aria-hidden="true">
      <header className="fv-sf-head">
        <div>
          <p className="fv-sf-eyebrow">Work distribution</p>
          <h3>Execution fabric</h3>
        </div>
        <span className="fv-sf-filter">
          Machine: win-3090
          <svg viewBox="0 0 12 12">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </span>
        <p className="fv-sf-total">
          <span className="fv-sf-eyebrow">Selected output</span>
          <span className="fv-sf-swap">
            <b className="is-all">18.6M</b>
            <b className="is-picked">6.2M</b>
          </span>
        </p>
      </header>
      <ul className="fv-sf-rows">
        {ROWS.map((row, index) => (
          <li key={row.title}>
            <p className="fv-sf-title">{row.title}</p>
            <div className="fv-sf-track">
              <Bar segments={row.all} layer="all" row={index} />
              <Bar segments={row.picked} layer="picked" row={index} />
              {row.title === "Machines" ? (
                <svg className="fv-sf-cursor" viewBox="0 0 16 20">
                  <path d="M2 1.5v14.2l3.6-3.4 2.4 5.6 2.5-1.1-2.4-5.5H13z" />
                </svg>
              ) : null}
            </div>
            <div className="fv-sf-swap">
              <div className="is-all">
                <Legend segments={row.all} />
              </div>
              <div className="is-picked">
                <Legend segments={row.picked} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
