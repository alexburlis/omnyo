import "./sentry.css";

export const label =
  "The Sentry inbox in Omnyo: three error issues with event counts, one with a reviewed fix ready and two with a Solve button.";

const STEPS = ["Root cause", "Reproduced", "Fixed", "Reviewed"] as const;

const ISSUES = [
  {
    title: "TypeError: row.amount is undefined",
    place: "atlas-notes · notes/sync.ts",
    events: "9 events",
  },
  {
    title: "Error: Weekday out of range",
    place: "harbor-ledger · dates/week.ts",
    events: "3 events",
  },
  {
    title: "Error: Unknown currency code",
    place: "harbor-ledger · csv/money.ts",
    events: "2 events",
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-sentry fv-fade" aria-hidden="true">
      <div className="fv-sentry-head">
        <b>Sentry</b>
        <span className="fv-sentry-tabs">
          <span className="is-on">Inbox</span>
          <span>Investigations</span>
          <span>Projects</span>
        </span>
      </div>
      <div className="fv-sentry-focus fv-panel">
        <div className="fv-sentry-row">
          <i className="fv-dot fv-dot--bad" />
          <span className="fv-sentry-title fv-mono">
            RangeError: Invalid time value
          </span>
          <span className="fv-sentry-count">24 events</span>
        </div>
        <div className="fv-sentry-place fv-dim">
          harbor-ledger · csv/export.ts
        </div>
        <div className="fv-sentry-status">
          <span className="fv-pill fv-sentry-ready">
            <i className="fv-dot fv-dot--ok" />
            Fix ready · reviewed
          </span>
          <span className="fv-pill fv-dim">Local commit</span>
        </div>
        <ol className="fv-sentry-steps">
          {STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
      <ul className="fv-sentry-list">
        {ISSUES.map((issue) => (
          <li key={issue.title} className="fv-panel">
            <i className="fv-dot fv-dot--bad" />
            <span className="fv-sentry-issue">
              <span className="fv-mono">{issue.title}</span>
              <span className="fv-dim">{issue.place}</span>
            </span>
            <span className="fv-sentry-count">{issue.events}</span>
            <span className="fv-sentry-button">Solve</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
