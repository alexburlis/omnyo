export const label =
  "The Omnyo Inbox: chats from every project sorted into Needs you, Ready to archive, Running and Waiting, with a question to answer and a finished chat to archive.";

export function Visual() {
  return (
    <div className="fv fv-inbox fv-fade" aria-hidden="true">
      <nav className="fv-inbox-rail">
        <span className="fv-inbox-tile is-on">
          <svg viewBox="0 0 24 24">
            <path d="M4 11.5 12 5l8 6.5V19H4zM4 14h4.5l1.5 2h4l1.5-2H20" />
          </svg>
          <b>1</b>
        </span>
        <span className="fv-inbox-tile">H</span>
        <span className="fv-inbox-tile">A</span>
      </nav>
      <div className="fv-inbox-list">
        <header className="fv-inbox-head">
          <h3>Inbox</h3>
          <span className="fv-pill fv-dim">All projects</span>
        </header>
        <h4 className="fv-inbox-sec">
          Needs you <span>1</span>
        </h4>
        <div className="fv-inbox-card is-ask">
          <i className="fv-inbox-mark is-h">H</i>
          <b>Review: Add CSV export</b>
          <span className="fv-dim">2m</span>
          <p>Which date format should the export use?</p>
          <div className="fv-inbox-answers">
            <span>
              <kbd className="fv-key">1</kbd>ISO 8601
            </span>
            <span>
              <kbd className="fv-key">2</kbd>Keep locale
            </span>
          </div>
        </div>
        <h4 className="fv-inbox-sec">
          Ready to archive <span>1</span>
        </h4>
        <div className="fv-inbox-card">
          <svg className="fv-inbox-check" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="m8 12.3 2.7 2.7L16 9.6" />
          </svg>
          <b>Add CSV export</b>
          <span className="fv-inbox-archive">Archive</span>
        </div>
        <h4 className="fv-inbox-sec">
          Running <span>1</span>
          <i className="fv-inbox-spin" />
        </h4>
        <div className="fv-inbox-card is-run">
          <i className="fv-inbox-mark is-a">A</i>
          <b>Date parser tests</b>
          <span className="fv-dim">8m</span>
          <p className="fv-dim">Running the European date cases</p>
          <i className="fv-inbox-bar" />
        </div>
        <h4 className="fv-inbox-sec">
          Waiting <span>1</span>
        </h4>
        <div className="fv-inbox-card">
          <i className="fv-inbox-mark is-a is-wait">A</i>
          <b>Weekday issue triage</b>
          <span className="fv-dim">back 09:00</span>
        </div>
      </div>
    </div>
  );
}
