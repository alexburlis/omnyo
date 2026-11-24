import "./browser-logins.css";

export const label =
  "Omnyo's browser settings on a Mac: Keep logins synced is off, with Arc · Personal offered as your default browser. You click Connect Arc, the switch turns on, Sync from shows Arc · Personal and the status moves from Syncing… to Synced just now with the cookie count.";

export function Visual() {
  return (
    <div className="fv fv-browser-logins" aria-hidden="true">
      <aside className="fv-browser-logins-nav">
        <span>General</span>
        <span>Appearance</span>
        <span>Keyboard</span>
        <span className="is-on">Browser</span>
        <span>Mobile</span>
      </aside>
      <div className="fv-browser-logins-main">
        <h3>Browser</h3>
        <div className="fv-browser-logins-row">
          <div>
            <b>Keep logins synced</b>
            <p>
              Refreshes Omnyo's logins from one browser profile every 15
              minutes. Cookies stay on this device.
            </p>
          </div>
          <i className="fv-browser-logins-switch" />
        </div>
        <div className="fv-browser-logins-stack">
          <div className="fv-browser-logins-row is-offer">
            <p>
              Arc · Personal is your default browser. If macOS asks, choose
              Always Allow.
            </p>
            <span className="fv-browser-logins-connect">Connect Arc</span>
          </div>
          <div className="fv-browser-logins-synced">
            <div className="fv-browser-logins-row">
              <div>
                <b>Sync from</b>
                <p>Omnyo's browser mirrors this profile's logins.</p>
              </div>
              <span className="fv-browser-logins-select">
                Arc · Personal
                <svg viewBox="0 0 16 16">
                  <path d="m5 6.5 3 3 3-3" />
                </svg>
              </span>
            </div>
            <p className="fv-browser-logins-status">
              <span className="is-before">
                <i className="fv-browser-logins-spin" />
                Syncing…
              </span>
              <span className="is-after">Synced just now · 1,284 cookies</span>
            </p>
          </div>
        </div>
        <p className="fv-browser-logins-sources">
          <span>Chrome</span>
          <span>Arc</span>
          <span>Dia</span>
          <span>Brave</span>
          <span>Edge</span>
          <span>Firefox</span>
          <span>Zen</span>
          <span>Safari</span>
        </p>
      </div>
    </div>
  );
}
