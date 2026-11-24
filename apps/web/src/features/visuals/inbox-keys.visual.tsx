import "./inbox-keys.css";

export const label =
  "Inbox triage from the keyboard: E archives the focused finished chat and an Undo toast appears, then W opens the wait menu and Tomorrow 09:00 moves the next chat to Waiting.";

const FINISHED = [
  {
    title: "Fix invoice rounding",
    sub: "Rounding now matches the ledger",
    mark: "H",
    age: "12m",
  },
  {
    title: "Tidy note schema",
    sub: "Needs a look after the review",
    mark: "A",
    age: "40m",
  },
  {
    title: "Add CSV export",
    sub: "Export added; all 4 date formats pass",
    mark: "H",
    age: "1h",
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-inbox-keys" aria-hidden="true">
      <header className="fv-ik-head">
        <b>Inbox</b>
        <span className="fv-pill fv-dim">All projects</span>
      </header>
      <p className="fv-ik-sec is-need">
        Needs you <span>1</span>
      </p>
      <div className="fv-ik-row is-need">
        <i className="fv-ik-mark">H</i>
        <span>
          <b>Review: Add CSV export</b>
          <small>Which date format should the export use?</small>
        </span>
        <em>2m</em>
      </div>
      <p className="fv-ik-sec is-done">
        Finished
        <span className="fv-ik-count">
          <span className="is-c3">3</span>
          <span className="is-c2">2</span>
          <span className="is-c1">1</span>
        </span>
      </p>
      <div className="fv-ik-focus" />
      {FINISHED.map((row, index) => (
        <div key={row.title} className={`fv-ik-row is-r${index + 1}`}>
          <i className={`fv-ik-mark${row.mark === "A" ? " is-a" : ""}`}>
            {row.mark}
          </i>
          <span>
            <b>{row.title}</b>
            <small>{row.sub}</small>
          </span>
          <em>{row.age}</em>
        </div>
      ))}
      <div className="fv-ik-menu fv-panel">
        <p className="is-on">
          <span>Tomorrow 09:00</span>
          <kbd className="fv-key">1</kbd>
        </p>
        <p>
          <span>Monday 09:00</span>
          <kbd className="fv-key">2</kbd>
        </p>
        <p>
          <span>When something happens…</span>
          <kbd className="fv-key">3</kbd>
        </p>
      </div>
      <aside className="fv-ik-keys">
        <p className="is-e">
          <kbd>E</kbd>
          <span>Archive</span>
        </p>
        <p className="is-w">
          <kbd>W</kbd>
          <span>Wait</span>
        </p>
        <ul className="fv-dim">
          <li>
            <kbd className="fv-key">J</kbd>
            <kbd className="fv-key">K</kbd> move
          </li>
          <li>
            <kbd className="fv-key">R</kbd> reply
          </li>
          <li>
            <kbd className="fv-key">S</kbd> shelf
          </li>
          <li>
            <kbd className="fv-key">Z</kbd> undo
          </li>
        </ul>
      </aside>
      <div className="fv-ik-toast">
        <p className="is-t1">
          <b>Archived</b>
          <span>Fix invoice rounding</span>
          <em>Undo</em>
        </p>
        <p className="is-t2">
          <b>Waits until Tomorrow 09:00</b>
          <em>Undo</em>
        </p>
      </div>
    </div>
  );
}
