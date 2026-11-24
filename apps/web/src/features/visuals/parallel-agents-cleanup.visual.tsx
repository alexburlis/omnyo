import "./parallel-agents-cleanup.css";

export const label =
  "After a chat is archived, its worktree waits five minutes, Omnyo stops the dev server and watcher still running inside it and removes the folder, while the feat/csv-export branch and its three commits stay.";

const FOLDER =
  "M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z";

const BRANCH =
  "M6 3.5v11M6 14.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5ZM17 4a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5ZM17 9c0 4-4.5 4.5-11 6";

const COMMITS = [
  { message: "Add CSV export button", sha: "4f2a91c" },
  { message: "Write invoice rows as CSV", sha: "b81e07d" },
  { message: "Cover European date formats", sha: "9c3d5e2" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-parallel-agents-cleanup" aria-hidden="true">
      <p className="fv-pc-toast">
        <b>Archived · Add CSV export</b>
        <span className="fv-pc-timer">
          <i />
        </span>
        <span className="fv-pc-clock">
          <span className="is-5">5:00</span>
          <span className="is-3">3:00</span>
          <span className="is-1">1:00</span>
          <span className="is-0">0:00</span>
        </span>
      </p>
      <section className="fv-pc-card is-tree">
        <p className="fv-pc-eyebrow">Worktree</p>
        <p className="fv-pc-path">
          <svg viewBox="0 0 24 24">
            <path d={FOLDER} />
          </svg>
          ~/worktrees/harbor-ledger/csv-export
        </p>
        <p className="fv-pc-proc">
          <i className="fv-dot fv-dot--ok" />
          vite dev
          <em>:5173</em>
        </p>
        <p className="fv-pc-proc">
          <i className="fv-dot fv-dot--ok" />
          node watch.js
          <em>pid 8812</em>
        </p>
        <div className="fv-pc-gone">
          <span>Stopped 2 processes · removed</span>
        </div>
      </section>
      <section className="fv-pc-card is-branch">
        <p className="fv-pc-eyebrow">Branch</p>
        <p className="fv-pc-name">
          <svg viewBox="0 0 24 24">
            <path d={BRANCH} />
          </svg>
          feat/csv-export
        </p>
        {COMMITS.map((commit) => (
          <p key={commit.sha} className="fv-pc-commit">
            <i />
            <span>{commit.message}</span>
            <code>{commit.sha}</code>
          </p>
        ))}
        <p className="fv-pc-kept">Branch kept · 3 commits</p>
      </section>
    </div>
  );
}
