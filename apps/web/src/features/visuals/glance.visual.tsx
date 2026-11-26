export const label =
  "A chat's Glance card updating as the agent works: Toward moves from 3 of 4 date formats passing to all 4 passing, then the status turns from Working to Done with a green result.";

const STEPS = [
  {
    phase: "a",
    text: "Export passes on 3 of 4 date formats; European dates still fail",
  },
  {
    phase: "b",
    text: "All 4 date formats pass; running the invoice suite",
  },
  {
    phase: "c",
    text: "CSV export added; all 4 date formats pass",
  },
] as const;

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
    <div className="fv fv-glance" aria-hidden="true">
      <header className="fv-glance-bar">
        <span className="fv-glance-title">
          <b>Add CSV export</b>
          <small>harbor-ledger · feat/csv-export · Codex</small>
        </span>
        <span className="fv-glance-more">
          <svg viewBox="0 0 24 24">
            <path d="M5 12h.01M12 12h.01M19 12h.01" />
          </svg>
        </span>
        <span className="fv-glance-pill">
          <i />
          <span className="fv-glance-swap">
            {STEPS.map((step) => (
              <span key={step.phase} className={`is-${step.phase}`}>
                {step.text}
              </span>
            ))}
          </span>
        </span>
        <span className="fv-glance-branch">
          <svg viewBox="0 0 24 24">
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="8" r="2.5" />
            <path d="M6 8.5v7M18 10.5c0 4-6 3-11 6" />
          </svg>
          feat/csv-export
          <b>+64</b>
          <em>−12</em>
        </span>
      </header>
      <div className="fv-glance-chat">
        <p>
          Three of the four date formats export cleanly. European dates still
          fail, so I am fixing the parser next.
        </p>
        <p className="fv-glance-tools">
          Ran 1 command <em>1 failed</em> · 4.8s
        </p>
        <div className="fv-glance-composer">
          <span>Ask for a follow-up</span>
          <i />
        </div>
      </div>
      <section className="fv-glance-card">
        <span className="fv-glance-chips">
          <span className="fv-glance-chip is-ab">
            <i />
            Working
          </span>
          <span className="fv-glance-chip is-c">
            <Check />
            Done
          </span>
        </span>
        <dl>
          <dt>About</dt>
          <dd>Add CSV export</dd>
          <dt>Started</dt>
          <dd>Add a CSV export to invoices</dd>
          <dt className="fv-glance-swap">
            <span className="is-ab">Toward</span>
            <span className="is-c">Result</span>
          </dt>
          <dd className="fv-glance-swap fv-glance-now">
            {STEPS.map((step) =>
              step.phase === "c" ? (
                <span key={step.phase} className="is-c is-result">
                  <Check />
                  {step.text}
                </span>
              ) : (
                <span key={step.phase} className={`is-${step.phase}`}>
                  {step.text}
                </span>
              ),
            )}
          </dd>
        </dl>
      </section>
    </div>
  );
}
