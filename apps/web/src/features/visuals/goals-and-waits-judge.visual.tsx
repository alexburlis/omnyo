import "./goals-and-waits-judge.css";

export const label =
  "A chat working toward the goal All date parser tests pass. After its turn a separate judge inspects the workspace read-only and answers UNMET with what is missing, the chat gets a continuation and the count moves from 3 to 4 of 12, and the next check answers MET.";

function Compass() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-goals-and-waits-judge" aria-hidden="true">
      <section className="fv-gj-chat">
        <header className="fv-gj-bar">
          <b>Date parser tests</b>
          <span className="fv-gj-pill">
            <span className="is-3">
              <Compass />
              Goal 3/12
            </span>
            <span className="is-4">
              <Compass />
              Goal 4/12
            </span>
            <span className="is-met">
              <Compass />
              Goal met
            </span>
          </span>
        </header>
        <div className="fv-gj-thread">
          <p className="fv-gj-say fv-gj-reveal is-r1">
            Fixed parseDate for dd.mm.yyyy. 7 of 9 tests pass.
          </p>
          <div className="fv-gj-nudge fv-gj-reveal is-r2">
            <small>Goal not met yet</small>
            dd/mm/yy and d.m.yyyy still fail.
          </div>
          <p className="fv-gj-say fv-gj-reveal is-r3">
            Handled two-digit years and single-digit days.
          </p>
          <p className="fv-gj-end fv-gj-reveal is-r4">
            Ran pnpm test date-parser · 9 passed
          </p>
        </div>
      </section>
      <aside className="fv-gj-judge">
        <h4>
          Judge
          <small>Separate chat · read-only</small>
        </h4>
        <div className="fv-gj-check is-c1">
          <small>Check 4 of 12</small>
          <span className="fv-gj-verdict">
            <span className="is-spin">
              <i />
              Inspecting…
            </span>
            <span className="is-unmet">UNMET: 2 formats fail</span>
          </span>
        </div>
        <div className="fv-gj-check is-c2">
          <small>Check 5 of 12</small>
          <span className="fv-gj-verdict">
            <span className="is-spin">
              <i />
              Inspecting…
            </span>
            <span className="is-met">MET</span>
          </span>
        </div>
        <p className="fv-gj-budget">
          Budget: 12 checks. At the cap the chat reports where it got to.
        </p>
      </aside>
    </div>
  );
}
