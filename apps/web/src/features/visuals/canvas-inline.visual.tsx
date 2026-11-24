import "./canvas-inline.css";

export const label =
  "An agent's reply in an Omnyo chat built from native blocks: a bold answer, a status table of checks, a row of metrics, a progress bar for the release checklist and a file card for the sample export, each appearing as the reply streams in.";

const CHECKS = [
  { name: "Unit tests", value: "48 passed", tone: "ok" },
  { name: "de-DE dates", value: "Fixed", tone: "ok" },
  { name: "Large exports", value: "Slow above 50k rows", tone: "attn" },
] as const;

const METRICS = [
  { value: "6", label: "files changed" },
  { value: "+214 −38", label: "lines" },
  { value: "4m 12s", label: "test run" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-canvas-inline" aria-hidden="true">
      <p className="fv-canvas-inline-you">Is CSV export ready?</p>
      <div className="fv-canvas-inline-reply">
        <p className="fv-canvas-inline-answer">
          <b>Yes, CSV export is ready for review.</b> One known limit below.
        </p>
        <table className="fv-canvas-inline-table">
          <tbody>
            {CHECKS.map((check) => (
              <tr key={check.name}>
                <td>{check.name}</td>
                <td className={`is-${check.tone}`}>{check.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="fv-canvas-inline-metrics">
          {METRICS.map((metric) => (
            <li key={metric.label}>
              <b>{metric.value}</b>
              <span>{metric.label}</span>
            </li>
          ))}
        </ul>
        <div className="fv-canvas-inline-progress">
          <span>Release checklist</span>
          <i>
            <i />
          </i>
          <b>5 of 6</b>
        </div>
        <p className="fv-canvas-inline-file">
          <svg viewBox="0 0 16 16">
            <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
            <path d="M9 1.8V5.3h3.5M6 8.5h4.5M6 11h4.5" />
          </svg>
          <span>
            <b>export-sample.csv</b>
            <span>harbor-ledger · 12 KB</span>
          </span>
        </p>
      </div>
    </div>
  );
}
