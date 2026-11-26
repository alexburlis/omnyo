export const label =
  "An automation that keeps failing: Nightly test run fails, a notification says Omnyo will retry it, two retries fail as well, and Omnyo pauses the automation and sends a second notification saying it stopped after repeated failures.";

const FAILS = [
  { when: "Nov 20, 2:01 AM", took: "3.2s" },
  { when: "Nov 20, 2:00 AM", took: "3.1s" },
  { when: "Nov 20, 2:00 AM", took: "3.4s" },
] as const;

function Cross() {
  return (
    <svg viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-automations-paused" aria-hidden="true">
      <header className="fv-automations-paused-head">
        <svg viewBox="0 0 16 16" className="fv-automations-paused-glyph">
          <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
          <path d="M2.5 6.8h11M5.5 2v3M10.5 2v3" />
        </svg>
        <h3>Nightly test run</h3>
        <i className="fv-automations-paused-toggle" />
      </header>
      <p className="fv-automations-paused-meta">
        <span>harbor-ledger</span>
        <span>At 02:00 AM</span>
        <span>
          <span className="fv-automations-paused-swap">
            <span className="is-before">Next Nov 20, 2:00 AM</span>
            <span className="is-after">Paused</span>
          </span>
        </span>
      </p>
      <p className="fv-automations-paused-error">
        <Cross />
        Working directory not found: ~/projects/harbor-ledger
      </p>
      <p className="fv-eyebrow">Runs</p>
      <ul className="fv-automations-paused-runs">
        {FAILS.map((run, index) => (
          <li key={index} className={`is-fail is-fail-${3 - index}`}>
            <span className="fv-automations-paused-icon">
              <Cross />
            </span>
            <b>{run.when}</b>
            <span>{run.took}</span>
          </li>
        ))}
        <li className="is-old">
          <span className="fv-automations-paused-icon is-ok">
            <svg viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6.2" />
              <path d="m5.4 8.2 1.8 1.8 3.5-3.7" />
            </svg>
          </span>
          <b>Nov 19, 2:00 AM</b>
          <span>184s</span>
        </li>
      </ul>
      <div className="fv-automations-paused-notes">
        <div className="fv-automations-paused-note is-first">
          <i className="fv-automations-paused-app">O</i>
          <b>Automation failed: Nightly test run</b>
          <p>
            Working directory not found. Omnyo retries it and pauses it after 3
            failures in a row.
          </p>
        </div>
        <div className="fv-automations-paused-note is-last">
          <i className="fv-automations-paused-app">O</i>
          <b>Automation paused: Nightly test run</b>
          <p>
            It stopped after repeated failures. Fix it, then resume it in
            Automations.
          </p>
        </div>
      </div>
    </div>
  );
}
