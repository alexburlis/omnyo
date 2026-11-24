import "./app-mock.css";

import { type ReactNode, memo } from "react";

export type MockView =
  | "overview"
  | "split"
  | "review"
  | "preview"
  | "schedule"
  | "anywhere";

type IconName =
  | "sidebar"
  | "back"
  | "forward"
  | "more"
  | "branch"
  | "list"
  | "panel"
  | "inbox"
  | "person"
  | "plus"
  | "grid"
  | "loop"
  | "bolt"
  | "plug"
  | "gear"
  | "compose"
  | "terminal"
  | "file"
  | "pencil"
  | "globe"
  | "chevron"
  | "shield"
  | "mic"
  | "up"
  | "folder"
  | "calendar"
  | "expand"
  | "close"
  | "robot"
  | "search"
  | "sliders"
  | "bell"
  | "layers"
  | "phone";

type Agent = "claude" | "codex";

interface Tool {
  icon: IconName;
  text: string;
  stat?: string;
}

const OPEN_THREADS = [
  "Weekday issue triage",
  "Fix invoice rounding",
  "Tidy note schema",
  "Webhook retry backoff",
] as const;

const TITLES: Record<MockView, { title: string; place: string }> = {
  overview: { title: "Add CSV export", place: "harbor-ledger · studio-mac" },
  split: { title: "Add CSV export", place: "harbor-ledger · studio-mac" },
  review: { title: "Add CSV export", place: "harbor-ledger · studio-mac" },
  preview: { title: "Add CSV export", place: "harbor-ledger · studio-mac" },
  schedule: { title: "Automations", place: "All projects" },
  anywhere: { title: "Add CSV export", place: "harbor-ledger · studio-mac" },
};

const GLANCE: Record<MockView, string> = {
  overview: "Export works; tests running for the invoice table",
  split: "Claude builds the export while Codex covers dates",
  review: "Codex is reviewing the export read-only",
  preview: "The preview runs at localhost:5174",
  schedule: "4 automations installed",
  anywhere: "Answered from your phone; finishing the export",
};

function Icon({ name }: { name: IconName }) {
  return <i aria-hidden="true" className={`am-i am-i--${name}`} />;
}

function AgentMark({ agent }: { agent: Agent }) {
  return <i aria-hidden="true" className={`am-agent am-agent--${agent}`} />;
}

function Composer({
  agent = "claude",
  working = false,
  placeholder = "Ask for a follow-up. @ to mention files, folders, sections, or threads",
}: {
  agent?: Agent;
  working?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="am-composer">
      <p className="am-composer-input">{placeholder}</p>
      <p className="am-composer-bar">
        <Icon name="plus" />
        <span className="am-model">
          <AgentMark agent={agent} />
          {agent === "claude" ? "Opus 5.5 Medium" : "Codex"}
        </span>
        <Icon name="bolt" />
        <span className="am-composer-right">
          <Icon name="shield" />
          <Icon name="mic" />
          <span className={`am-send ${working ? "is-working" : ""}`}>
            <Icon name="up" />
          </span>
        </span>
      </p>
    </div>
  );
}

function Tools({ summary, rows }: { summary: string; rows: readonly Tool[] }) {
  return (
    <div className="am-tools">
      <p className="am-tools-head">
        {summary}
        <Icon name="chevron" />
      </p>
      {rows.map((row) => (
        <p className="am-tool" key={row.text}>
          <Icon name={row.icon} />
          {row.text}
          {row.stat ? <span className="am-stat">{row.stat}</span> : null}
        </p>
      ))}
    </div>
  );
}

function User({ children, meta }: { children: ReactNode; meta?: string }) {
  return (
    <>
      <p className="am-user">{children}</p>
      {meta ? <p className="am-meta am-meta--end">{meta}</p> : null}
    </>
  );
}

function PaneHead({
  agent,
  title,
  branch,
}: {
  agent: Agent;
  title: string;
  branch: string;
}) {
  return (
    <p className="am-pane-head">
      <span className="am-chip">
        <AgentMark agent={agent} />
        {title}
      </span>
      <Icon name="more" />
      <span className="am-branch am-branch--small">
        <Icon name="branch" />
        {branch}
      </span>
      <Icon name="expand" />
      <Icon name="close" />
    </p>
  );
}

const CSV_TOOLS: readonly Tool[] = [
  { icon: "file", text: "Read InvoiceTable.tsx" },
  { icon: "pencil", text: "Edited export.ts", stat: "+64" },
  { icon: "pencil", text: "Edited InvoiceToolbar.tsx", stat: "+22 −12" },
  { icon: "terminal", text: "Ran pnpm test invoices", stat: "12 passed" },
];

function Overview() {
  return (
    <div className="am-thread">
      <User meta="4m ago">
        Add a CSV export to the invoices table. Keep the column order you see on
        screen.
      </User>
      <Tools
        summary="Explored 3 files, edited 2, ran 1 command"
        rows={CSV_TOOLS}
      />
      <p className="am-say">
        The export follows the on-screen column order. Running the full invoice
        suite before I hand it over.
      </p>
      <p className="am-working">Working…</p>
      <Composer working />
    </div>
  );
}

function Split() {
  return (
    <div className="am-split">
      <section className="am-pane">
        <PaneHead
          agent="claude"
          title="Add CSV export"
          branch="feat/csv-export"
        />
        <div className="am-thread">
          <Tools
            summary="Edited 2 files, ran 1 command"
            rows={CSV_TOOLS.slice(1)}
          />
          <p className="am-say">
            Export works and matches the column order on screen.
          </p>
          <p className="am-working">Working…</p>
          <Composer working />
        </div>
      </section>
      <section className="am-pane">
        <PaneHead
          agent="codex"
          title="Date parser tests"
          branch="fix/date-parser"
        />
        <div className="am-thread">
          <User>Cover European date formats in the parser tests.</User>
          <Tools
            summary="Read 1 file, ran 2 commands"
            rows={[
              { icon: "file", text: "Read parseDate.ts" },
              {
                icon: "terminal",
                text: "Ran pnpm vitest dates",
                stat: "9 passed",
              },
            ]}
          />
          <p className="am-say">
            Nine cases now cover dd.mm.yyyy, dd/mm/yyyy and ISO dates.
          </p>
          <Composer agent="codex" />
        </div>
      </section>
    </div>
  );
}

function Review() {
  return (
    <div className="am-split">
      <section className="am-pane">
        <PaneHead
          agent="claude"
          title="Add CSV export"
          branch="feat/csv-export"
        />
        <div className="am-thread">
          <p className="am-child">
            <Icon name="robot" />
            <span>Review: Add CSV export</span> finished
            <span className="am-meta">2m ago</span>
          </p>
          <p className="am-say">
            Codex found one serious issue: quotes inside notes break the CSV.
            Fixing that now; the two minor ones are noted for you.
          </p>
          <Tools
            summary="Running 2 commands"
            rows={[
              { icon: "pencil", text: "Edited export.ts", stat: "+9 −2" },
              { icon: "terminal", text: "Ran pnpm test invoices" },
            ]}
          />
          <p className="am-working">Working…</p>
          <Composer working />
        </div>
      </section>
      <section className="am-pane">
        <PaneHead
          agent="codex"
          title="Review: Add CSV export"
          branch="feat/csv-export"
        />
        <div className="am-thread am-review">
          <p className="am-h">Serious</p>
          <p className="am-li">
            <code>export.ts:41</code> quotes inside a note are not escaped, so
            the row splits in two.
          </p>
          <p className="am-h">Minor</p>
          <p className="am-li">
            <code>export.ts:18</code> the file name ignores the month filter.
          </p>
          <p className="am-li">
            <code>InvoiceToolbar.tsx:52</code> the button has no busy state.
          </p>
          <p className="am-say">I didn&apos;t edit any files.</p>
          <p className="am-parent">
            <Icon name="person" />
            Parent <span>Add CSV export</span>
          </p>
        </div>
      </section>
    </div>
  );
}

function Preview() {
  return (
    <div className="am-thread">
      <Tools
        summary="Ran 3 commands"
        rows={[
          { icon: "terminal", text: "Ran pnpm dev --port 5174" },
          {
            icon: "terminal",
            text: "Ran omnyo preview register --url http://127.0.0.1:5174/",
          },
          {
            icon: "globe",
            text: "Opened localhost:5174/invoices in the browser",
          },
        ]}
      />
      <div className="am-browser">
        <p className="am-browser-bar">
          <Icon name="globe" />
          harbor-ledger <span>localhost:5174/invoices</span>
          <span className="am-live">Live</span>
          <Icon name="expand" />
        </p>
        <div className="am-page">
          <p className="am-page-top">
            <b>Invoices</b>
            <span className="am-page-button">Export CSV</span>
          </p>
          <div className="am-page-table" />
        </div>
      </div>
      <p className="am-say">
        The preview is online at localhost:5174. Export CSV downloads all four
        rows in the order shown.
      </p>
      <p className="am-server">
        <i className="am-dot am-dot--ok" />
        localhost:5174
        <span>Running · studio-mac</span>
        <b>Open</b>
      </p>
      <Composer />
    </div>
  );
}

function Anywhere() {
  return (
    <div className="am-thread">
      <p className="am-say">
        The export works and the tests pass. One question before I finish:
        should German invoices use semicolons as the separator?
      </p>
      <User meta="Sent from your phone · 1m ago">
        Yes, semicolons for de-DE.
      </User>
      <Tools
        summary="Edited 1 file, ran 1 command"
        rows={[
          { icon: "pencil", text: "Edited export.ts", stat: "+6" },
          {
            icon: "terminal",
            text: "Ran pnpm test invoices",
            stat: "13 passed",
          },
        ]}
      />
      <p className="am-finished">
        <b>Finished:</b> CSV export with semicolons for de-DE invoices.
      </p>
      <Composer />
    </div>
  );
}

const AUTOMATIONS = [
  {
    title: "Weekday issue triage",
    project: "atlas-notes",
    when: "9:00 Mon–Fri",
    next: "Tomorrow, 9:00",
    on: true,
  },
  {
    title: "Nightly test run",
    project: "harbor-ledger",
    when: "2:00 daily",
    next: "Tonight, 2:00",
    on: true,
  },
  {
    title: "Dependency check",
    project: "harbor-ledger",
    when: "8:00 Mon",
    next: "Mon, 8:00",
    on: true,
  },
  {
    title: "Draft release notes",
    project: "harbor-ledger",
    when: "One time",
    next: "Fri, 16:00",
    on: false,
  },
] as const;

function Schedule() {
  return (
    <div className="am-autos">
      <p className="am-crumbs">
        Automations <span>›</span> <b>Installed</b>
        <Icon name="close" />
      </p>
      <p className="am-autos-intro">
        Scheduled Omnyo work across projects. Automations run recurring or
        one-time tasks without manual prompting.
      </p>
      <p className="am-autos-bar">
        <span className="am-tab is-on">
          Installed <span>4</span>
        </span>
        <span className="am-tab">Browse</span>
        <span className="am-new">
          <Icon name="compose" />
          New automation
        </span>
      </p>
      <p className="am-search">
        <Icon name="search" />
        Search automations
      </p>
      <ul className="am-auto-list">
        {AUTOMATIONS.map((auto) => (
          <li className="am-auto" key={auto.title}>
            <Icon name="calendar" />
            <b>{auto.title}</b>
            <span className="am-auto-meta">
              {auto.project} · {auto.when} · next {auto.next}
            </span>
            <span className={`am-toggle ${auto.on ? "is-on" : ""}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const VIEWS: Record<MockView, () => ReactNode> = {
  overview: Overview,
  split: Split,
  review: Review,
  preview: Preview,
  schedule: Schedule,
  anywhere: Anywhere,
};

const Sidebar = memo(function Sidebar({ review }: { review: boolean }) {
  return (
    <aside className="am-side">
      <p className="am-row am-row--cmd">
        <Icon name="compose" />
        New thread
        <span className="am-count am-count--attn">{review ? 0 : 1}</span>
        <span className="am-count am-count--ok">{review ? 3 : 2}</span>
      </p>
      <p className="am-row am-row--cmd">
        <Icon name="grid" />
        Canvas
      </p>
      <p className="am-head">
        Running <span>{review ? 3 : 2}</span>
      </p>
      <p className="am-row is-unread is-selected">
        <i className="am-spin" />
        Add CSV export
        {review ? (
          <span className="am-kids">
            <Icon name="robot" />1
          </span>
        ) : null}
      </p>
      {review ? (
        <p className="am-row am-row--child">
          <i className="am-spin" />
          Review: Add CSV export
        </p>
      ) : null}
      <p className="am-row is-unread">
        <i className="am-spin" />
        Date parser tests
      </p>
      {review ? null : (
        <>
          <p className="am-head am-head--attn">
            Needs you <span>1</span>
          </p>
          <p className="am-row is-unread am-row--needs">
            <i className="am-dot am-dot--attn" />
            Review: Add CSV export
          </p>
        </>
      )}
      <p className="am-head">
        Open <span>{OPEN_THREADS.length}</span>
      </p>
      {OPEN_THREADS.map((title) => (
        <p className="am-row" key={title}>
          {title}
        </p>
      ))}
    </aside>
  );
});

export function AppMock({ view }: { view: MockView }) {
  const View = VIEWS[view];
  const head = TITLES[view];
  const full = view === "schedule";

  return (
    <div className={`am is-${view}`} aria-hidden="true">
      <div className="am-top">
        <Icon name="sidebar" />
        <Icon name="back" />
        <Icon name="forward" />
        <p className="am-title">
          <b>{head.title}</b>
          <span>{head.place}</span>
        </p>
        {full ? null : (
          <>
            <Icon name="more" />
            <p className="am-glance">
              <i className="am-dot" />
              {GLANCE[view]}
            </p>
            <p className="am-branch">
              <Icon name="branch" />
              feat/csv-export
            </p>
          </>
        )}
        {view === "anywhere" ? (
          <p className="am-connect">
            <i className="am-dot am-dot--ok" />
            Connect on
          </p>
        ) : null}
        <span className="am-top-right">
          <Icon name="list" />
          <Icon name="panel" />
        </span>
      </div>
      <nav className="am-rail">
        <span className="am-rail-icon has-badge">
          <Icon name="inbox" />
        </span>
        <span className="am-avatar am-avatar--me">
          <Icon name="person" />
        </span>
        <span className="am-avatar am-avatar--hl has-badge">hl</span>
        <span className="am-avatar am-avatar--an">an</span>
        <span className="am-avatar am-avatar--add">
          <Icon name="plus" />
        </span>
        <span className="am-rail-foot">
          <Icon name="grid" />
          <Icon name="loop" />
          <Icon name="plug" />
          <Icon name="gear" />
        </span>
      </nav>
      <div className={`am-panel ${full ? "is-full" : ""}`}>
        {full ? null : <Sidebar review={view === "review"} />}
        <main className="am-main" key={view}>
          <View />
        </main>
      </div>
      <p className="am-status">
        <span className="am-filters">
          <b>
            All <span>9</span>
          </b>
          Fix <span>2</span> Build <span>4</span> Ship <span>1</span>
        </span>
        <span className="am-tally">
          <i className="am-dot am-dot--ok" />2
          <i className="am-dot am-dot--attn" />
          {view === "review" ? 0 : 1}
        </span>
        <Icon name="bell" />
      </p>
    </div>
  );
}

export function PhoneMock() {
  return (
    <div className="am-phone" aria-hidden="true">
      <div className="am-phone-screen">
        <p className="am-phone-head">
          <Icon name="sidebar" />
          <b>Add CSV export</b>
          <Icon name="more" />
          <Icon name="branch" />
          <Icon name="panel" />
        </p>
        <p className="am-say">
          One question before I finish: should German invoices use semicolons as
          the separator?
        </p>
        <p className="am-user">Yes, semicolons for de-DE.</p>
        <p className="am-meta am-meta--end">Just now</p>
        <p className="am-tools-head">
          Edited 1 file, ran 1 command
          <Icon name="chevron" />
        </p>
        <p className="am-working">Working…</p>
        <p className="am-phone-composer">
          Ask a follow-up
          <Icon name="layers" />
          <span className="am-phone-mic">
            <Icon name="mic" />
          </span>
        </p>
      </div>
    </div>
  );
}
