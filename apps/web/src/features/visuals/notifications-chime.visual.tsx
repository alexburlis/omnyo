import "./notifications-chime.css";

export const label =
  "Chime's Events settings with the Glass sound theme. As a chat completes, another waits for an answer and a third fails, each plays its sound, its sidebar row lights up and the matching event shows a short sound wave.";

const EVENTS = [
  { kind: "start", name: "Turn started", sound: "Glass rise" },
  { kind: "done", name: "Turn completed", sound: "Glass resolve" },
  { kind: "ask", name: "Waiting for an answer", sound: "Glass question" },
  { kind: "fail", name: "Turn failed", sound: "Glass warning" },
] as const;

const ROWS = [
  { kind: "done", title: "Date parser tests", dot: "ok" },
  { kind: "ask", title: "Weekday issue triage", dot: "attn" },
  { kind: "fail", title: "Fix invoice rounding", dot: "bad" },
  { kind: "idle", title: "Tidy note schema", dot: "dim" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-notifications-chime" aria-hidden="true">
      <aside className="fv-nc-side">
        <p className="fv-nc-label">Chats</p>
        {ROWS.map((row) => (
          <p key={row.title} className={`fv-nc-row is-${row.kind}`}>
            <i className={`fv-dot fv-dot--${row.dot}`} />
            <b>{row.title}</b>
          </p>
        ))}
      </aside>
      <section className="fv-nc-card">
        <h4>Events</h4>
        <p className="fv-nc-theme">
          <span>Sound theme</span>
          <span className="fv-nc-select">
            Glass <small>⌄</small>
          </span>
        </p>
        {EVENTS.map((event) => (
          <p key={event.kind} className={`fv-nc-event is-${event.kind}`}>
            <i className="fv-nc-box" />
            <span>{event.name}</span>
            <span className="fv-nc-sound">{event.sound}</span>
            <span className="fv-nc-wave">
              <i />
              <i />
              <i />
              <i />
            </span>
          </p>
        ))}
        <p className="fv-nc-vol">
          Volume
          <span className="fv-nc-track">
            <i />
            <b />
          </span>
        </p>
      </section>
    </div>
  );
}
