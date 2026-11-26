export const label =
  "Prompt Library open over the chat composer after pressing Ctrl+R. Typing csv expot, with a typo, still finds the starred prompt Add CSV export with semicolons for de-DE invoices and two recent CSV export prompts. Enter puts the starred prompt into the composer.";

const ALL = [
  "Rerun the date parser tests and summarise failures",
  "Add CSV export with semicolons for de-DE invoices",
  "Review feat/csv-export against main",
  "Open atlas-notes and fix the flaky sync test",
  "Check the CSV export on the invoices page",
] as const;

const RECENT = [
  "Check the CSV export on the invoices page",
  "Review feat/csv-export against main",
] as const;

const STARRED = "Add CSV export with semicolons for de-DE invoices";

function Star() {
  return (
    <svg viewBox="0 0 16 16">
      <path d="m8 2.2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4-2.9-2.8 4-.6z" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-keyboard-prompts" aria-hidden="true">
      <p className="fv-keyboard-prompts-agent">
        All 12 German date cases pass. Anything else for feat/csv-export?
      </p>
      <div className="fv-keyboard-prompts-pop">
        <p className="fv-keyboard-prompts-search">
          <svg viewBox="0 0 16 16" className="fv-keyboard-prompts-lens">
            <circle cx="7" cy="7" r="4.2" />
            <path d="m10.2 10.2 3 3" />
          </svg>
          <span className="fv-keyboard-prompts-query">
            csv expot
            <i />
          </span>
          <span className="fv-keyboard-prompts-scope">
            <span>Thread</span>
            <span className="is-on">Project</span>
            <span>All</span>
          </span>
        </p>
        <div className="fv-keyboard-prompts-lists">
          <ul className="fv-keyboard-prompts-all">
            <li className="fv-keyboard-prompts-section">Recent</li>
            {ALL.map((prompt) => (
              <li key={prompt}>{prompt}</li>
            ))}
          </ul>
          <ul className="fv-keyboard-prompts-found">
            <li className="fv-keyboard-prompts-section">Starred</li>
            <li className="is-hit">
              <Star />
              {STARRED}
            </li>
            <li className="fv-keyboard-prompts-section">Recent</li>
            {RECENT.map((prompt) => (
              <li key={prompt}>{prompt}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="fv-keyboard-prompts-composer">
        <span className="fv-keyboard-prompts-draft">
          {STARRED}
          <i />
        </span>
        <span className="fv-keyboard-prompts-placeholder">
          Ask for follow-up changes
        </span>
        <kbd className="fv-key fv-keyboard-prompts-chord">⌃R</kbd>
      </div>
    </div>
  );
}
