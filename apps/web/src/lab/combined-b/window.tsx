import type { ReactNode } from "react";

import type { ViewId } from "./content";

type Agent = "claude" | "codex";

type Tone = "run" | "wait" | "done" | "idle" | "sched";

const AGENT_NAME: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const PROJECTS: readonly {
  repo: string;
  threads: readonly {
    id: string;
    title: string;
    agent: Agent;
    tone: Tone;
    time: string;
  }[];
}[] = [
  {
    repo: "harbor-ledger",
    threads: [
      {
        id: "csv",
        title: "Add CSV export",
        agent: "claude",
        tone: "run",
        time: "now",
      },
      {
        id: "review",
        title: "Review CSV export",
        agent: "codex",
        tone: "wait",
        time: "2m",
      },
      {
        id: "dates",
        title: "Date parser tests",
        agent: "codex",
        tone: "done",
        time: "14m",
      },
      {
        id: "webhook",
        title: "Webhook retry backoff",
        agent: "claude",
        tone: "idle",
        time: "1h",
      },
    ],
  },
  {
    repo: "atlas-notes",
    threads: [
      {
        id: "triage",
        title: "Weekday issue triage",
        agent: "codex",
        tone: "sched",
        time: "9:00",
      },
      {
        id: "schema",
        title: "Tidy note schema",
        agent: "claude",
        tone: "idle",
        time: "Tue",
      },
    ],
  },
];

const SELECTED: Record<ViewId, readonly string[]> = {
  split: ["csv", "dates"],
  review: ["review"],
  preview: ["csv"],
  anywhere: ["csv"],
};

const TITLES: Record<ViewId, string> = {
  split: "harbor-ledger  ·  2 chats",
  review: "harbor-ledger  ·  Review",
  preview: "harbor-ledger  ·  Previews",
  anywhere: "harbor-ledger",
};

const VIEWS: readonly ViewId[] = ["split", "review", "preview", "anywhere"];

const ICONS = {
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.6-1.4L14 14",
  compose: "M3 13h3l7-7-3-3-7 7v3ZM9 4l3 3",
  sidebar: "M2.5 3.5h11v9h-11zM6 3.5v9",
  split: "M2.5 3.5h11v9h-11zM8 3.5v9",
  globe:
    "M2.5 8h11M8 2.5c2.2 2.4 2.2 8.6 0 11M8 2.5c-2.2 2.4-2.2 8.6 0 11M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z",
  clock: "M8 4.5V8l2.5 1.5M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z",
  plug: "M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0v-2ZM8 11v2.5",
  branch:
    "M5 3.5v9M5 9.5c0-2.5 6-1.5 6-4.5M11 5a1.5 1.5 0 1 0 0-.01M5 13a1.5 1.5 0 1 0 0-.01",
  file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  terminal: "M3.5 5.5 6.5 8l-3 2.5M8.5 11h4",
  arrow: "M3 8h10m0 0L9 4m4 4-4 4",
  send: "M8 13V3m0 0L4 7m4-4 4 4",
  check: "M3.5 8.5 6.5 11.5 12.5 4.5",
  link: "M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2L8 3.8M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1",
  wifi: "M2 6.5a9 9 0 0 1 12 0M4.2 8.8a6 6 0 0 1 7.6 0M6.4 11a3 3 0 0 1 3.2 0M8 13.2h.01",
  back: "M10 3.5 5.5 8l4.5 4.5",
  forward: "M6 3.5 10.5 8 6 12.5",
  reload: "M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10",
} as const;

function Icon({ d }: { d: string }) {
  return (
    <svg className="cb-ico" viewBox="0 0 16 16" focusable="false">
      <path d={d} />
    </svg>
  );
}

function AgentTag({ agent, pill = false }: { agent: Agent; pill?: boolean }) {
  return (
    <span className={`cb-agent cb-agent--${agent}${pill ? " is-pill" : ""}`}>
      <i />
      {AGENT_NAME[agent]}
    </span>
  );
}

function Branch({ name }: { name: string }) {
  return (
    <span className="cb-branch">
      <Icon d={ICONS.branch} />
      {name}
    </span>
  );
}

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`cb-status cb-status--${tone}`}>
      <span className={`cb-dot cb-dot--${tone}`} />
      {children}
    </span>
  );
}

function Sidebar({ view }: { view: ViewId }) {
  const selected = SELECTED[view];

  return (
    <aside className="cb-w-side">
      <div className="cb-w-search">
        <Icon d={ICONS.search} />
        <span>Search chats</span>
        <kbd>⌘K</kbd>
      </div>
      {PROJECTS.map((project) => (
        <div key={project.repo} className="cb-w-group">
          <p className="cb-w-repo">
            <span className="cb-w-repo-mark" />
            {project.repo}
          </p>
          <ul>
            {project.threads.map((thread) => (
              <li
                key={thread.id}
                className={selected.includes(thread.id) ? "is-selected" : ""}
              >
                <span className={`cb-dot cb-dot--${thread.tone}`} />
                <span className="cb-w-thread-title">{thread.title}</span>
                <span className="cb-w-thread-time">{thread.time}</span>
                <AgentTag agent={thread.agent} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="cb-w-side-foot">
        <p>
          <Icon d={ICONS.clock} />
          Automations
        </p>
        <p>
          <Icon d={ICONS.plug} />
          Plugins
        </p>
        <div className="cb-w-machine">
          <span className="cb-w-machine-dot" />
          <span>
            studio-mac
            <small>Your Omnyo server</small>
          </span>
        </div>
      </div>
    </aside>
  );
}

function Msg({ from, children }: { from: "you" | Agent; children: ReactNode }) {
  if (from === "you") {
    return (
      <div className="cb-m cb-m--you">
        <p>{children}</p>
      </div>
    );
  }

  return (
    <div className="cb-m cb-m--agent">
      <AgentTag agent={from} />
      <div className="cb-m-body">{children}</div>
    </div>
  );
}

function Tool({
  icon,
  children,
  meta,
}: {
  icon: keyof typeof ICONS;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="cb-tool">
      <Icon d={ICONS[icon]} />
      <span className="cb-tool-label">{children}</span>
      {meta ? <span className="cb-tool-meta">{meta}</span> : null}
    </div>
  );
}

function Diff({ add, del }: { add: number; del: number }) {
  return (
    <span className="cb-diff">
      <b>+{add}</b>
      {del > 0 ? <em>−{del}</em> : null}
    </span>
  );
}

function Composer({ agent }: { agent: Agent }) {
  return (
    <div className="cb-composer">
      <span className="cb-composer-field">Message {AGENT_NAME[agent]}</span>
      <span className="cb-composer-row">
        <AgentTag agent={agent} pill />
        <span className="cb-composer-send">
          <Icon d={ICONS.send} />
        </span>
      </span>
    </div>
  );
}

function ThreadHead({
  title,
  agent,
  branch,
  status,
  tone,
}: {
  title: string;
  agent: Agent;
  branch: string;
  status: string;
  tone: Tone;
}) {
  return (
    <header className="cb-th">
      <div className="cb-th-main">
        <strong>{title}</strong>
        <span className="cb-th-sub">
          <AgentTag agent={agent} pill />
          <Branch name={branch} />
        </span>
      </div>
      <Status tone={tone}>{status}</Status>
    </header>
  );
}

function CsvThread() {
  return (
    <section className="cb-pane">
      <ThreadHead
        title="Add CSV export"
        agent="claude"
        branch="feat/csv-export"
        status="Working"
        tone="run"
      />
      <div className="cb-pane-scroll">
        <Msg from="you">
          Add a CSV export to the invoices table. Keep the column order you see
          on screen.
        </Msg>
        <Msg from="claude">
          <p>
            I will add an <code>exportInvoices()</code> helper and an Export
            button to the toolbar.
          </p>
          <div className="cb-tools">
            <Tool icon="file" meta="InvoiceTable.tsx">
              Read
            </Tool>
            <Tool icon="compose" meta={<Diff add={64} del={0} />}>
              Edited <code>export.ts</code>
            </Tool>
            <Tool
              icon="terminal"
              meta={<span className="cb-ok">12 passed</span>}
            >
              Ran <code>pnpm test invoices</code>
            </Tool>
          </div>
        </Msg>
        <div className="cb-code" aria-hidden="true">
          <span className="cb-code-file">src/invoices/export.ts</span>
          <code>
            <span className="cb-ln">
              <b>+</b>
              <i>export function</i> exportInvoices(rows) {"{"}
            </span>
            <span className="cb-ln">
              <b>+</b>
              {"  "}
              <i>const</i> header = columns.map((c) =&gt; c.label)
            </span>
            <span className="cb-ln">
              <b>+</b>
              {"  "}
              <i>return</i> toCsv([header, ...rows.map(toRow)])
            </span>
          </code>
        </div>
        <div className="cb-typing">
          <span />
          <span />
          <span />
          Checking the empty state
        </div>
      </div>
      <Composer agent="claude" />
    </section>
  );
}

function DatesThread() {
  return (
    <section className="cb-pane">
      <ThreadHead
        title="Date parser tests"
        agent="codex"
        branch="fix/date-parser"
        status="Done"
        tone="done"
      />
      <div className="cb-pane-scroll">
        <Msg from="you">
          Cover the European date formats in <code>parseDate</code>.
        </Msg>
        <Msg from="codex">
          <p>
            Added nine cases for <code>dd.mm.yyyy</code> and{" "}
            <code>dd/mm/yyyy</code>, including leap days.
          </p>
          <div className="cb-tools">
            <Tool icon="compose" meta={<Diff add={48} del={2} />}>
              Edited <code>parseDate.test.ts</code>
            </Tool>
            <Tool
              icon="terminal"
              meta={<span className="cb-ok">9 passed</span>}
            >
              Ran <code>pnpm test parseDate</code>
            </Tool>
          </div>
        </Msg>
        <Msg from="you">Good. Leave the US formats as they are.</Msg>
        <Msg from="codex">
          <p>Understood. No changes to the US parser.</p>
        </Msg>
      </div>
      <Composer agent="codex" />
    </section>
  );
}

function SitePage({ variant = 0 }: { variant?: number }) {
  return (
    <div className={`cb-site cb-site--${variant}`} aria-hidden="true">
      <div className="cb-site-nav">
        <span className="cb-site-logo" />
        <span className="cb-site-link" />
        <span className="cb-site-link" />
        <span className="cb-site-btn">Export CSV</span>
      </div>
      <div className="cb-site-title">
        <strong>Invoices</strong>
        <span>March</span>
      </div>
      <div className="cb-site-table">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <span key={row} className="cb-site-row">
            <i />
            <i />
            <i />
            <b className={row % 3 === 1 ? "is-due" : ""} />
          </span>
        ))}
      </div>
    </div>
  );
}

function ViewSplit() {
  return (
    <div className="cb-v-split">
      <CsvThread />
      <DatesThread />
    </div>
  );
}

function ViewReview() {
  return (
    <div className="cb-v-review">
      <section className="cb-pane cb-pane--source">
        <ThreadHead
          title="Add CSV export"
          agent="claude"
          branch="feat/csv-export"
          status="Done"
          tone="done"
        />
        <div className="cb-pane-scroll">
          <Msg from="claude">
            <p>
              The export is in place. Columns follow the table order and the
              invoice tests pass.
            </p>
            <div className="cb-tools">
              <Tool icon="compose" meta={<Diff add={86} del={12} />}>
                Edited 4 files
              </Tool>
            </div>
          </Msg>
          <div className="cb-handoff">
            <span className="cb-handoff-line" />
            <span className="cb-handoff-chip">
              <AgentTag agent="codex" />
              Sent to Codex for review
            </span>
          </div>
        </div>
      </section>
      <section className="cb-pane cb-pane--review">
        <ThreadHead
          title="Review CSV export"
          agent="codex"
          branch="feat/csv-export"
          status="Waiting on you"
          tone="wait"
        />
        <div className="cb-pane-scroll">
          <Msg from="codex">
            <p>I read the diff and ran the export. Two findings:</p>
            <ol className="cb-findings">
              <li>
                <span className="cb-sev cb-sev--fix">Fix</span>
                <span>
                  Fields with commas are not quoted.
                  <code>export.ts:18</code>
                </span>
              </li>
              <li>
                <span className="cb-sev">Note</span>
                <span>
                  The file name ignores the month filter.
                  <code>InvoiceToolbar.tsx:41</code>
                </span>
              </li>
            </ol>
          </Msg>
          <Msg from="you">
            Quote the fields first. Is the file name worth a follow-up?
          </Msg>
          <Msg from="codex">
            <p>Yes, but small. Quoting is the change that breaks real files.</p>
          </Msg>
        </div>
        <Composer agent="codex" />
      </section>
    </div>
  );
}

const PREVIEWS = [
  { branch: "feat/csv-export", port: 5174, agent: "claude" as const },
  { branch: "fix/date-parser", port: 5175, agent: "codex" as const },
  { branch: "main", port: 5173, agent: null },
] as const;

function ViewPreview() {
  return (
    <div className="cb-v-preview">
      <section className="cb-previews">
        <header className="cb-previews-head">
          <strong>Previews</strong>
          <span>3 running</span>
        </header>
        <ul>
          {PREVIEWS.map((entry, index) => (
            <li key={entry.branch} className={index === 0 ? "is-selected" : ""}>
              <span className="cb-previews-top">
                <Branch name={entry.branch} />
                <span className="cb-live">
                  <i />
                  Live
                </span>
              </span>
              <span className="cb-previews-url">
                <Icon d={ICONS.link} />
                localhost:{entry.port}
              </span>
              {entry.agent ? (
                <AgentTag agent={entry.agent} />
              ) : (
                <span className="cb-previews-base">Base branch</span>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="cb-browser">
        <div className="cb-browser-bar">
          <span className="cb-browser-nav">
            <Icon d={ICONS.back} />
            <Icon d={ICONS.forward} />
            <Icon d={ICONS.reload} />
          </span>
          <span className="cb-browser-url">
            <Icon d={ICONS.link} />
            localhost:5174<em>/invoices</em>
          </span>
          <span className="cb-live">
            <i />
            Live
          </span>
        </div>
        <div className="cb-browser-page">
          <SitePage variant={1} />
        </div>
        <p className="cb-browser-foot">
          <Branch name="feat/csv-export" />
          <span>Dev server running</span>
        </p>
      </section>
    </div>
  );
}

function ViewAnywhere() {
  return (
    <div className="cb-v-anywhere">
      <section className="cb-pane">
        <ThreadHead
          title="Add CSV export"
          agent="claude"
          branch="feat/csv-export"
          status="Working"
          tone="run"
        />
        <div className="cb-pane-scroll">
          <Msg from="you">
            Add a CSV export to the invoices table. Keep the column order you
            see on screen.
          </Msg>
          <Msg from="claude">
            <p>
              The export works and the invoice tests pass. One question before I
              finish: should German invoices use semicolons as the separator?
            </p>
          </Msg>
          <Msg from="you">Yes, semicolons for the de-DE locale.</Msg>
          <div className="cb-remote-note">
            <Icon d={ICONS.wifi} />
            Replied from another device through Omnyo Connect
          </div>
        </div>
        <Composer agent="claude" />
      </section>
    </div>
  );
}

const VIEW_COMPONENTS: Record<ViewId, () => ReactNode> = {
  split: ViewSplit,
  review: ViewReview,
  preview: ViewPreview,
  anywhere: ViewAnywhere,
};

export function AppWindow({
  view,
  only = false,
}: {
  view: ViewId;
  only?: boolean;
}) {
  return (
    <div className={`cb-win is-${view}`} aria-hidden="true" data-win-frame>
      <div className="cb-win-titlebar">
        <span className="cb-traffic">
          <i />
          <i />
          <i />
        </span>
        <span className="cb-win-tools">
          <Icon d={ICONS.sidebar} />
          <Icon d={ICONS.compose} />
        </span>
        <span className="cb-win-title">{TITLES[view]}</span>
        <span className="cb-win-actions">
          {view === "anywhere" ? (
            <span className="cb-connect">
              <i />
              Connect on
            </span>
          ) : null}
          <Icon d={ICONS.split} />
          <Icon d={ICONS.globe} />
        </span>
      </div>
      <div className="cb-win-body">
        <Sidebar view={view} />
        <div className="cb-win-main">
          {(only ? [view] : VIEWS).map((id) => {
            const View = VIEW_COMPONENTS[id];

            return (
              <div
                key={id}
                className={`cb-v ${id === view ? "is-active" : ""}`}
              >
                <View />
              </div>
            );
          })}
        </div>
      </div>
      <div className="cb-win-spill" />
      <div className="cb-win-rim" />
    </div>
  );
}

export function Phone() {
  return (
    <div className="cb-phone" aria-hidden="true">
      <div className="cb-phone-screen">
        <div className="cb-phone-status">
          <span>9:41</span>
          <span className="cb-phone-island" />
          <span className="cb-phone-icons">
            <Icon d={ICONS.wifi} />
          </span>
        </div>
        <header className="cb-phone-head">
          <span className="cb-phone-back">
            <Icon d={ICONS.back} />
          </span>
          <span>
            <strong>Add CSV export</strong>
            <small>Claude Code · studio-mac</small>
          </span>
        </header>
        <div className="cb-phone-body">
          <Msg from="claude">
            <div className="cb-tools">
              <Tool icon="compose" meta={<Diff add={86} del={12} />}>
                Edited 4 files
              </Tool>
              <Tool
                icon="terminal"
                meta={<span className="cb-ok">12 passed</span>}
              >
                Ran tests
              </Tool>
            </div>
          </Msg>
          <Msg from="claude">
            <p>Should German invoices use semicolons as the separator?</p>
          </Msg>
          <Msg from="you">Yes, semicolons for the de-DE locale.</Msg>
          <div className="cb-typing">
            <span />
            <span />
            <span />
            Working
          </div>
        </div>
        <div className="cb-phone-input">
          <span>Reply to Claude Code</span>
          <i>
            <Icon d={ICONS.send} />
          </i>
        </div>
      </div>
    </div>
  );
}
