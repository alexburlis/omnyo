import "./keyboard.css";

export const label =
  "Omnyo's quick palette filtering as arch is typed: the Threads commands narrow to Archive thread and Search threads, Enter archives the chat, it leaves the sidebar and a Thread archived toast offers Undo.";

const QUERY = ["a", "r", "c", "h"] as const;

const COMMANDS = [
  { name: "New thread", keys: "⇧ ⌘ O", match: [], fate: "ar" },
  { name: "Search threads…", keys: "⌘ K", match: [2, 3, 4, 5], fate: "kept" },
  { name: "Rename thread", keys: null, match: [], fate: "arc" },
  { name: "Archive thread", keys: null, match: [0, 1, 2, 3], fate: "top" },
  { name: "Shelve thread", keys: "⇧ ⌘ F", match: [], fate: "ar" },
  { name: "Copy thread link", keys: "⇧ ⌘ C", match: [], fate: "ar" },
  { name: "Previous thread", keys: "⌘ ↑", match: [], fate: "ar" },
  { name: "Next thread", keys: "⌘ ↓", match: [], fate: "ar" },
] as const;

const SIDEBAR = [
  "Add CSV export",
  "Review: Add CSV export",
  "Date parser tests",
  "Weekday issue triage",
  "Fix invoice rounding",
  "Tidy note schema",
] as const;

function Title({ name, match }: { name: string; match: readonly number[] }) {
  if (match.length === 0) return <span>{name}</span>;

  return (
    <span>
      {[...name].map((character, index) => {
        const order = match.indexOf(index);

        return order === -1 ? (
          character
        ) : (
          <b key={index} className={`is-q${order}`}>
            {character}
          </b>
        );
      })}
    </span>
  );
}

export function Visual() {
  return (
    <div className="fv fv-keyboard" aria-hidden="true">
      <div className="fv-keys-app">
        <aside className="fv-keys-side">
          <p className="fv-keys-new">New thread</p>
          {SIDEBAR.map((title, index) => (
            <p
              key={title}
              className={
                index === 0
                  ? "is-on is-gone"
                  : index === 1
                    ? "is-next"
                    : "is-below"
              }
            >
              <i />
              <span>{title}</span>
            </p>
          ))}
        </aside>
        <div className="fv-keys-main">
          <div className="fv-keys-composer" />
        </div>
        <div className="fv-keys-toast">
          <svg viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6.2" />
            <path d="m5.4 8.2 1.8 1.8 3.4-3.6" />
          </svg>
          <span>
            <b>Thread archived</b>
            <small>Add CSV export</small>
          </span>
          <em>Undo</em>
        </div>
      </div>
      <div className="fv-keys-scrim" />
      <section className="fv-keys-palette">
        <div className="fv-keys-input">
          {QUERY.map((letter, index) => (
            <span key={letter} className={`fv-keys-letter is-q${index}`}>
              {letter}
            </span>
          ))}
          <span className="fv-keys-caret" />
          <span className="fv-keys-placeholder">Search commands…</span>
        </div>
        <div className="fv-keys-list">
          <p className="fv-keys-label">Threads</p>
          {COMMANDS.map((command, index) => (
            <p
              key={command.name}
              className={`fv-keys-row is-${command.fate}${index === 0 ? " is-on" : ""}`}
            >
              <Title name={command.name} match={command.match} />
              {command.keys ? <kbd>{command.keys}</kbd> : null}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}
