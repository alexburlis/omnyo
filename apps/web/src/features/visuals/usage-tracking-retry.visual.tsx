import "./usage-tracking-retry.css";

export const label =
  "A chat paused by a Claude usage limit. Above the composer a queued card reads Continue this turn, Rate limited, retrying at 14:05, attempt 1, with Send now. The clock reaches 14:05, the card sends itself, and the chat goes from Paused back to Working and finishes the tests.";

export function Visual() {
  return (
    <div className="fv fv-usage-tracking-retry" aria-hidden="true">
      <header className="fv-utr-bar">
        <b>Date parser tests</b>
        <span className="fv-dim">atlas-notes</span>
        <span className="fv-utr-state">
          <span className="is-paused">
            <i className="fv-dot fv-dot--attn" />
            Paused
          </span>
          <span className="is-working">
            <i className="fv-dot fv-dot--ok" />
            Working
          </span>
        </span>
        <span className="fv-utr-clock fv-mono">
          <span className="is-t1">14:03</span>
          <span className="is-t2">14:04</span>
          <span className="is-t3">14:05</span>
        </span>
      </header>
      <div className="fv-utr-log">
        <p className="fv-utr-you">Add tests for European date formats</p>
        <p className="fv-soft">
          Added 4 cases to parseDate.test.ts. Running them now.
        </p>
        <p className="fv-utr-limit">
          <i className="fv-dot fv-dot--attn" />
          Claude usage limit reached. It resets at 14:05.
        </p>
        <p className="fv-utr-resume fv-soft">
          <span>Continuing. 4 of 4 European date cases now pass,</span>
          <span>and parseDate accepts 31.12.2026 and 31/12/2026.</span>
        </p>
      </div>
      <div className="fv-utr-dock">
        <div className="fv-utr-queued">
          <svg viewBox="0 0 16 16">
            <path d="M3 3v5.5a2 2 0 0 0 2 2h8M10 7.5l3 3-3 3" />
          </svg>
          <span className="fv-utr-copy">
            <b>Continue this turn</b>
            <span className="fv-utr-detail">
              <span className="is-wait">
                Rate limited · retrying at 14:05 · attempt 1
              </span>
              <span className="is-send">Sending…</span>
            </span>
          </span>
          <span className="fv-utr-now">Send now</span>
          <svg className="fv-utr-bin" viewBox="0 0 16 16">
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
          </svg>
        </div>
        <div className="fv-utr-composer">
          <span className="fv-dim">Ask for follow-up changes</span>
          <i />
        </div>
      </div>
    </div>
  );
}
