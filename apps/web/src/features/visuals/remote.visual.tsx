import "./remote.css";

export const label =
  "A phone showing the Omnyo Inbox with an open question and two answer buttons, reached from the Omnyo server on studio-mac through Omnyo connect.";

export function Visual() {
  return (
    <div className="fv fv-remote fv-fade" aria-hidden="true">
      <svg
        className="fv-remote-links"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <path d="M 19 38 L 19 62" />
        <path className="is-live" d="M 26 70 L 44 70" />
      </svg>
      <div className="fv-remote-server fv-panel">
        <p className="fv-remote-host">
          <i className="fv-dot fv-dot--ok" />
          studio-mac
        </p>
        <p className="fv-dim">Omnyo server</p>
      </div>
      <p className="fv-remote-connect fv-pill">
        <i className="fv-remote-globe" />
        Omnyo connect
      </p>
      <div className="fv-remote-phone">
        <i className="fv-remote-notch" />
        <p className="fv-remote-title">Inbox</p>
        <p className="fv-eyebrow">Needs you</p>
        <div className="fv-remote-ask fv-panel">
          <p className="fv-remote-chat">
            <i className="fv-dot fv-dot--attn" />
            Date parser tests
          </p>
          <p className="fv-remote-question">
            Which date format should the export use?
          </p>
          <p className="fv-remote-answers">
            <span className="is-primary">dd.mm.yyyy</span>
            <span>yyyy-mm-dd</span>
          </p>
        </div>
        <p className="fv-eyebrow">Running</p>
        <p className="fv-remote-row">
          <i className="fv-dot fv-dot--ok" />
          Add CSV export
        </p>
        <p className="fv-eyebrow">Finished</p>
        <p className="fv-remote-row">
          <i className="fv-dot fv-dot--dim" />
          Review: Add CSV export
        </p>
        <p className="fv-remote-row">
          <i className="fv-dot fv-dot--dim" />
          Weekday issue triage
        </p>
      </div>
    </div>
  );
}
