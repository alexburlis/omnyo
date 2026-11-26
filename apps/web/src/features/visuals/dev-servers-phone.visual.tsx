export const label =
  "Opening a dev server on the phone: in the Omnyo iPhone app, the chat header shows a server button with 2 servers. Tapping it opens the Dev servers sheet, and tapping Open on localhost:5174 shows the page inside the app, served from studio-mac through a private preview link on your Omnyo server.";

export function Visual() {
  return (
    <div className="fv fv-dev-servers-phone" aria-hidden="true">
      <div className="fv-dev-servers-phone-route">
        <p className="fv-dev-servers-phone-node">
          <b>studio-mac</b>
          <span>localhost:5174</span>
        </p>
        <i className="fv-dev-servers-phone-wire" />
        <p className="fv-dev-servers-phone-node">
          <b>Your Omnyo server</b>
          <span>private preview link</span>
        </p>
      </div>
      <i className="fv-dev-servers-phone-wire is-across" />
      <div className="fv-dev-servers-phone-device">
        <div className="fv-dev-servers-phone-screen">
          <header className="fv-dev-servers-phone-head">
            <svg viewBox="0 0 16 16">
              <path d="M10 3.5 5.5 8l4.5 4.5" />
            </svg>
            <b>Add CSV export</b>
            <span className="fv-dev-servers-phone-servers">
              <svg viewBox="0 0 16 16">
                <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" />
                <rect x="2.5" y="9" width="11" height="4.5" rx="1.2" />
              </svg>
              <i />2
            </span>
          </header>
          <div className="fv-dev-servers-phone-chat">
            <p>The invoices page now has an Export CSV button.</p>
            <p className="fv-dev-servers-phone-you">Let me see it</p>
          </div>
          <div className="fv-dev-servers-phone-sheet">
            <i className="fv-dev-servers-phone-grip" />
            <b>Dev servers</b>
            <p>
              <i className="fv-dot fv-dot--ok" />
              <span>
                localhost:5174
                <small>Running · studio-mac</small>
              </span>
              <em>Open</em>
            </p>
            <p>
              <i className="fv-dot fv-dot--ok" />
              <span>
                localhost:5175
                <small>Running · build-pc</small>
              </span>
              <em>Open</em>
            </p>
          </div>
          <div className="fv-dev-servers-phone-web">
            <header>
              <span>Done</span>
              <small>localhost:5174</small>
            </header>
            <div className="fv-dev-servers-phone-page">
              <b>Invoices</b>
              <span className="fv-dev-servers-phone-export">Export CSV</span>
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
