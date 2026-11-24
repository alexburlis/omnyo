import "./glance-details.css";

export const label =
  "A finished chat's Glance card with Details opened: three pieces of evidence marked Reproduced, Inspected and Hypothesis. The reproduced claim expands to the linked test command, its exit code and output.";

export function Visual() {
  return (
    <div className="fv fv-glance-details" aria-hidden="true">
      <section className="fv-gd-card">
        <p className="fv-gd-head">
          <b>Add CSV export</b>
          <span className="fv-gd-done">
            <i />
            Done
          </span>
        </p>
        <p className="fv-gd-result">
          CSV export added; all 4 date formats pass
        </p>
        <p className="fv-gd-toggle">
          <svg viewBox="0 0 10 10">
            <path d="M3.8 2.5 6.3 5 3.8 7.5" />
          </svg>
          <b>Details</b>
          <span>Facts 2 · Files 2 · Evidence 3</span>
        </p>
        <div className="fv-gd-reveal fv-gd-proof">
          <p className="fv-gd-eyebrow">Evidence</p>
          <div className="fv-gd-row is-rep">
            <em>Reproduced</em> All 4 date formats export correctly
            <div className="fv-gd-open">
              <small>Event 214 · completed · Exit 0</small>
              <pre>
                {"$ pnpm test export\n"}
                <b>✓</b>
                {" 12 passed (export.test.ts)"}
              </pre>
            </div>
          </div>
          <div className="fv-gd-row">
            <em>Inspected</em> Header order matches COLUMNS
          </div>
          <div className="fv-gd-row is-hyp">
            <em>Hypothesis</em> Large exports may need streaming
          </div>
        </div>
      </section>
    </div>
  );
}
