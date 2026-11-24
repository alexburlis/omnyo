import type { ReactNode } from "react";

type Agent = "claude" | "codex";

const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function AgentTag({ agent }: { agent: Agent }) {
  return (
    <span className={`e1-agent e1-agent--${agent}`}>
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
    <div className={`e1-msg e1-msg--${from === "you" ? "you" : "agent"}`}>
      <span className="e1-msg-from">
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
    <section className="e1-pane">
      <header className="e1-pane-head">
        <div>
          <strong>{title}</strong>
          <span className="e1-pane-sub">
            <AgentTag agent={agent} />
            <code>{branch}</code>
          </span>
        </div>
        <span className="e1-pane-status">{status}</span>
      </header>
      <div className="e1-pane-body">
        {children}
        {composer ? (
          <div className="e1-composer">
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
    <div className="e1-window">
      <aside className="e1-side">
        <div className="e1-side-repo">
          <span className="e1-side-dot" />
          harbor-ledger
        </div>
        <ul>
          {SIDEBAR_THREADS.map((thread, index) => (
            <li key={thread.title} className={index < 2 ? "is-open" : ""}>
              <span className={`e1-state e1-state--${thread.state}`} />
              <span className="e1-side-title">{thread.title}</span>
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
        <div className="e1-chip">
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
        <div className="e1-chip e1-chip--ok">
          <code>pnpm test parseDate</code> 9 passed
        </div>
      </Pane>
    </div>
  );
}

export function SceneReview() {
  return (
    <div className="e1-review">
      <div className="e1-review-card e1-review-card--build">
        <span className="e1-review-role">Builds</span>
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
          <div className="e1-chip">
            Edited 3 files <b>+112</b> <em>−9</em>
          </div>
        </Pane>
      </div>
      <div className="e1-review-link" aria-hidden="true">
        <span>Review in a new thread</span>
      </div>
      <div className="e1-review-card e1-review-card--check">
        <span className="e1-review-role">Reviews</span>
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
    <div className="e1-route">
      <div className="e1-route-line" aria-hidden="true">
        <span className="e1-pulse" />
        <span className="e1-pulse e1-pulse--late" />
      </div>
      <ol className="e1-route-nodes">
        <li>
          <span className="e1-node-index">01</span>
          <strong>Your Mac</strong>
          <span>The Omnyo app, where you write prompts and read diffs.</span>
        </li>
        <li className="e1-route-core">
          <span className="e1-node-index">02</span>
          <strong>Your Omnyo server</strong>
          <span>
            Runs on a machine you own. Prompts, code and files go here first.
          </span>
        </li>
        <li>
          <span className="e1-node-index">03</span>
          <strong>Your AI provider</strong>
          <span>The one you choose for Claude Code or Codex.</span>
        </li>
      </ol>
      <p className="e1-route-note">Nothing hosted by us in between</p>
    </div>
  );
}

export function SceneAnywhere() {
  return (
    <div className="e1-away">
      <div className="e1-away-desk">
        <span className="e1-away-label">On your Mac</span>
        <div className="e1-away-row">
          <span className="e1-state e1-state--run" />
          Add CSV export
          <AgentTag agent="claude" />
        </div>
        <div className="e1-away-row">
          <span className="e1-state e1-state--done" />
          Date parser tests
          <AgentTag agent="codex" />
        </div>
      </div>
      <div className="e1-phone">
        <div className="e1-phone-notch" />
        <header>
          <strong>Add CSV export</strong>
          <AgentTag agent="claude" />
        </header>
        <Message from="claude">
          The export works. Should German invoices use semicolons as the
          separator?
        </Message>
        <Message from="you">Yes, semicolons for the de-DE locale.</Message>
        <div className="e1-phone-input">
          <span>Reply to Claude Code</span>
          <i />
        </div>
      </div>
    </div>
  );
}
