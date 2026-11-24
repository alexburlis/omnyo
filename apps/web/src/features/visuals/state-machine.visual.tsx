import "./state-machine.css";

export const label =
  "A running State Machines instance moving through its loop: a new commit runs the checks, a failure goes to the fixer agent, its PR runs the checks again and success returns to waiting for commits, with the current state highlighted as it moves.";

type Kind = "wait" | "command" | "agent" | "manual" | "end";

type Direction = "right" | "left" | "up" | "down";

type Step = "wait" | "checks" | "fixer";

const NODES: readonly {
  kind: Kind;
  title: string;
  sub: string;
  x: number;
  y: number;
  step: Step | null;
  phase: string;
}[] = [
  {
    kind: "wait",
    title: "Wait for commits",
    sub: "every 5m",
    x: 1.8,
    y: 3,
    step: "wait",
    phase: "Waiting",
  },
  {
    kind: "command",
    title: "Run checks",
    sub: "pnpm test",
    x: 20.8,
    y: 3,
    step: "checks",
    phase: "Running",
  },
  {
    kind: "agent",
    title: "Fixer agent",
    sub: "opens a PR",
    x: 39.8,
    y: 3,
    step: "fixer",
    phase: "Running",
  },
  {
    kind: "end",
    title: "Stopped",
    sub: "end",
    x: 1.8,
    y: 11.6,
    step: null,
    phase: "",
  },
  {
    kind: "manual",
    title: "Needs a person",
    sub: "loop paused",
    x: 20.8,
    y: 11.6,
    step: null,
    phase: "",
  },
];

const EDGES: readonly {
  d: string;
  to: readonly [number, number, Direction];
  label: string;
  at: readonly [number, number];
  far: boolean;
  hot: string | null;
}[] = [
  {
    d: "M13.8 4.6H20.8",
    to: [20.8, 4.6, "right"],
    label: "new commit",
    at: [17.3, 4.6],
    far: false,
    hot: "commit",
  },
  {
    d: "M20.8 6.2H13.8",
    to: [13.8, 6.2, "left"],
    label: "succeeded",
    at: [17.3, 6.2],
    far: false,
    hot: "passed",
  },
  {
    d: "M32.8 4.6H39.8",
    to: [39.8, 4.6, "right"],
    label: "failed",
    at: [36.3, 4.6],
    far: true,
    hot: "failed",
  },
  {
    d: "M39.8 6.2H32.8",
    to: [32.8, 6.2, "left"],
    label: "PR opened",
    at: [36.3, 6.2],
    far: true,
    hot: "pr",
  },
  {
    d: "M45.8 7.6V13.9H32.8",
    to: [32.8, 13.9, "left"],
    label: "timed out",
    at: [45.8, 10.75],
    far: true,
    hot: null,
  },
  {
    d: "M26.8 11.6V7.6",
    to: [26.8, 7.6, "up"],
    label: "retry",
    at: [26.8, 9.6],
    far: false,
    hot: null,
  },
  {
    d: "M20.8 13.9H13.8",
    to: [13.8, 13.9, "left"],
    label: "stop",
    at: [17.3, 13.9],
    far: false,
    hot: null,
  },
  {
    d: "M0.55 5.3H1.8",
    to: [1.8, 5.3, "right"],
    label: "",
    at: [0, 0],
    far: false,
    hot: null,
  },
];

const STATUS: readonly { step: Step; title: string; phase: string }[] = [
  { step: "wait", title: "Wait for commits", phase: "Waiting" },
  { step: "checks", title: "Run checks", phase: "Running" },
  { step: "fixer", title: "Fixer agent", phase: "Running" },
];

function head([x, y, direction]: readonly [number, number, Direction]) {
  const long = 0.62;
  const wide = 0.3;

  switch (direction) {
    case "right":
      return `M${x} ${y}L${x - long} ${y - wide}L${x - long} ${y + wide}Z`;
    case "left":
      return `M${x} ${y}L${x + long} ${y - wide}L${x + long} ${y + wide}Z`;
    case "up":
      return `M${x} ${y}L${x - wide} ${y + long}L${x + wide} ${y + long}Z`;
    case "down":
      return `M${x} ${y}L${x - wide} ${y - long}L${x + wide} ${y - long}Z`;
  }
}

function Glyph({ kind }: { kind: Kind }) {
  switch (kind) {
    case "wait":
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "command":
      return (
        <svg viewBox="0 0 24 24">
          <path d="m5 7 5 5-5 5M12 18h7" />
        </svg>
      );
    case "agent":
      return (
        <svg viewBox="0 0 24 24">
          <rect x="4" y="8" width="16" height="12" rx="3" />
          <path d="M12 4v4M9 13v2M15 13v2" />
        </svg>
      );
    case "manual":
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="8" r="4" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      );
    case "end":
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12 2.5 2.5 4.5-5" />
        </svg>
      );
  }
}

export function Visual() {
  return (
    <div className="fv fv-state-machine" aria-hidden="true">
      <div className="fv-sm-page">
        <p className="fv-sm-crumbs">
          <span>State machines</span>
          <span>harbor-ledger check loop</span>
          <span>Instance #4f2a9c</span>
        </p>
        <div className="fv-sm-header">
          <h4>harbor-ledger check loop</h4>
          <span className="fv-sm-pill">
            <i />
            Running
          </span>
          <span className="fv-sm-chip">v3</span>
          <span className="fv-sm-actions">
            <span className="fv-sm-button is-primary">
              <svg viewBox="0 0 24 24">
                <path d="M9 5v14M15 5v14" />
              </svg>
              Pause
            </span>
            <span className="fv-sm-button is-icon">
              <svg viewBox="0 0 24 24">
                <path d="M5 12h.01M12 12h.01M19 12h.01" />
              </svg>
            </span>
          </span>
        </div>
        <p className="fv-sm-status">
          <span>Now in </span>
          <span className="fv-sm-swap">
            {STATUS.map((entry) => (
              <span key={entry.step} className={`is-${entry.step}`}>
                <b>{entry.title}</b>
                <span> · {entry.phase}</span>
              </span>
            ))}
          </span>
        </p>
        <p className="fv-sm-toggle">
          <span className="is-on">Graph</span>
          <span>Outline</span>
          <span>Log</span>
        </p>
        <div className="fv-sm-canvas">
          <div className="fv-sm-world">
            <svg className="fv-sm-edges" viewBox="0 0 53 17.2">
              <circle className="fv-sm-initial" cx="0.55" cy="5.3" r="0.34" />
              {EDGES.map((edge) => (
                <g key={edge.d}>
                  <path className="fv-sm-line" d={edge.d} />
                  <path className="fv-sm-head" d={head(edge.to)} />
                  {edge.hot ? (
                    <g className={`fv-sm-hot is-${edge.hot}`}>
                      <path className="fv-sm-line" d={edge.d} />
                      <path className="fv-sm-head" d={head(edge.to)} />
                    </g>
                  ) : null}
                </g>
              ))}
            </svg>
            {EDGES.filter((edge) => edge.label !== "").map((edge) => (
              <span
                key={edge.label}
                className={`fv-sm-label${edge.far ? " is-far" : ""}`}
                style={{ left: `${edge.at[0]}em`, top: `${edge.at[1]}em` }}
              >
                <span>{edge.label}</span>
              </span>
            ))}
            {NODES.map((node) => (
              <div
                key={node.title}
                className={`fv-sm-node${node.step ? ` is-${node.step}` : ""}`}
                style={{ left: `${node.x}em`, top: `${node.y}em` }}
              >
                <span className="fv-sm-node-head">
                  <Glyph kind={node.kind} />
                  <b>{node.title}</b>
                </span>
                <span className="fv-sm-node-sub">{node.sub}</span>
                <span className="fv-sm-node-meta">{node.phase}</span>
                {node.kind === "command" || node.kind === "agent" ? (
                  <span className="fv-sm-progress" />
                ) : null}
              </div>
            ))}
            <span className="fv-sm-token" />
          </div>
        </div>
      </div>
    </div>
  );
}
