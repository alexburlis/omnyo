export const label =
  "Settings → Dictation in Omnyo: under Speech model, the download finishes and the status reads Speech model downloaded. Dictation runs on this Mac. Below it, project names are added to the Custom dictionary one per line: harbor-ledger, atlas-notes, de-DE and Parakeet.";

const WORDS = ["harbor-ledger", "atlas-notes", "de-DE", "Parakeet"] as const;

export function Visual() {
  return (
    <div className="fv fv-voice-dictionary" aria-hidden="true">
      <aside className="fv-voice-dictionary-nav">
        <span>General</span>
        <span>Keyboard</span>
        <span>Browser</span>
        <span>Mobile</span>
        <span className="is-on">Dictation</span>
      </aside>
      <div className="fv-voice-dictionary-main">
        <h3>Dictation</h3>
        <section className="fv-voice-dictionary-card">
          <b>Speech model</b>
          <div className="fv-voice-dictionary-model">
            <div className="fv-voice-dictionary-loading">
              <p>Downloading the speech model. This can take a few minutes.</p>
              <span className="fv-voice-dictionary-button">Downloading…</span>
            </div>
            <p className="fv-voice-dictionary-ready">
              <svg viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="6.2" />
                <path d="m5.4 8.2 1.8 1.8 3.5-3.7" />
              </svg>
              Speech model downloaded. Dictation runs on this Mac.
            </p>
          </div>
        </section>
        <section className="fv-voice-dictionary-card">
          <b>Custom dictionary</b>
          <p className="fv-voice-dictionary-hint">
            One English name or phrase per line.
          </p>
          <ul className="fv-voice-dictionary-words">
            {WORDS.map((word, index) => (
              <li key={word} className={`is-word-${index + 1}`}>
                {word}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
