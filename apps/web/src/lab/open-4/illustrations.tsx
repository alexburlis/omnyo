type Provider = "claude" | "codex";

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function ProviderDot({ provider }: { provider: Provider }) {
  return <span className={`dot dot--${provider}`} aria-hidden="true" />;
}

const THREADS: {
  title: string;
  branch: string;
  provider: Provider;
  state: string;
  active?: boolean;
}[] = [
  {
    title: "Export receipts as CSV",
    branch: "feat/receipt-export",
    provider: "claude",
    state: "Working",
    active: true,
  },
  {
    title: "Review: receipt export",
    branch: "feat/receipt-export",
    provider: "codex",
    state: "3 notes",
  },
  {
    title: "Date picker skips a day in Lisbon",
    branch: "fix/date-picker-tz",
    provider: "codex",
    state: "Done",
  },
  {
    title: "Weekday issue triage",
    branch: "main",
    provider: "claude",
    state: "Mon to Fri",
  },
  {
    title: "Upgrade the router",
    branch: "chore/router-7",
    provider: "claude",
    state: "Waiting on you",
  },
];

export function AppWindow() {
  return (
    <div
      className="window"
      role="img"
      aria-label="An illustrated Omnyo window. A sidebar lists five chats in a project called tidepool, run by Claude Code and Codex. The open chat shows Claude Code exporting receipts as CSV, with a running preview of the branch."
    >
      <div className="window-bar">
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="window-title">tidepool</span>
        <span className="window-spacer" />
      </div>
      <div className="window-body">
        <aside className="window-side">
          <div className="side-head">
            <span>Chats</span>
            <span className="side-new">+</span>
          </div>
          <ul>
            {THREADS.map((thread) => (
              <li
                key={thread.title}
                className={thread.active ? "is-active" : undefined}
              >
                <ProviderDot provider={thread.provider} />
                <span className="side-text">
                  <span className="side-title">{thread.title}</span>
                  <span className="side-meta">
                    {PROVIDER_LABEL[thread.provider]} · {thread.branch}
                  </span>
                </span>
                <span
                  className={`side-state${thread.state === "Working" ? " is-working" : ""}`}
                >
                  {thread.state}
                </span>
              </li>
            ))}
          </ul>
        </aside>
        <div className="window-main">
          <div className="main-head">
            <div>
              <div className="main-title">Export receipts as CSV</div>
              <div className="main-meta">
                <ProviderDot provider="claude" /> Claude Code ·
                feat/receipt-export
              </div>
            </div>
            <span className="preview-pill">
              <span className="pulse" aria-hidden="true" />
              Preview running
            </span>
          </div>
          <div className="bubble bubble--you">
            Add a CSV export to the receipts page. Keep the column order the
            same as the table.
          </div>
          <div className="bubble bubble--agent">
            <p>
              Added an Export button and a small serializer that reuses the
              table’s column config, so the order can’t drift.
            </p>
            <div className="tool">
              <span className="tool-icon" aria-hidden="true">
                ✎
              </span>
              <span className="tool-file">src/receipts/export-csv.ts</span>
              <span className="tool-diff">
                <b>+48</b> <s>−3</s>
              </span>
            </div>
            <div className="tool">
              <span className="tool-icon" aria-hidden="true">
                ▸
              </span>
              <span className="tool-file">pnpm test receipts</span>
              <span className="tool-ok">12 passed</span>
            </div>
          </div>
          <div className="composer">
            <span>Ask Codex to review this branch…</span>
            <span className="composer-send" aria-hidden="true">
              ↑
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReviewPair() {
  return (
    <div
      className="pair"
      role="img"
      aria-label="Two chats side by side. Claude Code builds the receipt export; Codex reviews it in its own chat, and you ask the reviewer a follow-up question."
    >
      <div className="pair-card pair-card--build">
        <div className="pair-head">
          <ProviderDot provider="claude" />
          <span>Claude Code</span>
          <em>builds</em>
        </div>
        <div className="pair-line">Export receipts as CSV</div>
        <div className="pair-steps">
          <span className="step step--done">Read receipts table</span>
          <span className="step step--done">Write serializer</span>
          <span className="step step--done">Add Export button</span>
          <span className="step step--done">Run tests</span>
        </div>
        <div className="pair-handoff">Hand off for review →</div>
      </div>
      <div className="pair-thread" aria-hidden="true">
        <svg viewBox="0 0 120 60" preserveAspectRatio="none">
          <path d="M0 30 C 40 30, 40 30, 60 30 S 100 30, 120 30" />
        </svg>
      </div>
      <div className="pair-card pair-card--review">
        <div className="pair-head">
          <ProviderDot provider="codex" />
          <span>Codex</span>
          <em>reviews</em>
        </div>
        <div className="note">
          <b>export-csv.ts:22</b> Amounts are formatted with the browser locale.
          A German browser writes 12,50 and breaks the CSV.
        </div>
        <div className="note note--you">
          <b>You</b> Would quoting the field be enough?
        </div>
        <div className="note">
          <b>Codex</b> Quoting fixes parsing, but totals would still sum wrong
          in a spreadsheet. Write plain decimals instead.
        </div>
      </div>
    </div>
  );
}

export function RouteDiagram() {
  return (
    <div className="route">
      <div className="route-stop">
        <div className="route-art route-art--mac" aria-hidden="true">
          <span className="mac-screen">
            <span />
            <span />
            <span />
          </span>
          <span className="mac-foot" />
        </div>
        <div className="route-label">Your Mac</div>
        <p>Where you write prompts and read the results.</p>
      </div>
      <div className="route-link" aria-hidden="true">
        <span className="route-dash" />
        <span className="route-token">prompts · code · files</span>
      </div>
      <div className="route-stop">
        <div className="route-art route-art--server" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="route-label">Your Omnyo server</div>
        <p>Runs on a machine you own and control.</p>
      </div>
      <div className="route-link" aria-hidden="true">
        <span className="route-dash" />
        <span className="route-token">requests</span>
      </div>
      <div className="route-stop">
        <div className="route-art route-art--cloud" aria-hidden="true">
          <span />
        </div>
        <div className="route-label">Your AI provider</div>
        <p>The one you choose. Your server sends requests straight there.</p>
      </div>
    </div>
  );
}

export function PhoneArt() {
  return (
    <div className="art art-phone" aria-hidden="true">
      <div className="phone">
        <div className="phone-notch" />
        <div className="phone-row">
          <ProviderDot provider="claude" />
          <span>Export receipts</span>
          <i className="is-working" />
        </div>
        <div className="phone-row">
          <ProviderDot provider="codex" />
          <span>Review notes</span>
          <i />
        </div>
        <div className="phone-bubble">Looks good. Merge it.</div>
        <div className="phone-input" />
      </div>
    </div>
  );
}

export function BranchArt() {
  return (
    <div className="art art-branch" aria-hidden="true">
      {[
        ["feat/receipt-export", "clay"],
        ["fix/date-picker-tz", "sage"],
        ["chore/router-7", "sky"],
      ].map(([branch, tone]) => (
        <div key={branch} className={`branch-row tone-${tone}`}>
          <span className="branch-name">{branch}</span>
          <span className="branch-link">
            <span className="pulse" />
            preview
          </span>
        </div>
      ))}
    </div>
  );
}

export function ScheduleArt() {
  const days = ["M", "T", "W", "T", "F", "S", "S"];

  return (
    <div className="art art-schedule" aria-hidden="true">
      <div className="cal">
        {days.map((day, index) => (
          <span
            key={`${day}-${index}`}
            className={index < 5 ? "cal-day is-on" : "cal-day"}
          >
            {day}
          </span>
        ))}
      </div>
      <div className="cal-task">
        <span className="cal-time">09:00</span>
        <span>Triage new issues</span>
      </div>
    </div>
  );
}

export function BrowserArt() {
  return (
    <div className="art art-browser" aria-hidden="true">
      <div className="mini-browser">
        <div className="mini-bar">
          <i />
          <i />
          <i />
          <span />
        </div>
        <div className="mini-page">
          <span className="mini-heading" />
          <span className="mini-line" />
          <span className="mini-line short" />
          <span className="mini-button">Export CSV</span>
          <span className="cursor" />
        </div>
      </div>
      <div className="shots">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function PluginArt() {
  return (
    <div className="art art-plugins" aria-hidden="true">
      <span className="block b1" />
      <span className="block b2" />
      <span className="block b3" />
      <span className="block b4" />
    </div>
  );
}
