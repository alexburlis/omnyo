import "./keyboard-rebind.css";

export const label =
  "Settings → Keyboard in Omnyo: the Threads shortcuts list New thread, Search threads, Archive thread, Shelve thread and Next thread. You click Archive thread's Unassigned shortcut, it shows Press keys, and the new shortcut ⌥⌘A appears with a reset button.";

const ROWS = [
  { name: "New thread", keys: ["⇧", "⌘", "O"] },
  { name: "Search threads", keys: ["⌘", "K"] },
  { name: "Archive thread", keys: [] },
  { name: "Shelve thread", keys: ["⇧", "⌘", "F"] },
  { name: "Next thread", keys: ["⌘", "↓"] },
] as const;

export function Visual() {
  return (
    <div className="fv fv-keyboard-rebind" aria-hidden="true">
      <header className="fv-keyboard-rebind-head">
        <div>
          <h3>Keyboard shortcuts</h3>
          <p>Click a shortcut, then press its new keys.</p>
        </div>
        <span className="fv-keyboard-rebind-reset">Reset all</span>
      </header>
      <p className="fv-keyboard-rebind-search">Search shortcuts</p>
      <p className="fv-keyboard-rebind-group">Threads</p>
      <ul className="fv-keyboard-rebind-rows">
        {ROWS.map((row) => (
          <li
            key={row.name}
            className={row.keys.length === 0 ? "is-target" : undefined}
          >
            <span>{row.name}</span>
            {row.keys.length === 0 ? (
              <span className="fv-keyboard-rebind-slot">
                <span className="is-empty">Unassigned</span>
                <span className="is-recording">Press keys</span>
                <span className="is-set">
                  <kbd className="fv-key">⌥</kbd>
                  <kbd className="fv-key">⌘</kbd>
                  <kbd className="fv-key">A</kbd>
                  <svg viewBox="0 0 16 16">
                    <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 3v2.6h2.6" />
                  </svg>
                </span>
              </span>
            ) : (
              <span className="fv-keyboard-rebind-keys">
                {row.keys.map((key) => (
                  <kbd key={key} className="fv-key">
                    {key}
                  </kbd>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
