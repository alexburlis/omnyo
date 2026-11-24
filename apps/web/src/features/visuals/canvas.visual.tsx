import "./canvas.css";

export const label =
  "A chat with its Canvas board open beside it. While the agent fixes the date parser, the board updates live: the parser status runs to Done, the failing case turns into a passing one, the European bar on the test chart fills up, and the toolbar counts the updated cards.";

const BARS = [
  { name: "ISO", fix: false },
  { name: "US", fix: false },
  { name: "UK", fix: false },
  { name: "EU", fix: true },
] as const;

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const TOOLS = [
  "M4 5h16v11H9l-5 4zM12 8v5M9.5 10.5h5",
  "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
] as const;

export function Visual() {
  return (
    <div className="fv fv-canvas" aria-hidden="true">
      <section className="fv-canvas-chat">
        <p className="fv-canvas-earlier fv-canvas-user">Add a CSV export.</p>
        <p className="fv-canvas-earlier fv-canvas-say">Export button added.</p>
        <p className="fv-canvas-user">Why do European dates fail?</p>
        <p className="fv-canvas-say">
          Three of four formats pass. Fixing the parser now.
        </p>
        <p className="fv-canvas-swap fv-canvas-status">
          <span className="fv-canvas-working">Working…</span>
          <span className="fv-canvas-done">Fixed. All four formats pass.</span>
        </p>
        <div className="fv-canvas-composer">
          <p>Ask for a follow-up</p>
          <p className="fv-canvas-bar">
            <Glyph d="M12 5v14M5 12h14" />
            <Glyph
              className="fv-canvas-mark"
              d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"
            />
            <span className="fv-canvas-stop">
              <i />
              <Glyph d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
            </span>
          </p>
        </div>
      </section>
      <section className="fv-canvas-panel">
        <div className="fv-canvas-tabs">
          <span className="fv-canvas-tab">
            <Glyph d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
            Canvas
          </span>
          <Glyph d="M12 5v14M5 12h14" />
          <Glyph
            className="fv-canvas-end"
            d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6"
          />
        </div>
        <div className="fv-canvas-toolbar">
          <span className="fv-canvas-chip is-new">2 new</span>
          <span className="fv-canvas-chip is-updated">
            <span className="fv-canvas-count">
              <span>1</span>
              <span>2</span>
            </span>
            updated
          </span>
          <span className="fv-canvas-tools">
            <Glyph d="M4 7h6l2 2h8v10H4zM12 12v4M10 14h4" />
            <i />
            {TOOLS.map((tool) => (
              <Glyph key={tool} d={tool} />
            ))}
            <i />
            <Glyph d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />
            <Glyph d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18ZM12 7v5l3 2" />
            <i />
            <Glyph d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18ZM12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8Z" />
            <Glyph d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" />
          </span>
        </div>
        <div className="fv-canvas-board">
          <div className="fv-canvas-island is-blue">
            <p className="fv-canvas-head">
              <i />
              <span>Date parsing</span>
            </p>
            <h3 className="fv-canvas-question">Why do European dates fail?</h3>
            <div className="fv-canvas-node fv-canvas-chart is-new">
              <span className="fv-canvas-flag">New</span>
              <p className="fv-canvas-title">Tests passing</p>
              <ul className="fv-canvas-bars">
                {BARS.map((bar) => (
                  <li key={bar.name} className={bar.fix ? "is-fix" : ""}>
                    <i />
                    <span>{bar.name}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="fv-canvas-column">
              <div className="fv-canvas-node fv-canvas-parser">
                <span className="fv-canvas-ring" />
                <span className="fv-canvas-flag is-updated">Updated</span>
                <p className="fv-canvas-title">Parser fix</p>
                <p className="fv-canvas-swap fv-canvas-state">
                  <span>Running · 60%</span>
                  <span>Running · 80%</span>
                  <span className="is-done">Done · 100%</span>
                </p>
                <span className="fv-canvas-progress">
                  <i />
                </span>
                <p className="fv-canvas-body">Dots read as decimals.</p>
              </div>
              <div className="fv-canvas-node fv-canvas-code">
                <span className="fv-canvas-ring" />
                <span className="fv-canvas-flag is-updated">Updated</span>
                <p className="fv-canvas-swap fv-canvas-title">
                  <span>Failing case</span>
                  <span>Fixed case</span>
                </p>
                <pre>
                  parseDate("17.11.2026")
                  <br />
                  <span className="fv-canvas-pre-swap">
                    <b>→ Invalid Date</b>
                    <b className="is-ok">→ 2026-11-17</b>
                  </span>
                </pre>
              </div>
            </div>
          </div>
          <div className="fv-canvas-island is-teal">
            <p className="fv-canvas-head">
              <i />
              <span>Export format</span>
            </p>
            <h3 className="fv-canvas-question">Which columns go in?</h3>
            <div className="fv-canvas-node is-new">
              <span className="fv-canvas-flag">New</span>
              <p className="fv-canvas-title">Columns</p>
              <p className="fv-canvas-option is-pick">
                Date, client, amount
                <em>Recommended</em>
              </p>
              <p className="fv-canvas-option">Every column</p>
            </div>
          </div>
          <div className="fv-canvas-map">
            <i className="is-blue" />
            <i className="is-teal" />
            <i className="is-view" />
          </div>
          <div className="fv-canvas-zoom">
            <Glyph d="M5 12h14" />
            <span>80%</span>
            <Glyph d="M12 5v14M5 12h14" />
          </div>
        </div>
      </section>
    </div>
  );
}
