import "./storage-cleanup-worktree.css";

export const label =
  "A finished chat, Add CSV export, is archived from the sidebar. Its worktree folder in harbor-ledger shows Removes in 5 min, then is removed and frees 412 MB, while its branch feat/csv-export stays with its 3 commits. The worktree of the running chat, Date parser tests, is untouched.";

export function Visual() {
  return (
    <div className="fv fv-storage-cleanup-worktree" aria-hidden="true">
      <aside className="fv-scw-side">
        <p className="fv-eyebrow">Running</p>
        <p className="fv-scw-chat is-live">
          <i className="fv-dot fv-dot--ok" />
          Date parser tests
        </p>
        <p className="fv-eyebrow">Done</p>
        <p className="fv-scw-chat is-done">
          <i className="fv-dot fv-dot--dim" />
          Add CSV export
          <svg className="fv-scw-archive" viewBox="0 0 16 16">
            <path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3" />
          </svg>
        </p>
        <p className="fv-scw-archived fv-dim">Archived · Add CSV export</p>
      </aside>
      <div className="fv-scw-main">
        <header className="fv-scw-head">
          <h3>Worktrees &amp; branches</h3>
          <span className="fv-scw-disk fv-mono">
            <span className="is-before">800 MB</span>
            <span className="is-after">388 MB</span>
          </span>
        </header>
        <p className="fv-eyebrow">harbor-ledger worktrees</p>
        <ul className="fv-scw-list">
          <li className="fv-scw-row is-gone">
            <span className="fv-scw-path fv-mono">csv-export</span>
            <span className="fv-dim">412 MB</span>
            <span className="fv-scw-state">
              <span className="is-s1">Chat open</span>
              <span className="is-s2">Removes in 5 min</span>
              <span className="is-s3">Removed</span>
            </span>
          </li>
          <li className="fv-scw-row">
            <span className="fv-scw-path fv-mono">date-parser</span>
            <span className="fv-dim">388 MB</span>
            <span className="fv-scw-state">
              <span className="is-keep">Chat running</span>
            </span>
          </li>
        </ul>
        <p className="fv-eyebrow">Branches</p>
        <ul className="fv-scw-list">
          <li className="fv-scw-row is-branch">
            <span className="fv-scw-path fv-mono">feat/csv-export</span>
            <span className="fv-dim">3 commits</span>
            <span className="fv-scw-state">
              <span className="is-kept">Kept</span>
            </span>
          </li>
          <li className="fv-scw-row">
            <span className="fv-scw-path fv-mono">feat/date-parser</span>
            <span className="fv-dim">1 commit</span>
            <span className="fv-scw-state">
              <span className="is-keep">In use</span>
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
