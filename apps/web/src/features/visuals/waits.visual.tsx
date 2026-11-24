import "./waits.css";

export const label =
  "A chat with the goal All date parser tests pass waiting for another chat, Review: Add CSV export. When that review finishes the wait ends, the tests run again and the goal check moves from 3 of 12 to 4 of 12.";

function Check() {
  return (
    <svg viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.6" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-waits" aria-hidden="true">
      <header className="fv-waits-bar">
        <span className="fv-waits-title">
          <b>Date parser tests</b>
          <small>harbor-ledger · fix/date-parser · Codex</small>
        </span>
        <span className="fv-waits-goal">
          <svg className="fv-waits-compass" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" />
          </svg>
          <b>
            Goal{" "}
            <span className="fv-waits-count">
              <span className="is-a">3</span>
              <span className="is-b">4</span>
            </span>
            /12
          </b>
          <span className="fv-waits-objective">All date parser tests pass</span>
        </span>
      </header>
      <div className="fv-waits-main">
        <div className="fv-waits-thread">
          <p className="fv-waits-user">Make the date parser tests pass.</p>
          <p className="fv-waits-say">
            7 of 9 tests pass. The last two depend on the CSV export change, so
            I will rerun them once that review finishes.
          </p>
          <div className="fv-waits-swap fv-waits-tools">
            <p className="is-a">
              Ran pnpm test date-parser <em>2 failed</em> · 6.1s
            </p>
            <p className="is-run">Running pnpm test date-parser</p>
            <p className="is-b">
              Ran pnpm test date-parser <em>1 failed</em> · 5.4s
            </p>
          </div>
          <div className="fv-waits-swap fv-waits-state">
            <div className="fv-waits-reason is-a">
              <p>
                <b>Waiting for</b> <u>Review: Add CSV export</u>
                <span> · the export lands first</span>
              </p>
              <span className="fv-waits-cancel">Cancel wait</span>
            </div>
            <p className="fv-waits-ended is-b">
              <Check />
              <span>
                <u>Review: Add CSV export</u> finished
              </span>
            </p>
          </div>
          <div className="fv-waits-composer">
            <span>Ask for a follow-up</span>
            <span className="fv-waits-tools-row">
              <svg viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <svg className="is-right" viewBox="0 0 24 24">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
              </svg>
              <i>
                <svg viewBox="0 0 24 24">
                  <path d="M12 19V5M6 11l6-6 6 6" />
                </svg>
              </i>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
