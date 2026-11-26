export const label =
  "Omnyo's model picker over the composer: typing opus max filters the grid of Claude Code models and reasoning levels to Opus 5.5 at Max, Enter applies it, and the lightning toggle turns on Fast mode.";

const LEVELS = ["Low", "Medium", "High", "xHigh", "Ultracode", "Max"] as const;

const QUERY = [..."opus max"];

export function Visual() {
  return (
    <div className="fv fv-claude-code-gui-picker" aria-hidden="true">
      <div className="fv-cp-thread">
        <p className="fv-cp-you">Add a CSV export to the invoices page.</p>
        <p className="fv-cp-say">
          I will add an Export CSV button to the toolbar and write the export in
          export.ts.
        </p>
      </div>
      <section className="fv-cp-pop fv-panel">
        <p className="fv-cp-search">
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="6" />
            <path d="m20 20-4.5-4.5" />
          </svg>
          <span className="fv-cp-query">
            {QUERY.map((letter, index) => (
              <span key={index} className={`fv-cp-letter is-q${index}`}>
                {letter === " " ? "\u00a0" : letter}
              </span>
            ))}
          </span>
          <i className="fv-cp-caret" />
        </p>
        <div className="fv-cp-grid">
          <span className="fv-cp-group">Claude Code</span>
          {LEVELS.map((level) => (
            <span key={level} className="fv-cp-level">
              {level}
            </span>
          ))}
          <span className="fv-cp-model">Opus 5.5</span>
          {LEVELS.map((level) => (
            <span
              key={level}
              className={`fv-cp-cell${level === "High" ? " is-from" : ""}${level === "Max" ? " is-to" : ""}`}
            >
              <i />
            </span>
          ))}
          <span className="fv-cp-model is-out">Sonnet 5</span>
          {LEVELS.map((level) => (
            <span key={level} className="fv-cp-cell is-out">
              <i />
            </span>
          ))}
          <span className="fv-cp-model is-out is-more">Codex · 4 models</span>
        </div>
      </section>
      <div className="fv-cp-composer">
        <span className="fv-cp-placeholder">Ask for a follow-up</span>
        <div className="fv-cp-tools">
          <span className="fv-cp-chip is-model">
            <svg viewBox="0 0 16 16">
              <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />
            </svg>
            Opus 5.5
            <span className="fv-cp-swap">
              <span className="is-a">High</span>
              <span className="is-b">Max</span>
            </span>
          </span>
          <span className="fv-cp-bolt">
            <svg viewBox="0 0 16 16">
              <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />
            </svg>
          </span>
          <span className="fv-cp-chip is-mode">Accept Edits</span>
          <span className="fv-cp-send">
            <svg viewBox="0 0 24 24">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
