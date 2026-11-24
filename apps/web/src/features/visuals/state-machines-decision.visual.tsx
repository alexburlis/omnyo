import "./state-machines-decision.css";

export const label =
  "A State Machines decision waiting under Needs you: Merge the date parser fix? You choose Ask for changes, which leads back to Fix the failing check, type the required reason and press Confirm.";

const DECISIONS = [
  { label: "Merge it", then: "then Wait for a commit" },
  { label: "Ask for changes", then: "then Fix the failing check" },
  { label: "Stop here", then: "then Done" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-state-machines-decision" aria-hidden="true">
      <p className="fv-state-machines-decision-section">
        Needs you <span>1</span>
      </p>
      <article className="fv-panel fv-state-machines-decision-card">
        <header>
          <span className="fv-state-machines-decision-pill">Needs you</span>
          <span className="fv-state-machines-decision-link">
            Local check loop · Review the fix
          </span>
        </header>
        <h3>Merge the date parser fix?</h3>
        <p className="fv-state-machines-decision-body">
          The fixer opened PR #42 on feat/csv-export. All checks pass.
        </p>
        <ul className="fv-state-machines-decision-options">
          {DECISIONS.map((decision, index) => (
            <li
              key={decision.label}
              className={index === 1 ? "is-picked" : undefined}
            >
              <i className="fv-state-machines-decision-radio" />
              <b>{decision.label}</b>
              <span>{decision.then}</span>
            </li>
          ))}
        </ul>
        <p className="fv-state-machines-decision-hint">Reason (required)</p>
        <footer>
          <span className="fv-state-machines-decision-input">
            <span className="fv-state-machines-decision-typed">
              Keep 31.12.2026 dates for de-DE invoices
            </span>
            <i className="fv-state-machines-decision-cover" />
          </span>
          <span className="fv-state-machines-decision-confirm">Confirm</span>
        </footer>
      </article>
      <p className="fv-state-machines-decision-done">
        <svg viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="6.2" />
          <path d="m5.4 8.2 1.8 1.8 3.5-3.7" />
        </svg>
        Answer recorded. Fix the failing check starts attempt 1.
      </p>
    </div>
  );
}
