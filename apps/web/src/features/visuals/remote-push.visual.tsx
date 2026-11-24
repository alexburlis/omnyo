import "./remote-push.css";

export const label =
  "Phone notifications that wait until you step away: while you are active at studio-mac, the phone stays quiet. Once you leave the desk, the iPhone lock screen shows an Omnyo push asking which date format the CSV export should use, then a second one saying Date parser tests hit an error. Each chat is set to All activity, Needs input only or Muted.";

export function Visual() {
  return (
    <div className="fv fv-remote-push" aria-hidden="true">
      <div className="fv-remote-push-desk">
        <p className="fv-remote-push-mac">
          <svg viewBox="0 0 24 16">
            <rect x="3" y="1.5" width="18" height="11" rx="1.5" />
            <path d="M1 14.5h22" />
          </svg>
          <b>studio-mac</b>
        </p>
        <p className="fv-remote-push-state">
          <span className="is-before">
            <i className="fv-dot fv-dot--ok" />
            You're active here · phone pushes wait
          </span>
          <span className="is-after">
            <i className="fv-dot fv-dot--dim" />
            Away · pushes go to your phone
          </span>
        </p>
        <ul className="fv-remote-push-prefs">
          <li>
            <span>Add CSV export</span>
            <b>All activity</b>
          </li>
          <li>
            <span>Date parser tests</span>
            <b>Needs input only</b>
          </li>
          <li>
            <span>Weekday issue triage</span>
            <b>Muted</b>
          </li>
        </ul>
      </div>
      <div className="fv-remote-push-phone">
        <div className="fv-remote-push-screen">
          <p className="fv-remote-push-date">Friday, November 20</p>
          <p className="fv-remote-push-time">9:41</p>
          <div className="fv-remote-push-stack">
            <div className="fv-remote-push-note is-second">
              <i>O</i>
              <span>
                <b>Date parser tests</b>
                <small>now</small>
              </span>
              <p>The thread hit an error</p>
            </div>
            <div className="fv-remote-push-note is-first">
              <i>O</i>
              <span>
                <b>Add CSV export</b>
                <small>now</small>
              </span>
              <p>Which date format should the export use?</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
