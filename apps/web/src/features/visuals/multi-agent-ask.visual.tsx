export const label =
  "A child review chat asks whether the export should include archived invoices. The question goes to its parent chat instead of you, the parent answers with omnyo thread tell, and the child carries on.";

export function Visual() {
  return (
    <div className="fv fv-multi-agent-ask" aria-hidden="true">
      <section className="fv-ma-pane is-child">
        <header className="fv-ma-head">
          <b>Review: Add CSV export</b>
          <small>Child · Codex</small>
        </header>
        <div className="fv-ma-body">
          <p>Reviewing export.ts and the invoice query.</p>
          <div className="fv-ma-ask">
            <small>Asks its parent</small>
            Include archived invoices in the export?
          </div>
          <p className="fv-ma-ok">Got it: active invoices only. Continuing.</p>
        </div>
      </section>
      <section className="fv-ma-pane is-parent">
        <header className="fv-ma-head">
          <b>Add CSV export</b>
          <small>Parent · Claude Code</small>
        </header>
        <div className="fv-ma-body">
          <p>Waiting for the review.</p>
          <div className="fv-ma-in">
            <small>From Review: Add CSV export</small>
            Include archived invoices in the export?
          </div>
          <p className="fv-ma-cmd">
            <b>$</b> omnyo thread tell … &quot;Active only&quot;
          </p>
        </div>
      </section>
      <span className="fv-ma-fly is-q">Question</span>
      <span className="fv-ma-fly is-a">Answer</span>
      <p className="fv-ma-you">
        <svg viewBox="0 0 16 16">
          <path d="M4.5 11.5V7.2a3.5 3.5 0 0 1 7 0v4.3l1 1h-9zM6.8 13.6a1.4 1.4 0 0 0 2.4 0" />
        </svg>
        Your Inbox
        <b>Nothing needs you</b>
      </p>
    </div>
  );
}
