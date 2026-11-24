import "./multi-agent-spawn.css";

export const label =
  "A Claude Code chat starts a Codex review with omnyo thread spawn. The review appears under Child threads, the parent steers it with omnyo thread tell, and the review reports back when it finishes.";

export function Visual() {
  return (
    <div className="fv fv-multi-agent-spawn" aria-hidden="true">
      <header className="fv-ms-bar">
        <b>Add CSV export</b>
        <small>harbor-ledger · Claude Code</small>
      </header>
      <div className="fv-ms-thread">
        <p className="fv-ms-say">
          The export works. I will ask Codex to review the branch.
        </p>
        <p className="fv-ms-cmd is-spawn">
          <i>$</i>
          <span>
            omnyo thread spawn <b>--provider codex</b> --title &quot;Review: Add
            CSV export&quot;
          </span>
        </p>
        <p className="fv-ms-cmd is-tell">
          <i>$</i>
          <span>
            omnyo thread tell <b>thr_r8x2</b> &quot;Check the date column
            too&quot;
          </span>
        </p>
        <p className="fv-ms-say is-back">
          Review finished: 1 serious finding in the date column. Fixing it now.
        </p>
      </div>
      <div className="fv-ms-dock">
        <div className="fv-ms-children">
          <p>
            <svg viewBox="0 0 16 16" width="1.1em" height="1.1em">
              <path
                d="M4 3v6.5A1.5 1.5 0 0 0 5.5 11H12M4 6.5h8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            Child threads
            <span className="fv-ms-count">
              <span className="is-zero">0</span>
              <span className="is-one">1</span>
            </span>
          </p>
          <div className="fv-ms-child">
            <span className="fv-ms-state">
              <i className="fv-ms-spin" />
              <svg className="fv-ms-done" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="m8 12.3 2.7 2.7L16 9.6" />
              </svg>
            </span>
            <span>
              <b>Review: Add CSV export</b> <small>Codex · GPT-5.6 Sol</small>
            </span>
            <span className="fv-ms-note">
              <span className="is-run">Working</span>
              <span className="is-told">Message received</span>
              <span className="is-fin">Finished</span>
            </span>
          </div>
        </div>
        <p className="fv-ms-placeholder">Ask for a follow-up</p>
      </div>
    </div>
  );
}
