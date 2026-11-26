export const label =
  "An agent's question in an Omnyo chat with three numbered options for the CSV export's date format. Pressing the 2 key picks Keep locale, Submit answer sends it, and the answer appears in the chat as your reply.";

const OPTIONS = [
  { label: "ISO 8601", detail: "2026-11-20 everywhere" },
  { label: "Keep locale", detail: "20.11.2026 for de-DE" },
  { label: "Ask per export", detail: "A picker in the dialog" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-keyboard-answer" aria-hidden="true">
      <div className="fv-keyboard-answer-log">
        <p className="fv-keyboard-answer-agent">
          The export writes invoice dates. I need one decision first.
        </p>
        <p className="fv-keyboard-answer-you">Keep locale</p>
      </div>
      <div className="fv-keyboard-answer-bottom">
        <div className="fv-keyboard-answer-composer">
          <span className="fv-dim">Ask for follow-up changes</span>
          <i />
        </div>
        <div className="fv-keyboard-answer-card">
          <p className="fv-keyboard-answer-prompt">
            Which date format should the CSV export use?
          </p>
          <ul>
            {OPTIONS.map((option, index) => (
              <li key={option.label} className={index === 1 ? "is-pick" : ""}>
                <kbd className="fv-key">{index + 1}</kbd>
                <b>{option.label}</b>
                <span>{option.detail}</span>
              </li>
            ))}
          </ul>
          <footer>
            <span className="fv-dim">Add a note or your own answer</span>
            <span className="fv-keyboard-answer-skip">Skip all</span>
            <span className="fv-keyboard-answer-submit">Submit answer</span>
          </footer>
        </div>
      </div>
      <kbd className="fv-keyboard-answer-press">2</kbd>
    </div>
  );
}
