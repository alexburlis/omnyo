export const label =
  "Omnyo's Installed plugins page. Glance is switched on, then Omnyo Customizer starts picking: the outline follows the pointer to the Category button, a click opens Change this part of Omnyo with the button attached, and the change is typed in for an agent.";

const PICKER =
  "M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M4 15v3.5A1.5 1.5 0 0 0 5.5 20H9M12 11l8 3-3.5 1.5L15 19z";

const PLUGINS = [
  {
    name: "Glance",
    icon: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12ZM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5Z",
    text: "A live card for every chat: status, proof and deliverables, with what changed since you last looked.",
    toggle: true,
  },
  {
    name: "Omnyo Customizer",
    icon: PICKER,
    text: "Toggle Omnyo Customizer in the footer, click any part of Omnyo, and describe the change in a new chat.",
    toggle: false,
  },
  {
    name: "Canvas",
    icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    text: "A shared canvas for each project, with linked chat boards, saved views and conversations beside the work.",
    toggle: false,
  },
  {
    name: "Browser Automation",
    icon: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18ZM3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18",
    text: "Let Omnyo control the in-app browser and browsers on connected machines, with inline previews for headless sessions.",
    toggle: false,
  },
] as const;

const CARET = "m6 9 6 6 6-6";

const POINTER = "M5 2.5v17l4.6-4.2 2.8 6.3 2.9-1.3-2.7-6.1h6.2Z";

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-plugins" aria-hidden="true">
      <div className="fv-plugins-page">
        <p className="fv-plugins-title">Settings</p>
        <div className="fv-plugins-content">
          <p className="fv-plugins-intro">
            The plugins installed on this Omnyo host. Turn one on or off, apply
            updates, or open it for settings and details.
          </p>
          <div className="fv-plugins-tools">
            <span className="fv-plugins-search">
              <Glyph d="M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13ZM20 20l-4.2-4.2" />
              Search
              <i className="fv-plugins-outline" />
            </span>
            <span className="fv-plugins-filter is-picked">
              Category
              <Glyph d={CARET} />
              <i className="fv-plugins-outline" />
              <svg className="fv-plugins-cross" viewBox="0 0 24 24">
                <path d="M12 2v20M2 12h20" />
              </svg>
            </span>
            <span className="fv-plugins-filter">
              Source
              <Glyph d={CARET} />
            </span>
            <span className="fv-plugins-filter">
              Sort
              <Glyph d={CARET} />
            </span>
            <span className="fv-plugins-new">
              <Glyph d="M12 8v8M8 12h8M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z" />
              New plugin
              <Glyph d={CARET} />
            </span>
          </div>
          <ul className="fv-plugins-grid">
            {PLUGINS.map((plugin) => (
              <li key={plugin.name}>
                <p className="fv-plugins-name">
                  <span className="fv-plugins-icon">
                    <Glyph d={plugin.icon} />
                  </span>
                  {plugin.name}
                </p>
                <p className="fv-plugins-text">{plugin.text}</p>
                <p className="fv-plugins-foot">
                  <span className="fv-plugins-logo" />
                  Omnyo Official
                  {plugin.toggle ? (
                    <span className="fv-plugins-switch is-on is-toggle">
                      <i />
                      <svg className="fv-plugins-pointer" viewBox="0 0 24 24">
                        <path d={POINTER} />
                      </svg>
                    </span>
                  ) : (
                    <span className="fv-plugins-switch is-on" />
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="fv-plugins-hint">
        <Glyph d={PICKER} />
        <span>Click what you want to change</span>
        <em>Stop</em>
      </p>
      <span className="fv-plugins-scrim" />
      <div className="fv-plugins-dialog">
        <p className="fv-plugins-dialog-title">Change this part of Omnyo</p>
        <p className="fv-plugins-pick">
          <Glyph d={PICKER} />
          <code>&lt;button&gt;</code>
          <span>Category</span>
          <em>Pick again</em>
        </p>
        <div className="fv-plugins-ask">
          <p className="fv-plugins-typed">
            <span className="fv-plugins-placeholder">What should change?</span>
            <span className="fv-plugins-type">
              Add a Favourites filter
              <i className="fv-plugins-cover">
                <b />
              </i>
            </span>
          </p>
          <p className="fv-plugins-askbar">
            <Glyph d="M12 5v14M5 12h14" />
            <span className="fv-plugins-send">
              <Glyph d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
