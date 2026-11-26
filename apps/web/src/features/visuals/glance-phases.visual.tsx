export const label =
  "A chat's Glance card above the composer: the phase strip moves from Build to Test to Ship while the Now and Next rows update, then the status turns from Working to Done and Next offers Ready to archive.";

const NOW = [
  "Writing the export in export.ts",
  "Invoice suite running; 3 of 4 date formats pass",
  "All tests pass; opening the pull request",
  "CSV export added; all 4 date formats pass",
] as const;

const NEXT = [
  "Run the invoice suite",
  "Fix European dates in parseDate",
  "Wait for the review",
] as const;

export function Visual() {
  return (
    <div className="fv fv-glance-phases" aria-hidden="true">
      <div className="fv-gp-chat">
        <p className="is-you">Add a CSV export to the invoices page.</p>
        <p className="is-say">
          On it. I will add the button, write the export and run the invoice
          suite.
        </p>
        <p>Edited src/export.ts, src/invoices/Toolbar.tsx</p>
      </div>
      <section className="fv-gp-card">
        <div className="fv-gp-top">
          <span className="fv-gp-title">Glance</span>
          <span className="fv-gp-chip">
            <span className="is-work">
              <i />
              Working
            </span>
            <span className="is-done">
              <i />
              Done
            </span>
          </span>
          <span className="fv-gp-lane">
            <span className="fv-gp-bars">
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="fv-gp-names">
              <span className="is-1">Build</span>
              <span className="is-2">Test</span>
              <span className="is-3 is-ship">Ship</span>
            </span>
          </span>
        </div>
        <dl>
          <dt>Goal</dt>
          <dd>
            <span className="is-static">Add a CSV export to invoices</span>
          </dd>
          <dt>Now</dt>
          <dd>
            {NOW.map((text, index) => (
              <span key={text} className={`is-${index + 1}`}>
                {text}
              </span>
            ))}
          </dd>
          <dt>Next</dt>
          <dd>
            {NEXT.map((text, index) => (
              <span key={text} className={`is-${index + 1}`}>
                {text}
              </span>
            ))}
            <span className="is-4 is-ready">Ready to archive</span>
          </dd>
        </dl>
      </section>
    </div>
  );
}
