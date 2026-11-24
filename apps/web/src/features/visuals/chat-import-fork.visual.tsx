import "./chat-import-fork.css";

export const label =
  "An imported Claude Code chat that hides its 112 oldest turns from view. Sending a new message continues it in a fork of the session, while the original session file on disk stays read-only and unchanged.";

export function Visual() {
  return (
    <div className="fv fv-chat-import-fork" aria-hidden="true">
      <section className="fv-cf-chat">
        <header className="fv-cf-bar">
          <b>Add CSV export</b>
          <small>Claude Code</small>
          <span className="fv-pill">Imported</span>
        </header>
        <div className="fv-cf-thread">
          <p className="fv-cf-hidden">112 earlier turns hidden</p>
          <p className="fv-cf-say">
            The Export CSV button is in the toolbar and export.ts writes the
            rows.
          </p>
          <p className="fv-cf-you">Add a header row too.</p>
          <p className="fv-cf-fork">
            <svg viewBox="0 0 16 16">
              <path d="M5 2.5v4a3 3 0 0 0 3 3h0a3 3 0 0 1 3 3v1M11 2.5v4a3 3 0 0 1-3 3" />
            </svg>
            Continuing in a fork of the session
          </p>
          <p className="fv-cf-say fv-cf-reply">
            Header row added from COLUMNS. The invoice tests pass.
          </p>
        </div>
        <div className="fv-cf-composer">
          <span className="fv-cf-draft">
            <span className="is-hint">Ask for a follow-up</span>
            <span className="is-text">Add a header row too.</span>
          </span>
          <span className="fv-cf-send">
            <svg viewBox="0 0 24 24">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          </span>
        </div>
      </section>
      <aside className="fv-cf-orig">
        <h4>Original session</h4>
        <p className="fv-cf-path">
          <span>~/.claude/projects/</span>
          <span>harbor-ledger/1f0c4e2a.jsonl</span>
        </p>
        <dl>
          <dt>Turns</dt>
          <dd>152</dd>
          <dt>Modified</dt>
          <dd>3 h ago</dd>
        </dl>
        <p className="fv-cf-lock">
          <svg viewBox="0 0 16 16">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
          </svg>
          Unchanged
        </p>
        <p className="fv-cf-agent">The agent keeps all 152 turns as context.</p>
      </aside>
    </div>
  );
}
