export const label =
  "Omnyo's new chat box with the Start in menu open. New worktree from main is picked and the chat is sent: it appears under Running in the sidebar, and its new worktree joins the list beside the worktrees of the other running chats, each on its own branch.";

const RUNNING = [
  "Add CSV export",
  "Date parser tests",
  "Weekday issue triage",
] as const;

const OPEN = ["Fix invoice rounding", "Tidy note schema"] as const;

const WORKTREES = [
  "feat/csv-export",
  "test/date-parser",
  "omnyo/weekday-issue-triage",
  "fix/invoice-rounding",
] as const;

const BRANCH =
  "M6 3.5v11M6 14.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5ZM17 4a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5ZM17 9c0 4-4.5 4.5-11 6";

const FOLDER_GIT =
  "M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5ZM10 10.5v5.5M15 11.5c0 2.5-2.5 3-5 3";

const CHECK = "M20 6 9 17l-5-5";

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-worktrees" aria-hidden="true">
      <aside className="fv-worktrees-side">
        <p className="fv-worktrees-new">
          <Glyph d="M12 8v8M8 12h8M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z" />
          New thread
        </p>
        <p className="fv-worktrees-head">
          Running
          <span className="fv-worktrees-count">
            <span>{RUNNING.length}</span>
            <span>{RUNNING.length + 1}</span>
          </span>
        </p>
        <div className="fv-worktrees-shift">
          <p className="fv-worktrees-row is-running is-fresh">
            <i />
            <span>European date formats</span>
          </p>
          {RUNNING.map((title) => (
            <p className="fv-worktrees-row is-running" key={title}>
              <i />
              <span>{title}</span>
            </p>
          ))}
          <p className="fv-worktrees-head">
            Open <span>{OPEN.length}</span>
          </p>
          {OPEN.map((title) => (
            <p className="fv-worktrees-row" key={title}>
              <span>{title}</span>
            </p>
          ))}
        </div>
      </aside>
      <main className="fv-worktrees-main">
        <div className="fv-worktrees-composer">
          <p className="fv-worktrees-draft">
            <span>Cover European date formats in the parser tests.</span>
            <span className="fv-worktrees-placeholder">
              Start a conversation
            </span>
          </p>
          <div className="fv-worktrees-bar">
            <Glyph d="M12 5v14M5 12h14" />
            <span className="fv-worktrees-chip">
              <Glyph
                className="fv-worktrees-mark"
                d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"
              />
              Opus 5.5
              <Glyph className="fv-worktrees-caret" d="m6 9 6 6 6-6" />
            </span>
            <span className="fv-worktrees-chip is-icon">
              <Glyph d="M5 6.5h14v9H5zM3 18.5h18" />
            </span>
            <span className="fv-worktrees-chip is-open">
              <Glyph d={BRANCH} />
              main
              <Glyph className="fv-worktrees-caret" d="m6 9 6 6 6-6" />
            </span>
            <Glyph
              className="fv-worktrees-mic"
              d="M12 3.5a3 3 0 0 0-3 3v4.5a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"
            />
            <span className="fv-worktrees-send">
              <Glyph d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
            </span>
          </div>
        </div>
        <div className="fv-worktrees-menu">
          <p className="fv-worktrees-heading">Start in</p>
          <p className="fv-worktrees-item is-checkout">
            <Glyph d={BRANCH} />
            <span>main</span>
            <em>Checkout</em>
            <Glyph className="fv-worktrees-check" d={CHECK} />
          </p>
          <p className="fv-worktrees-item is-on">
            <Glyph d={BRANCH} />
            <span>New worktree from main</span>
            <Glyph className="fv-worktrees-check" d={CHECK} />
          </p>
          <p className="fv-worktrees-heading">Worktrees</p>
          <div className="fv-worktrees-list">
            <p className="fv-worktrees-item is-fresh">
              <Glyph d={FOLDER_GIT} />
              <span>omnyo/european-date-formats</span>
            </p>
            {WORKTREES.map((branch) => (
              <p className="fv-worktrees-item" key={branch}>
                <Glyph d={FOLDER_GIT} />
                <span>{branch}</span>
              </p>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
