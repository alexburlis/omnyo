export const label =
  "A parent chat with two child chats nested under it, and the review child reporting back to the parent that its review finished with 1 serious and 2 minor findings.";

export function Visual() {
  return (
    <div className="fv fv-multi-agent" aria-hidden="true">
      <div className="fv-multi-agent-stage">
        <svg className="fv-multi-agent-wires" viewBox="0 0 35 18">
          <path className="is-tree" d="M1.7 4.2 V13.5 H3.4 M1.7 8.5 H3.4" />
          <path className="is-message" d="M19.4 8.5 C23.5 8.5 25 7.9 25 4.8" />
        </svg>
        <div className="fv-multi-agent-chat is-parent fv-panel">
          <span className="fv-multi-agent-glyph" />
          <span className="fv-multi-agent-name">
            <b>Add CSV export</b>
            <span>Claude Code</span>
          </span>
          <svg className="fv-multi-agent-chevron" viewBox="0 0 10 10">
            <path d="M2.5 3.8 L5 6.3 L7.5 3.8" />
          </svg>
        </div>
        <div className="fv-multi-agent-chat is-child is-review fv-panel">
          <i className="fv-dot fv-dot--ok" />
          <span className="fv-multi-agent-name">
            <b>Review: Add CSV export</b>
            <span>Codex</span>
          </span>
        </div>
        <div className="fv-multi-agent-chat is-child is-tests fv-panel">
          <span className="fv-multi-agent-glyph" />
          <span className="fv-multi-agent-name">
            <b>Date parser tests</b>
            <span>Codex</span>
          </span>
        </div>
        <div className="fv-multi-agent-bubble">
          <div className="fv-multi-agent-from">Review: Add CSV export</div>
          <div className="fv-multi-agent-text">
            Review finished: <span>1 serious, 2 minor</span>
          </div>
        </div>
        <p className="fv-multi-agent-note">
          <i className="fv-dot fv-dot--dim" />
          Child questions go to the parent chat
        </p>
      </div>
    </div>
  );
}
