export const label =
  "A native question card in an Omnyo chat: the agent asks which date format the CSV export should use, ISO 8601 is picked and submitted, and the chat moves from Needs you back to Working.";

const OPTIONS = [
  { key: "1", name: "ISO 8601", note: "2026-11-20 · sorts in spreadsheets" },
  { key: "2", name: "Keep locale", note: "20.11.2026 · as shown on screen" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-inbox-question" aria-hidden="true">
      <header className="fv-iq-bar">
        <span className="fv-iq-title">
          <b>Review: Add CSV export</b>
          <small>harbor-ledger · Codex</small>
        </span>
        <span className="fv-iq-state">
          <span className="fv-pill is-need">
            <i className="fv-dot fv-dot--attn" />
            Needs you
          </span>
          <span className="fv-pill is-work">
            <i className="fv-dot" />
            Working
          </span>
        </span>
      </header>
      <div className="fv-iq-thread">
        <p className="fv-iq-say">
          The export button works. One decision before I format the dates.
        </p>
        <p className="fv-iq-you">ISO 8601</p>
        <p className="fv-iq-next fv-dim">Formatting dates as 2026-11-20…</p>
      </div>
      <section className="fv-iq-form fv-panel">
        <p className="fv-iq-head">
          <span className="fv-pill">Date format</span>
          <span className="fv-dim">Required</span>
        </p>
        <p className="fv-iq-prompt">Which date format should the export use?</p>
        <ul>
          {OPTIONS.map((option) => (
            <li key={option.key} className={`is-o${option.key}`}>
              <kbd className="fv-key">{option.key}</kbd>
              <span>
                <b>{option.name}</b>
                <small>{option.note}</small>
              </span>
              <svg viewBox="0 0 16 16">
                <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
              </svg>
            </li>
          ))}
          <li className="is-other">
            <kbd className="fv-key">3</kbd>
            <span>
              <b>Other…</b>
            </span>
          </li>
        </ul>
        <p className="fv-iq-submit">
          <span>Submit answer</span>
        </p>
      </section>
      <svg className="fv-iq-cursor" viewBox="0 0 16 20">
        <path d="M2 1.5v14.2l3.6-3.4 2.3 5.4 2.4-1-2.3-5.3h5z" />
      </svg>
    </div>
  );
}
