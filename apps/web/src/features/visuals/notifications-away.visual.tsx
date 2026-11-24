import "./notifications-away.css";

export const label =
  "While the desktop app sees you at your computer, the phone holds its pushes. When the screen locks, the unanswered question reaches the phone, and the finished chat you already read is dropped.";

export function Visual() {
  return (
    <div className="fv fv-notifications-away" aria-hidden="true">
      <section className="fv-na-desk">
        <p className="fv-na-status">
          <span className="fv-na-swap">
            <span className="is-active">
              <i className="fv-dot fv-dot--ok" />
              At your computer
            </span>
            <span className="is-away">
              <i className="fv-dot fv-dot--attn" />
              Away · screen locked
            </span>
          </span>
          <small>Desktop app</small>
        </p>
        <div className="fv-na-rows">
          <p className="fv-na-row">
            <i className="fv-dot fv-dot--ok" />
            <b>Date parser tests</b>
            <small>Running</small>
          </p>
          <p className="fv-na-row is-new">
            <i className="fv-dot fv-dot--dim" />
            <b>Add CSV export</b>
            <small>Finished · read</small>
          </p>
          <p className="fv-na-row is-new">
            <i className="fv-dot fv-dot--attn" />
            <b>Weekday issue triage</b>
            <small>Needs you</small>
          </p>
        </div>
        <div className="fv-na-lock">
          <svg viewBox="0 0 24 24">
            <rect x="5" y="10.5" width="14" height="10" rx="2" />
            <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
          </svg>
          Screen locked
        </div>
      </section>
      <section className="fv-na-phone">
        <p className="fv-na-time">09:41</p>
        <p className="fv-na-held is-hold">
          2 pushes held while you are at your computer
        </p>
        <p className="fv-na-held is-drop">
          Add CSV export: read on desktop, not sent
        </p>
        <div className="fv-na-push">
          <small>
            <span>OMNYO</span>
            <span>now</span>
          </small>
          <b>Weekday issue triage</b>
          Close the two duplicate issues?
        </div>
      </section>
    </div>
  );
}
