import "./privacy.css";

export const label =
  "Where your data goes: from Omnyo on your devices to the Omnyo server you run, then to the AI provider you choose. Omnyo runs no AI service.";

export function Visual() {
  return (
    <div className="fv fv-privacy" aria-hidden="true">
      <p className="fv-eyebrow">Where your data goes</p>
      <div className="fv-privacy-flow">
        <div className="fv-privacy-node fv-panel">
          <svg className="fv-privacy-icon" viewBox="0 0 48 32">
            <rect x="3" y="5" width="28" height="18" rx="2" />
            <path d="M0 27h34" />
            <rect x="36" y="9" width="11" height="20" rx="2.5" />
          </svg>
          <p className="fv-privacy-title">Omnyo on your devices</p>
          <p className="fv-privacy-sub">Desktop app, phone or browser</p>
        </div>
        <i className="fv-privacy-link" />
        <div className="fv-privacy-node fv-privacy-node--server fv-panel">
          <svg className="fv-privacy-icon" viewBox="0 0 48 32">
            <rect x="9" y="3" width="30" height="11" rx="2.5" />
            <rect x="9" y="18" width="30" height="11" rx="2.5" />
            <circle className="is-on" cx="15" cy="8.5" r="1.6" />
            <circle className="is-on" cx="15" cy="23.5" r="1.6" />
          </svg>
          <p className="fv-privacy-title">The Omnyo server you run</p>
          <p className="fv-privacy-sub">Keeps your chats and settings</p>
        </div>
        <i className="fv-privacy-link" />
        <div className="fv-privacy-node fv-panel">
          <svg className="fv-privacy-icon" viewBox="0 0 48 32">
            <path d="M14 27a8 8 0 0 1-1-15.9A11 11 0 0 1 34 10a8.5 8.5 0 0 1 1 17Z" />
          </svg>
          <p className="fv-privacy-title">The AI provider you choose</p>
          <p className="fv-privacy-sub">
            Claude Code or Codex, with your own sign‑in
          </p>
        </div>
      </div>
      <p className="fv-privacy-note">
        <i className="fv-dot" />
        Omnyo runs no AI service
      </p>
    </div>
  );
}
