export const label =
  "Restarting a dev server from an Omnyo chat: above the composer, localhost:5174/invoices is Stopped on studio-mac. You press Restart, it shows Starting…, then Running with an Open button, and a Started localhost:5174/invoices step appears in the chat.";

export function Visual() {
  return (
    <div className="fv fv-dev-servers-restart" aria-hidden="true">
      <div className="fv-dev-servers-restart-log">
        <p className="fv-dev-servers-restart-agent">
          Added an Export CSV button to the invoices table. Open it from the
          invoices dev server.
        </p>
        <p className="fv-dev-servers-restart-you">
          The invoices page is down again
        </p>
        <p className="fv-dev-servers-restart-step">
          <i className="fv-dot fv-dot--ok" />
          <span>
            Started <u>localhost:5174/invoices</u>
          </span>
          <span className="fv-dim">Running · studio-mac</span>
          <b>Open</b>
        </p>
      </div>
      <div className="fv-dev-servers-restart-shelf">
        <ul>
          <li className="is-target">
            <span className="fv-dev-servers-restart-dots">
              <i className="is-stopped" />
              <i className="is-starting" />
              <i className="is-online" />
            </span>
            <b>localhost:5174/invoices</b>
            <span className="fv-dev-servers-restart-swap">
              <span className="is-stopped">Stopped · studio-mac</span>
              <span className="is-starting">Starting… · studio-mac</span>
              <span className="is-online">Running · studio-mac</span>
            </span>
            <span className="fv-dev-servers-restart-swap is-action">
              <span className="is-stopped">Restart</span>
              <span className="is-starting">Starting…</span>
              <span className="is-online">Open</span>
            </span>
          </li>
          <li>
            <span className="fv-dev-servers-restart-dots">
              <i className="is-online" />
            </span>
            <b>localhost:5175/reports</b>
            <span className="fv-dim">Running · build-pc</span>
            <span className="fv-dev-servers-restart-open">Open</span>
          </li>
        </ul>
      </div>
      <div className="fv-dev-servers-restart-composer">
        <span className="fv-dim">Ask for follow-up changes</span>
        <i />
      </div>
      <svg viewBox="0 0 16 16" className="fv-dev-servers-restart-cursor">
        <path d="M3 2v11l3-2.6 2 4.4 2-1-2-4.2h4z" />
      </svg>
    </div>
  );
}
