import "./usage-tracking-order.css";

export const label =
  "The Claude section of Omnyo's Account Pooler page, with routing switched on. The work account has used 96% of its 5-hour window, so the personal account is dragged above it by its handle and is now first in line. The Anthropic API key stays last.";

interface Quota {
  label: string;
  used: string;
  tone: "ok" | "attn" | "dim";
}

interface AccountRow {
  id: string;
  name: string;
  tier: string;
  used: string;
  quotas: readonly Quota[];
  move: "up" | "down" | "stay";
}

const ROWS: readonly AccountRow[] = [
  {
    id: "work",
    name: "work",
    tier: "Max",
    used: "used 2m ago",
    quotas: [
      { label: "5H", used: "96%", tone: "attn" },
      { label: "7D", used: "71%", tone: "ok" },
    ],
    move: "down",
  },
  {
    id: "personal",
    name: "personal",
    tier: "Pro",
    used: "used 1d ago",
    quotas: [
      { label: "5H", used: "8%", tone: "ok" },
      { label: "7D", used: "34%", tone: "ok" },
    ],
    move: "up",
  },
  {
    id: "key",
    name: "api-fallback",
    tier: "API key",
    used: "never used",
    quotas: [
      { label: "5H", used: "—", tone: "dim" },
      { label: "7D", used: "—", tone: "dim" },
    ],
    move: "stay",
  },
];

function Handle() {
  return (
    <svg className="fv-uto-handle" viewBox="0 0 10 16">
      {[3, 8, 13].map((y) => (
        <g key={y}>
          <circle cx="3" cy={y} r="1.1" />
          <circle cx="7" cy={y} r="1.1" />
        </g>
      ))}
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-usage-tracking-order" aria-hidden="true">
      <header className="fv-uto-head">
        <div>
          <h3>Claude</h3>
          <p className="fv-dim">
            Claude Code threads on every machine route through these accounts.
          </p>
        </div>
        <span className="fv-uto-switch">
          <i />
        </span>
      </header>
      <div className="fv-uto-list">
        {ROWS.map((row) => (
          <div key={row.id} className={`fv-uto-row is-${row.move}`}>
            <Handle />
            <span className="fv-uto-name">
              <span className="fv-uto-line">
                <b>{row.name}</b>
                <span className="fv-uto-badge">{row.tier}</span>
              </span>
              <span className="fv-uto-status fv-dim">
                <i className="fv-dot fv-dot--ok" />
                Ready · {row.used}
              </span>
            </span>
            <span className="fv-uto-quotas">
              {row.quotas.map((quota) => (
                <span key={quota.label} className={`is-${quota.tone}`}>
                  <small>{quota.label}</small>
                  {quota.used}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <p className="fv-uto-note">
        <span className="fv-uto-next fv-mono">
          <span className="is-before">work → personal → api-fallback</span>
          <span className="is-after">personal → work → api-fallback</span>
        </span>
        <span className="fv-dim">New chats move on at 98%</span>
      </p>
    </div>
  );
}
