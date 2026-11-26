export const label =
  "A running State Machines instance with its Pause and Stop controls. Under Active work, the Fix the failing check agent step runs out of its 30-minute deadline on attempt 1 of 3, is marked Timed out, waits to retry and starts attempt 2 with a fresh deadline, while the history records each step.";

const PHASES = [
  {
    key: "a",
    status: "Running · 28m · 1/3",
    meta: "Agent · attempt 1/3 · studio-mac · deadline in 2m",
  },
  {
    key: "b",
    status: "Timed out",
    meta: "Agent · attempt 1/3 · studio-mac · deadline passed",
  },
  {
    key: "c",
    status: "Retry 2/3 in 30s",
    meta: "Agent · attempt 2/3 · studio-mac",
  },
  {
    key: "d",
    status: "Running · 0s · 2/3",
    meta: "Agent · attempt 2/3 · studio-mac · deadline in 30m",
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-state-machines-work" aria-hidden="true">
      <header className="fv-state-machines-work-head">
        <div>
          <h3>
            Local check loop
            <span className="fv-state-machines-work-live">Running</span>
          </h3>
          <p>harbor-ledger · feat/csv-export</p>
        </div>
        <span className="fv-state-machines-work-btn">
          <svg viewBox="0 0 16 16">
            <path d="M5.5 3.5v9M10.5 3.5v9" />
          </svg>
          Pause
        </span>
        <span className="fv-state-machines-work-btn">
          <svg viewBox="0 0 16 16">
            <rect x="4" y="4" width="8" height="8" rx="1.2" />
          </svg>
          Stop…
        </span>
      </header>
      <section className="fv-panel fv-state-machines-work-card">
        <p className="fv-state-machines-work-label">Active work</p>
        <div className="fv-state-machines-work-step">
          <div className="fv-state-machines-work-main">
            <b>Fix the failing check</b>
            <span className="fv-state-machines-work-swap">
              {PHASES.map((phase) => (
                <span
                  key={phase.key}
                  className={`is-${phase.key} ${phase.key === "b" ? "is-bad" : ""}`}
                >
                  {phase.status}
                </span>
              ))}
            </span>
            <span className="fv-state-machines-work-swap fv-state-machines-work-meta">
              {PHASES.map((phase) => (
                <span key={phase.key} className={`is-${phase.key}`}>
                  {phase.meta}
                </span>
              ))}
            </span>
          </div>
          <span className="fv-state-machines-work-btn">Open thread</span>
        </div>
      </section>
      <p className="fv-eyebrow">History</p>
      <ul className="fv-state-machines-work-log">
        <li className="is-new">
          <i className="fv-dot fv-dot--bad" />
          <b>Fix the failing check</b>
          <span>attempt 1 timed out after 30m</span>
        </li>
        <li>
          <i className="fv-dot fv-dot--bad" />
          <b>Run checks</b>
          <span>pnpm test exited 1 · Failed</span>
        </li>
        <li>
          <i className="fv-dot fv-dot--ok" />
          <b>Wait for a commit</b>
          <span>feat/csv-export · 4f2a9c1</span>
        </li>
      </ul>
    </div>
  );
}
