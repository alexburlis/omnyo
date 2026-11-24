import type { ReactNode } from "react";

type Agent = "claude" | "codex";

const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function AgentTag({ agent }: { agent: Agent }) {
  return (
    <span className={`e3-agent e3-agent--${agent}`}>
      <i />
      {AGENT_LABEL[agent]}
    </span>
  );
}

function Message({
  from,
  children,
}: {
  from: "you" | Agent;
  children: ReactNode;
}) {
  return (
    <div className={`e3-msg e3-msg--${from === "you" ? "you" : "agent"}`}>
      <span className="e3-msg-from">
        {from === "you" ? "You" : AGENT_LABEL[from]}
      </span>
      <p>{children}</p>
    </div>
  );
}

function Pane({
  title,
  agent,
  branch,
  status,
  composer = false,
  children,
}: {
  composer?: boolean;
  title: string;
  agent: Agent;
  branch: string;
  status: string;
  children: ReactNode;
}) {
  return (
    <section className="e3-pane">
      <header className="e3-pane-head">
        <div>
          <strong>{title}</strong>
          <span className="e3-pane-sub">
            <AgentTag agent={agent} />
            <code>{branch}</code>
          </span>
        </div>
        <span className="e3-pane-status">{status}</span>
      </header>
      <div className="e3-pane-body">
        {children}
        {composer ? (
          <div className="e3-composer">
            <span>Message {AGENT_LABEL[agent]}</span>
            <kbd>⏎</kbd>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const SIDEBAR_THREADS = [
  { title: "Add CSV export", agent: "claude", state: "run" },
  { title: "Date parser tests", agent: "codex", state: "done" },
  { title: "Review webhook retry", agent: "claude", state: "idle" },
  { title: "Tidy invoice types", agent: "codex", state: "idle" },
] as const;

export function SceneSideBySide() {
  return (
    <div className="e3-window">
      <aside className="e3-side">
        <div className="e3-side-repo">
          <span className="e3-side-dot" />
          harbor-ledger
        </div>
        <ul>
          {SIDEBAR_THREADS.map((thread, index) => (
            <li key={thread.title} className={index < 2 ? "is-open" : ""}>
              <span className={`e3-state e3-state--${thread.state}`} />
              <span className="e3-side-title">{thread.title}</span>
              <AgentTag agent={thread.agent} />
            </li>
          ))}
        </ul>
      </aside>
      <Pane
        title="Add CSV export"
        agent="claude"
        branch="feat/csv-export"
        status="Working"
        composer
      >
        <Message from="you">
          Add a CSV export to the invoices table. Keep the column order you see
          on screen.
        </Message>
        <Message from="claude">
          Added <code>exportInvoices()</code> and an Export button in{" "}
          <code>InvoiceToolbar</code>. Columns follow the table order.
        </Message>
        <div className="e3-chip">
          Edited 4 files <b>+86</b> <em>−12</em>
        </div>
      </Pane>
      <Pane
        title="Date parser tests"
        agent="codex"
        branch="fix/date-parser"
        status="Done"
        composer
      >
        <Message from="you">
          Cover the European date formats in <code>parseDate</code>.
        </Message>
        <Message from="codex">
          Added nine cases for <code>dd.mm.yyyy</code> and{" "}
          <code>dd/mm/yyyy</code>. The parser suite passes.
        </Message>
        <div className="e3-chip e3-chip--ok">
          <code>pnpm test parseDate</code> 9 passed
        </div>
      </Pane>
    </div>
  );
}

export function SceneReview() {
  return (
    <div className="e3-review">
      <div className="e3-review-card e3-review-card--build">
        <span className="e3-review-role">Builds</span>
        <Pane
          title="Webhook retry"
          agent="codex"
          branch="feat/webhook-retry"
          status="Done"
        >
          <Message from="codex">
            Retries failed deliveries up to <code>maxAttempts</code> times.
            Added <code>deliverWithRetry()</code> and three tests.
          </Message>
          <div className="e3-chip">
            Edited 3 files <b>+112</b> <em>−9</em>
          </div>
        </Pane>
      </div>
      <div className="e3-review-link" aria-hidden="true">
        <span>Review in a new thread</span>
      </div>
      <div className="e3-review-card e3-review-card--check">
        <span className="e3-review-role">Reviews</span>
        <Pane
          title="Review webhook retry"
          agent="claude"
          branch="feat/webhook-retry"
          status="Waiting on you"
        >
          <Message from="claude">
            Two notes. The retry loop never backs off, so a failing endpoint is
            hit five times in a second. <code>maxAttempts</code> is read from
            the request body without a limit.
          </Message>
          <Message from="you">
            Fix the backoff first. Leave the limit for a follow-up.
          </Message>
          <Message from="claude">
            Agreed. Exponential backoff from 500 ms is the smallest change.
          </Message>
        </Pane>
      </div>
    </div>
  );
}

export function SceneMachines() {
  return (
    <div className="e3-route">
      <div className="e3-syzygy" aria-hidden="true">
        <span className="e3-body e3-body--mac" />
        <span className="e3-body e3-body--server" />
        <span className="e3-body e3-body--provider" />
      </div>
      <div className="e3-route-line" aria-hidden="true">
        <span className="e3-pulse" />
        <span className="e3-pulse e3-pulse--late" />
      </div>
      <ol className="e3-route-nodes">
        <li>
          <span className="e3-node-index">01</span>
          <strong>Your Mac</strong>
          <span>The Omnyo app, where you write prompts and read diffs.</span>
        </li>
        <li className="e3-route-core">
          <span className="e3-node-index">02</span>
          <strong>Your Omnyo server</strong>
          <span>
            Runs on a machine you own. Prompts, code and files go here first.
          </span>
        </li>
        <li>
          <span className="e3-node-index">03</span>
          <strong>Your AI provider</strong>
          <span>The one you choose for Claude Code or Codex.</span>
        </li>
      </ol>
      <p className="e3-route-note">Nothing hosted by us in between</p>
    </div>
  );
}

export function SceneAnywhere() {
  return (
    <div className="e3-away">
      <div className="e3-away-desk">
        <span className="e3-away-label">On your Mac</span>
        <div className="e3-away-row">
          <span className="e3-state e3-state--run" />
          Add CSV export
          <AgentTag agent="claude" />
        </div>
        <div className="e3-away-row">
          <span className="e3-state e3-state--done" />
          Date parser tests
          <AgentTag agent="codex" />
        </div>
      </div>
      <div className="e3-away-arc" aria-hidden="true" />
      <div className="e3-phone">
        <div className="e3-phone-notch" />
        <header>
          <strong>Add CSV export</strong>
          <AgentTag agent="claude" />
        </header>
        <Message from="claude">
          The export works. Should German invoices use semicolons as the
          separator?
        </Message>
        <Message from="you">Yes, semicolons for the de-DE locale.</Message>
        <div className="e3-phone-input">
          <span>Reply to Claude Code</span>
          <i />
        </div>
      </div>
    </div>
  );
}

export function StripPreview() {
  return (
    <div className="e3-mini e3-mini--preview">
      {[
        ["feat/csv-export", ":5174"],
        ["fix/date-parser", ":5175"],
        ["feat/webhook-retry", ":5176"],
      ].map(([branch, port]) => (
        <div key={branch} className="e3-mini-row">
          <code>{branch}</code>
          <span className="e3-live">
            <i />
            Preview {port}
          </span>
        </div>
      ))}
    </div>
  );
}

export function StripSchedule() {
  return (
    <div className="e3-mini e3-mini--schedule">
      <div className="e3-mini-days">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
          <span key={`${day}${index}`} className={index < 5 ? "is-on" : ""}>
            {day}
          </span>
        ))}
      </div>
      <div className="e3-mini-job">
        <code>09:00</code>
        <span>Triage new issues</span>
        <AgentTag agent="codex" />
      </div>
    </div>
  );
}

export function StripBrowser() {
  return (
    <div className="e3-mini e3-mini--browser">
      <div className="e3-mini-bar">
        <i />
        <i />
        <i />
        <span>localhost:5174/invoices</span>
      </div>
      <div className="e3-mini-shots">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

const PLUGIN_GLYPHS = [
  "M3.5 5.5 6.5 8l-3 2.5M8.5 11h4",
  "M3.5 12.5v-3M8 12.5v-8M12.5 12.5v-5",
  "M2.5 8h11M8 2.5c2.2 2.4 2.2 8.6 0 11M8 2.5c-2.2 2.4-2.2 8.6 0 11M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z",
  "M3 4.5h10v8.5H3zM3 7.5h10M5.5 3v3M10.5 3v3",
  "M8 4v8M4 8h8",
  "M5 3.5v9M5 9.5c0-2.5 6-1.5 6-4.5M11 5a1.5 1.5 0 1 0 0-.01",
];

export function StripPlugins() {
  return (
    <div className="e3-mini e3-mini--plugins">
      {PLUGIN_GLYPHS.map((glyph, index) => (
        <span key={glyph} className={index === 4 ? "is-new" : ""}>
          <svg viewBox="0 0 16 16" focusable="false">
            <path d={glyph} />
          </svg>
        </span>
      ))}
    </div>
  );
}
