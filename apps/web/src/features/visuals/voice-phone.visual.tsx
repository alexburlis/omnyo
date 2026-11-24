import "./voice-phone.css";

export const label =
  "Dictating from the iPhone app: you tap the microphone in a chat's composer and speak while a waveform moves. The recording goes to studio-mac, where Dictation by Paraspeech transcribes it on the Mac, and the words appear in the phone's draft.";

const BARS = Array.from({ length: 22 }, (_, index) => {
  const wave = Math.sin(index * 1.3) * 0.5 + Math.sin(index * 0.55) * 0.4;

  return Math.round((0.35 + Math.abs(wave) * 0.65) * 100) / 100;
});

export function Visual() {
  return (
    <div className="fv fv-voice-phone" aria-hidden="true">
      <div className="fv-voice-phone-device">
        <div className="fv-voice-phone-screen">
          <header>
            <b>Date parser tests</b>
            <span>Claude Code</span>
          </header>
          <div className="fv-voice-phone-chat">
            <p>All 12 German date cases pass now.</p>
          </div>
          <div className="fv-voice-phone-composer">
            <div className="fv-voice-phone-draft">
              <span className="fv-voice-phone-placeholder">Message</span>
              <span className="fv-voice-phone-text">
                Add a test for 31.12.2026 in de-DE invoices
              </span>
              <span className="fv-voice-phone-wave">
                {BARS.map((height, index) => (
                  <i
                    key={index}
                    style={{
                      height: `${height * 100}%`,
                      animationDelay: `${(index % 7) * -0.13}s`,
                    }}
                  />
                ))}
              </span>
            </div>
            <span className="fv-voice-phone-mic">
              <svg viewBox="0 0 16 16">
                <rect x="5.5" y="1.8" width="5" height="8" rx="2.5" />
                <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.2" />
              </svg>
            </span>
          </div>
        </div>
      </div>
      <i className="fv-voice-phone-wire" />
      <div className="fv-voice-phone-mac">
        <p>
          <svg viewBox="0 0 24 16">
            <rect x="3" y="1.5" width="18" height="11" rx="1.5" />
            <path d="M1 14.5h22" />
          </svg>
          <b>studio-mac</b>
        </p>
        <p className="fv-voice-phone-service">
          Dictation by Paraspeech · English
        </p>
        <p className="fv-voice-phone-state">
          <span className="is-idle">Ready</span>
          <span className="is-busy">Transcribing on this Mac…</span>
          <span className="is-done">Text added to your draft</span>
        </p>
      </div>
    </div>
  );
}
