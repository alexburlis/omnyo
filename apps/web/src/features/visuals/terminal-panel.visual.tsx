import "./terminal-demo.css";

export const label =
  "A Bash terminal tab beside the chat, showing test results from the project's worktree.";

export function Visual() {
  return (
    <div className="fv fv-terminal fv-terminal-panel" aria-hidden="true">
      <div className="fv-terminal-thread">
        <p className="fv-terminal-title">Add CSV export</p>
        <p className="fv-terminal-message">The export is ready to check.</p>
        <p className="fv-terminal-draft">Ask a follow-up…</p>
      </div>
      <div className="fv-terminal-shell">
        <p className="fv-eyebrow">›_ Bash</p>
        <p>
          <span>$</span> pnpm test
        </p>
        <pre>✓ 4 tests passed</pre>
      </div>
    </div>
  );
}
