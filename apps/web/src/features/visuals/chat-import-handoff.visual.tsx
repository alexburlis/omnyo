import "./chat-import-handoff.css";

export const label =
  "Moving work over from Conductor: after the prompt from the switch guide, the agent checks git, reads the old transcript and writes a handoff with the goal, what is done, the decisions made and what is left.";

const HANDOFF = [
  ["Goal", "CSV export on the invoices page"],
  ["Done", "Export button and row writer, on feat/csv-export"],
  ["Decisions", "ISO 8601 dates, header row from COLUMNS"],
  ["Left", "European date tests, then a review"],
] as const;

function Check() {
  return (
    <svg viewBox="0 0 16 16">
      <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-chat-import-handoff" aria-hidden="true">
      <header className="fv-ch-bar">
        <b>Pick up CSV export</b>
        <small>harbor-ledger · Claude Code</small>
      </header>
      <div className="fv-ch-thread">
        <p className="fv-ch-you">
          I was working on this in Conductor. Write me a short handoff: the
          goal, what&apos;s done, the decisions made, and what&apos;s left. Wait
          for my OK.
        </p>
        <p className="fv-ch-tool">
          <Check />
          Checked git status and recent commits
        </p>
        <p className="fv-ch-tool">
          <Check />
          Read the old conversation
        </p>
        <div className="fv-ch-card">
          <h4>Handoff</h4>
          <ul>
            {HANDOFF.map(([name, text]) => (
              <li key={name}>
                <b>{name}</b>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="fv-ch-end">Reply to correct anything, or say go.</p>
      </div>
    </div>
  );
}
