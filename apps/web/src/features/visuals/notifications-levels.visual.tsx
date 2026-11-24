import "./notifications-levels.css";

export const label =
  "A chat's menu opens to Notifications, with Default, All activity, Needs input only and Muted. Muted is chosen, and the muted bell appears on the parent chat and on both sub-chats below it.";

function BellOff() {
  return (
    <svg className="fv-nl-muted" viewBox="0 0 16 16">
      <path d="M4.5 11.5V7.2a3.5 3.5 0 0 1 6-2.4M11.5 7.5v4l1 1h-7M6.8 13.6a1.4 1.4 0 0 0 2.4 0M2.5 2.5l11 11" />
    </svg>
  );
}

function Check() {
  return (
    <svg className="fv-nl-check" viewBox="0 0 16 16">
      <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-notifications-levels" aria-hidden="true">
      <aside className="fv-nl-side">
        <p className="fv-nl-label">harbor-ledger</p>
        <p className="fv-nl-row is-parent">
          <i className="fv-dot fv-dot--ok" />
          <b>Add CSV export</b>
          <BellOff />
        </p>
        <p className="fv-nl-row is-child">
          <i className="fv-dot fv-dot--ok" />
          <b>Review: Add CSV export</b>
          <BellOff />
        </p>
        <p className="fv-nl-row is-child">
          <i className="fv-dot fv-dot--dim" />
          <b>Date parser tests</b>
          <BellOff />
        </p>
        <p className="fv-nl-row">
          <i className="fv-dot fv-dot--attn" />
          <b>Weekday issue triage</b>
          <span />
        </p>
        <p className="fv-nl-note">
          A parent&apos;s level caps every chat below it.
        </p>
      </aside>
      <div className="fv-nl-menu">
        <i className="fv-nl-hi" />
        <p>Rename</p>
        <p>Shelve</p>
        <p>
          Notifications <span>›</span>
        </p>
        <p className="is-dim">Archive</p>
      </div>
      <div className="fv-nl-sub">
        <i className="fv-nl-hi" />
        <p>Default</p>
        <p>All activity</p>
        <p>Needs input only</p>
        <p>Muted</p>
        <Check />
      </div>
    </div>
  );
}
