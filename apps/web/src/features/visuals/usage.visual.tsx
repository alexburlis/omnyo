export const label =
  "The Account usage popover, opened from the usage rings in Omnyo's bottom bar: the Codex studio account runs down to its limit, and the next ready account, spare, starts serving while the chat keeps running.";

interface Account {
  name: string;
  plan: string;
  left: number;
  pace: number;
  note: string;
  role: "serving" | "ready" | "draining" | "next";
}

interface Group {
  id: "claude" | "codex";
  name: string;
  accounts: readonly Account[];
}

const GROUPS: readonly Group[] = [
  {
    id: "claude",
    name: "Claude Code",
    accounts: [
      {
        name: "work",
        plan: "max",
        left: 64,
        pace: 58,
        note: "Nov 27",
        role: "serving",
      },
      {
        name: "personal",
        plan: "pro",
        left: 88,
        pace: 44,
        note: "Nov 25",
        role: "ready",
      },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    accounts: [
      {
        name: "studio",
        plan: "plus",
        left: 23,
        pace: 31,
        note: "Nov 24",
        role: "draining",
      },
      {
        name: "spare",
        plan: "plus",
        left: 76,
        pace: 52,
        note: "Nov 26",
        role: "next",
      },
    ],
  },
];

function Mark({ id }: { id: Group["id"] }) {
  if (id === "claude") {
    return (
      <svg className="fv-usage-mark fv-usage-mark--claude" viewBox="0 0 16 16">
        <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2M5.5 1.9l5 12.2M10.5 1.9l-5 12.2M1.9 5.5l12.2 5M1.9 10.5l12.2-5" />
      </svg>
    );
  }

  return (
    <svg className="fv-usage-mark fv-usage-mark--codex" viewBox="0 0 16 16">
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" />
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="3.5" ry="6.3" transform="rotate(120 8 8)" />
    </svg>
  );
}

function Meter({ account }: { account: Account }) {
  return (
    <span className="fv-usage-meter">
      <span className="fv-usage-fill">
        <i style={{ transform: `translateX(${account.left - 100}%)` }} />
      </span>
      <b style={{ left: `${account.pace}%` }} />
    </span>
  );
}

function Ring({ id }: { id: Group["id"] }) {
  const left = id === "claude" ? 64 : 23;

  return (
    <span className={`fv-usage-ring is-${id}`}>
      <span className="fv-usage-gauge">
        <svg viewBox="0 0 18 18">
          <circle className="fv-usage-track" cx="9" cy="9" r="7.5" />
          <circle
            className="fv-usage-arc"
            cx="9"
            cy="9"
            r="7.5"
            pathLength={100}
            strokeDasharray="100 100"
            strokeDashoffset={100 - left}
          />
        </svg>
        <Mark id={id} />
      </span>
      <span className="fv-usage-ring-value">
        {id === "claude" ? left : null}
        <small>%</small>
      </span>
    </span>
  );
}

export function Visual() {
  return (
    <div className="fv fv-usage" aria-hidden="true">
      <div className="fv-usage-main">
        <div className="fv-usage-thread">
          <p className="fv-usage-earlier fv-usage-ask">
            Add a CSV export to the invoices page.
          </p>
          <p className="fv-usage-earlier">
            I added an Export CSV button to the invoices toolbar and wrote the
            export in export.ts.
          </p>
          <p className="fv-usage-earlier fv-usage-tools">
            Edited 2 files, ran 1 command
          </p>
          <p className="fv-usage-say">
            The export keeps the column order you see on screen. Running the
            invoice suite before I hand it over.
          </p>
          <p className="fv-usage-tools fv-usage-running">
            Running pnpm test invoices
          </p>
          <div className="fv-usage-composer">
            <span>Ask for a follow-up</span>
            <i />
          </div>
        </div>
      </div>
      <footer className="fv-usage-bar">
        <span className="fv-usage-activity">
          <i className="fv-dot fv-dot--ok" />
          <b>3</b> running
          <span className="fv-usage-sep" />
          <i className="fv-dot fv-dot--attn" />
          <b>1</b> needs you
        </span>
        <span className="fv-usage-rings">
          <Ring id="claude" />
          <Ring id="codex" />
        </span>
        <span className="fv-usage-icons">
          <svg viewBox="0 0 16 16">
            <path d="M3 6.5v3M6 4v8M9 5.5v5M12 7v2" />
          </svg>
          <svg viewBox="0 0 16 16">
            <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
          </svg>
          <svg viewBox="0 0 16 16">
            <path d="M4.5 11.5V7.2a3.5 3.5 0 0 1 7 0v4.3l1 1h-9zM6.8 13.6a1.4 1.4 0 0 0 2.4 0" />
          </svg>
        </span>
      </footer>
      <section className="fv-usage-pop">
        <header className="fv-usage-head">
          <b>Account usage</b>
          <span>updated just now</span>
          <svg viewBox="0 0 24 24">
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
          </svg>
        </header>
        <div className="fv-usage-body">
          {GROUPS.map((group) => (
            <section key={group.id} className="fv-usage-group">
              <h4>
                <Mark id={group.id} />
                <span>{group.name}</span>
                {group.id === "codex" ? (
                  <small className="fv-usage-ready">
                    <span className="is-before">2 of 2 ready</span>
                    <span className="is-after">1 of 2 ready</span>
                  </small>
                ) : (
                  <small>2 of 2 ready</small>
                )}
              </h4>
              <ul>
                {group.accounts.map((account) => (
                  <li key={account.name} className={`is-${account.role}`}>
                    <i className="fv-usage-status" />
                    <span className="fv-usage-name">
                      {account.name}
                      <small>{account.plan}</small>
                    </span>
                    <Meter account={account} />
                    <span className="fv-usage-value">
                      {account.role === "draining" ? null : `${account.left}%`}
                    </span>
                    <span className="fv-usage-note">
                      <svg viewBox="0 0 10 10">
                        <circle cx="5" cy="5" r="3.9" />
                        <path d="M5 2.9V5l1.4 1" />
                      </svg>
                      {account.note}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="fv-usage-speed">
            <span>▸</span>
            <b>Codex speed</b>
            <small>Last 30 days</small>
          </p>
        </div>
      </section>
    </div>
  );
}
