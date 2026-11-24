import "./chat-import-cli.css";

export const label =
  "A terminal running omnyo chat-import scan, which lists five recent chats with their status, age, project and title, then omnyo chat-import run, which imports the three ready chats.";

const ROWS = [
  [
    "ready",
    "claude-code:1f0c…",
    "3 h ago  ",
    "harbor-ledger",
    "Add CSV export",
  ],
  [
    "ready",
    "codex:019a…      ",
    "5 h ago  ",
    "harbor-ledger",
    "Date parser tests",
  ],
  [
    "ready",
    "claude-code:7b2e…",
    "20 h ago ",
    "atlas-notes  ",
    "Weekday issue triage",
  ],
  [
    "imported",
    "codex:01b3…      ",
    "6 h ago  ",
    "harbor-ledger",
    "Review: Add CSV export",
  ],
  [
    "missing",
    "codex:0c4d…      ",
    "yesterday",
    "Its folder no longer exists on this machine.",
    "Draft release notes",
  ],
] as const;

const RESULTS = [
  ["claude-code:1f0c…", "Add CSV export      ", "thread thr_8k2m"],
  ["codex:019a…      ", "Date parser tests   ", "thread thr_8k2n"],
  ["claude-code:7b2e…", "Weekday issue triage", "thread thr_8k2p"],
] as const;

const pad = (text: string, width: number) => text.padEnd(width, " ");

export function Visual() {
  return (
    <div className="fv fv-chat-import-cli" aria-hidden="true">
      <div className="fv-ci-term">
        <p className="fv-ci-bar">
          <i />
          <i />
          <i />
          <span>~/code/harbor-ledger</span>
        </p>
        <div className="fv-ci-lines">
          <p className="is-cmd">
            <b>$</b> omnyo chat-import scan --days 7
          </p>
          <p>
            5 chats with messages in the last 7 days · Claude Code 3 · Codex 2
          </p>
          <p className="is-dim">3 ready · 1 already imported · 1 unavailable</p>
          {ROWS.map((row) => (
            <p key={row[1]}>
              <em className={`is-${row[0]}`}>{pad(row[0], 10)}</em>
              {`${row[1]}  ${row[2]}  `}
              <span className="is-dim">{`${row[3]}  `}</span>
              {row[4]}
            </p>
          ))}
          <p className="is-cmd">
            <b>$</b> omnyo chat-import run --days 7
          </p>
          {RESULTS.map((row) => (
            <p key={row[0]}>
              <em className="is-imported">{pad("imported", 10)}</em>
              {`${row[0]}  ${row[1]}  `}
              <span className="is-dim">{row[2]}</span>
            </p>
          ))}
          <p className="is-dim">3 imported · 0 already imported · 0 failed</p>
        </div>
      </div>
    </div>
  );
}
