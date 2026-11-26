export const label =
  "Shift+E in the Inbox opens Archive 3 chats, listing the finished chats with their results. Archive clears them in one go, an Undo toast appears, and the folded Shelf keeps its two parked chats.";

const READY = [
  { title: "Fix invoice rounding", why: "Rounding matches the ledger" },
  { title: "Add CSV export", why: "Export added; all 4 date formats pass" },
  { title: "Tidy note schema", why: "Schema checks pass" },
] as const;

function Check() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.7 2.7L16 9.6" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-inbox-shelf" aria-hidden="true">
      <header className="fv-is-head">
        <b>Inbox</b>
        <span className="fv-is-hint fv-dim">
          <kbd className="fv-key">⇧</kbd>
          <kbd className="fv-key">E</kbd>
          archive done
        </span>
      </header>
      <section className="fv-is-bulk fv-panel">
        <p className="fv-is-bulk-title">Archive 3 chats</p>
        <ul>
          {READY.map((row) => (
            <li key={row.title}>
              <b>{row.title}</b>
              <span> · {row.why}</span>
            </li>
          ))}
        </ul>
        <p className="fv-is-actions">
          <span className="is-main">Archive</span>
          <span className="fv-dim">
            Cancel <kbd className="fv-key">Esc</kbd>
          </span>
        </p>
      </section>
      <div className="fv-is-list">
        <div className="fv-is-ready">
          <p className="fv-is-sec">
            Ready to archive <span>3</span>
          </p>
          {READY.map((row, index) => (
            <div key={row.title} className={`fv-is-row is-r${index + 1}`}>
              <Check />
              <b>{row.title}</b>
              <span className="fv-is-archive">Archive</span>
            </div>
          ))}
        </div>
        <div className="fv-is-rest">
          <p className="fv-is-sec">
            Running <span>1</span>
          </p>
          <div className="fv-is-row is-run">
            <i className="fv-dot fv-dot--ok" />
            <b>Date parser tests</b>
            <span className="fv-dim">8m</span>
          </div>
          <p className="fv-is-sec is-shelf">
            <svg viewBox="0 0 10 10">
              <path d="M3.5 2.5 6 5 3.5 7.5" />
            </svg>
            Shelf <span>2</span>
          </p>
        </div>
      </div>
      <div className="fv-is-toast">
        <b>Archived 3 chats</b>
        <em>Undo</em>
      </div>
    </div>
  );
}
