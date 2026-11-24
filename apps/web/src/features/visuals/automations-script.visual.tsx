import "./automations-script.css";

export const label =
  "A script automation in Omnyo: a three-line shell script checks harbor-ledger for outdated packages every Monday. Quiet weeks are recorded as Skipped with empty output, and when a run finds outdated packages its output is kept in the Runs list.";

const QUIET = [
  { when: "Nov 9, 8:00 AM", took: "1.9s" },
  { when: "Nov 2, 8:00 AM", took: "2.1s" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-automations-script" aria-hidden="true">
      <header className="fv-automations-script-head">
        <svg viewBox="0 0 16 16" className="fv-automations-script-glyph">
          <rect x="2" y="3" width="12" height="10" rx="2" />
          <path d="m5 6.5 1.8 1.5L5 9.5M8.5 10h2.5" />
        </svg>
        <h3>Dependency check</h3>
        <span className="fv-automations-script-meta">
          At 08:00 AM, only on Monday
        </span>
      </header>
      <pre className="fv-automations-script-code">
        <span className="fv-automations-script-dim">#!/bin/sh</span>
        {"\n"}cd harbor-ledger{"\n"}pnpm outdated || true
      </pre>
      <p className="fv-eyebrow">Runs</p>
      <ul className="fv-automations-script-runs">
        <li className="is-new">
          <span className="fv-automations-script-row">
            <span className="fv-automations-script-icon">
              <svg viewBox="0 0 16 16" className="is-spin">
                <path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8" />
              </svg>
              <svg viewBox="0 0 16 16" className="is-ok">
                <circle cx="8" cy="8" r="6.2" />
                <path d="m5.4 8.2 1.8 1.8 3.5-3.7" />
              </svg>
            </span>
            <b>Nov 16, 8:00 AM</b>
            <span className="fv-automations-script-swap">
              <span className="is-before">Running…</span>
              <span className="is-after">2.6s</span>
            </span>
          </span>
          <pre className="fv-automations-script-out">
            date-fns 4.1.0 → 4.2.0{"\n"}vitest 4.1.9 → 4.1.11
          </pre>
        </li>
        {QUIET.map((run) => (
          <li key={run.when}>
            <span className="fv-automations-script-row">
              <span className="fv-automations-script-icon is-skip">
                <svg viewBox="0 0 16 16">
                  <path d="M3 4.5v3.2a2.3 2.3 0 0 0 2.3 2.3H13m-3-3 3 3-3 3" />
                </svg>
              </span>
              <b>{run.when}</b>
              <span>{run.took} · empty output</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
