import "./integrations-pr.css";

export const label =
  "A chat's Git control open in its header: branch feat/csv-export with 42 lines added, 7 removed and 2 commits ahead of main. The pull request Add CSV export #128 runs its three checks, turns from Checks running to Ready to merge, and Merge is pressed, so the badge reads Merged.";

const FILES = [
  { name: "export.ts", dir: "src/invoices", letter: "M", tone: "attn" },
  { name: "export.test.ts", dir: "src/invoices", letter: "N", tone: "ok" },
] as const;

const CHECKS = ["typecheck", "unit tests", "lint"] as const;

function PullIcon() {
  return (
    <svg className="fv-ipr-icon" viewBox="0 0 16 16">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.6 1.5L9 6" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="fv-ipr-icon" viewBox="0 0 16 16">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 6.6c0 3-7 2.2-7 4.3" />
    </svg>
  );
}

function Status() {
  return (
    <span className="fv-ipr-status">
      <span className="fv-ipr-state is-run">
        <i className="fv-dot fv-dot--attn" />
        Checks running
      </span>
      <span className="fv-ipr-state is-ready">
        <i className="fv-dot fv-dot--ok" />
        Ready to merge
      </span>
      <span className="fv-ipr-state is-merged">
        <i className="fv-dot" />
        Merged
      </span>
    </span>
  );
}

export function Visual() {
  return (
    <div className="fv fv-integrations-pr" aria-hidden="true">
      <header className="fv-ipr-bar">
        <p className="fv-ipr-title">
          <b>Add CSV export</b>
          <span className="fv-dim">harbor-ledger</span>
        </p>
        <span className="fv-ipr-git">
          <BranchIcon />
          <span className="fv-mono">feat/csv-export</span>
          <span className="fv-ipr-tally">
            <i>+42</i> <s>−7</s>
          </span>
          <span className="fv-ipr-sync">↑2</span>
        </span>
        <span className="fv-ipr-badge">
          <PullIcon />
          <span>#128</span>
          <Status />
        </span>
      </header>
      <div className="fv-ipr-log">
        <p className="fv-ipr-you">Open a pull request when the tests pass</p>
        <p className="fv-soft">
          All 14 tests pass. I pushed feat/csv-export and opened #128 against
          main.
        </p>
        <p className="fv-dim">Checks are running on GitHub.</p>
      </div>
      <div className="fv-ipr-panel fv-panel">
        <p className="fv-ipr-group">
          <span>Uncommitted</span>
          <span className="fv-dim">2</span>
        </p>
        <ul className="fv-ipr-files">
          {FILES.map((file) => (
            <li key={file.name}>
              <b>{file.name}</b>
              <span className="fv-dim">{file.dir}</span>
              <i className={`is-${file.tone}`}>{file.letter}</i>
            </li>
          ))}
        </ul>
        <p className="fv-ipr-group">
          <span>Committed</span>
          <span className="fv-dim">2 commits ahead of main</span>
        </p>
        <div className="fv-ipr-card">
          <p className="fv-ipr-card-head">
            <PullIcon />
            <b>Add CSV export</b>
            <span className="fv-dim">#128</span>
          </p>
          <Status />
          <ul className="fv-ipr-checks">
            {CHECKS.map((check, index) => (
              <li key={check} className={`is-c${index + 1}`}>
                <i />
                {check}
              </li>
            ))}
          </ul>
          <span className="fv-ipr-merge">
            <span>Merge</span>
            <svg viewBox="0 0 16 16">
              <path d="M4.5 6.5 8 10l3.5-3.5" />
            </svg>
          </span>
        </div>
        <p className="fv-ipr-foot">
          <span>Review all changes</span>
          <span className="fv-dim">
            Merges into <b className="fv-mono">main</b>
          </span>
        </p>
      </div>
      <svg className="fv-ipr-cursor" viewBox="0 0 16 20">
        <path d="M2 1.5v14.2l3.6-3.4 2.4 5.6 2.5-1.1-2.4-5.5H13z" />
      </svg>
    </div>
  );
}
