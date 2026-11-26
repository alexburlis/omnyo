export const label =
  "An automation's page in Omnyo: Weekday issue triage runs at 09:00 AM, Monday through Friday, with its prompt above a Runs list where today's run appears, runs and succeeds, and the next run moves to Monday.";

const RUNS = [
  { when: "Nov 19, 9:00 AM", took: "96s" },
  { when: "Nov 18, 9:00 AM", took: "112s" },
  { when: "Nov 17, 9:00 AM", took: "88s" },
] as const;

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="is-ok">
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.4 8.2 1.8 1.8 3.5-3.7" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-automations-detail" aria-hidden="true">
      <header className="fv-automations-detail-head">
        <svg viewBox="0 0 16 16" className="fv-automations-detail-glyph">
          <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
          <path d="M2.5 6.8h11M5.5 2v3M10.5 2v3" />
        </svg>
        <h3>Weekday issue triage</h3>
        <i className="fv-automations-detail-toggle" />
      </header>
      <p className="fv-automations-detail-meta">
        <span>atlas-notes</span>
        <span>At 09:00 AM, Monday through Friday</span>
        <span className="fv-automations-detail-next">
          Next{" "}
          <span className="fv-automations-detail-swap">
            <span className="is-before">Nov 20, 9:00 AM</span>
            <span className="is-after">Nov 23, 9:00 AM</span>
          </span>
        </span>
      </p>
      <p className="fv-eyebrow">Prompt</p>
      <p className="fv-panel fv-automations-detail-prompt">
        Triage new issues in atlas-notes: label each one, close duplicates and
        open a fixer chat for every real bug.
      </p>
      <p className="fv-eyebrow">Runs</p>
      <ul className="fv-automations-detail-runs">
        <li className="is-new">
          <span className="fv-automations-detail-icon">
            <svg viewBox="0 0 16 16" className="is-spin">
              <path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8" />
            </svg>
            <Check />
          </span>
          <b>Nov 20, 9:00 AM</b>
          <span className="fv-automations-detail-swap">
            <span className="is-before">Running…</span>
            <span className="is-after">104s</span>
          </span>
        </li>
        {RUNS.map((run) => (
          <li key={run.when}>
            <span className="fv-automations-detail-icon">
              <Check />
            </span>
            <b>{run.when}</b>
            <span>{run.took}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
