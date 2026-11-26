export const label =
  "The model picker for a Codex chat: the arrow key steps GPT-5.6 Sol from High to xHigh to Max, Enter applies it, and the lightning button steps the service tier to Fast and then Ultrafast.";

const LEVELS = [
  "None",
  "Low",
  "Medium",
  "High",
  "xHigh",
  "Max",
  "Ultra",
] as const;

const MODELS = ["GPT-5.6 Sol", "GPT-5.6 Luna", "GPT-5.5"] as const;

function Codex() {
  return (
    <svg className="fv-xp-mark" viewBox="0 0 16 16">
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" />
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" transform="rotate(120 8 8)" />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-codex-gui-picker" aria-hidden="true">
      <div className="fv-xp-thread">
        <p className="fv-xp-you">Review the CSV export branch.</p>
        <p className="fv-xp-say">
          Reading feat/csv-export. Three files changed, one new test.
        </p>
      </div>
      <section className="fv-xp-pop fv-panel">
        <p className="fv-xp-head">
          <Codex />
          <b>Codex</b>
          <span className="fv-xp-keys fv-dim">
            <kbd className="fv-key">←</kbd>
            <kbd className="fv-key is-right">→</kbd>
            level
            <kbd className="fv-key is-enter">↵</kbd>
          </span>
        </p>
        <div className="fv-xp-grid">
          <span />
          {LEVELS.map((level) => (
            <span key={level} className="fv-xp-level">
              {level}
            </span>
          ))}
          {MODELS.map((model, row) => (
            <div
              key={model}
              className={`fv-xp-row${row === 0 ? " is-on" : ""}`}
            >
              <span className="fv-xp-model">{model}</span>
              {LEVELS.map((level) => (
                <span key={level} className="fv-xp-cell">
                  <i />
                </span>
              ))}
            </div>
          ))}
          <i className="fv-xp-pick" />
        </div>
      </section>
      <div className="fv-xp-composer">
        <span className="fv-xp-placeholder">Ask for a follow-up</span>
        <div className="fv-xp-tools">
          <span className="fv-xp-chip">
            <Codex />
            GPT-5.6 Sol
            <span className="fv-xp-swap">
              <span className="is-a">High</span>
              <span className="is-b">Max</span>
            </span>
          </span>
          <span className="fv-xp-bolt">
            <svg viewBox="0 0 16 16">
              <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />
            </svg>
            <span className="fv-xp-tier">
              <span className="is-fast">Fast</span>
              <span className="is-ultra">Ultrafast</span>
            </span>
          </span>
          <span className="fv-xp-chip is-mode">Approve for me</span>
          <span className="fv-xp-send">
            <svg viewBox="0 0 24 24">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
