import "./canvas-dashboard.css";

export const label =
  "The harbor-ledger project canvas: an Overview section with a weekly signups metric and a pageviews chart fed by PostHog, and a table of top Search Console queries. The PostHog source refreshes, the metric ticks up and the chart gains a new day, while the Release section is locked for agents.";

const POINTS = [
  [0, 46],
  [20, 40],
  [40, 43],
  [60, 31],
  [80, 34],
  [100, 24],
  [120, 27],
  [140, 16],
] as const;

const NEXT = [160, 9] as const;

const line = POINTS.map(([x, y]) => `${x},${y}`).join(" ");

const QUERIES = [
  { query: "csv export invoices", clicks: "182" },
  { query: "de-DE date format", clicks: "96" },
  { query: "harbor ledger api", clicks: "41" },
] as const;

export function Visual() {
  return (
    <div className="fv fv-canvas-dashboard" aria-hidden="true">
      <header className="fv-canvas-dashboard-bar">
        <b>harbor-ledger</b>
        <span className="fv-canvas-dashboard-tab is-on">Overview</span>
        <span className="fv-canvas-dashboard-tab">
          <svg viewBox="0 0 16 16">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
            <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
          </svg>
          Release
        </span>
        <span className="fv-canvas-dashboard-tab">Support</span>
        <span className="fv-canvas-dashboard-tool">
          Contents <kbd>C</kbd>
        </span>
      </header>
      <div className="fv-canvas-dashboard-board">
        <section className="fv-canvas-dashboard-card is-metric">
          <p className="fv-canvas-dashboard-title">Weekly signups</p>
          <p className="fv-canvas-dashboard-number">
            <span className="is-before">1,284</span>
            <span className="is-after">1,317</span>
          </p>
          <p className="fv-canvas-dashboard-delta">+2.6% on last week</p>
          <p className="fv-canvas-dashboard-source">
            <i className="fv-canvas-dashboard-spin" />
            <span className="fv-canvas-dashboard-swap">
              <span className="is-before">PostHog · refreshing…</span>
              <span className="is-after">PostHog · just now</span>
            </span>
          </p>
        </section>
        <section className="fv-canvas-dashboard-card is-chart">
          <p className="fv-canvas-dashboard-title">
            Pageviews <span>last 14 days</span>
          </p>
          <svg viewBox="0 0 170 52">
            <polyline
              className="fv-canvas-dashboard-area"
              points={`0,52 ${line} 140,52`}
            />
            <polyline className="fv-canvas-dashboard-line" points={line} />
            <g className="fv-canvas-dashboard-next">
              <line x1="140" y1="16" x2={NEXT[0]} y2={NEXT[1]} />
              <circle cx={NEXT[0]} cy={NEXT[1]} r="2.6" />
            </g>
          </svg>
        </section>
        <section className="fv-canvas-dashboard-card is-table">
          <p className="fv-canvas-dashboard-title">
            Top queries <span>Search Console</span>
          </p>
          <ul>
            {QUERIES.map((row) => (
              <li key={row.query}>
                <span>{row.query}</span>
                <b>{row.clicks}</b>
              </li>
            ))}
          </ul>
        </section>
        <section className="fv-canvas-dashboard-card is-note">
          <p className="fv-canvas-dashboard-title">Decision</p>
          <p>Ship CSV export behind a flag until de-DE dates pass.</p>
        </section>
      </div>
    </div>
  );
}
