export const label =
  "Chat import lists recent Claude Code and Codex chats found on this machine, three of them ticked, with the button Import 3 chats.";

const CHATS = [
  {
    title: "Add CSV export",
    line: "harbor-ledger · Claude Code · 3h ago",
    state: "ready",
  },
  {
    title: "Date parser tests",
    line: "harbor-ledger · Codex · 5h ago",
    state: "ready",
  },
  {
    title: "Weekday issue triage",
    line: "atlas-notes · Claude Code · 20h ago",
    state: "ready",
  },
  {
    title: "Review: Add CSV export",
    line: "Already imported. · Codex · 6h ago",
    state: "done",
  },
  {
    title: "Rename invoice fields",
    line: "Not in a project folder. · Claude Code · 9h ago",
    state: "off",
  },
  {
    title: "Draft release notes",
    line: "Its folder no longer exists on this machine. · Codex · 22h ago",
    state: "off",
  },
] as const;

export function Visual() {
  return (
    <div className="fv fv-import" aria-hidden="true">
      <b className="fv-import-title">Pick up where you left off</b>
      <div className="fv-import-panel fv-panel">
        <div className="fv-import-head">
          <span className="fv-import-days">
            Chats with messages in the last{" "}
            <span className="fv-import-input">2</span> days
          </span>
        </div>
        <p className="fv-import-count">
          6 chats found · Claude Code 3 · Codex 3 · 1 already imported
        </p>
        <ul className="fv-import-list">
          {CHATS.map((chat) => (
            <li key={chat.title} className={`is-${chat.state}`}>
              <span className="fv-import-box" />
              <span className="fv-import-text">
                <span>{chat.title}</span>
                <span className="fv-import-line">{chat.line}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="fv-import-foot">
          <p className="fv-import-note">
            Each chat continues where you left off. Your CLI history is not
            changed.
          </p>
          <span className="fv-import-button">Import 3 chats</span>
        </div>
      </div>
    </div>
  );
}
