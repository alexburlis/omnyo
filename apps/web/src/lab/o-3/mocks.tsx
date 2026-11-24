const THREADS = [
  {
    repo: "harbor-api",
    branch: "fix/retry-backoff",
    agent: "Codex",
    state: "Running",
    tone: "run",
    active: true,
  },
  {
    repo: "tidepool-web",
    branch: "feat/onboarding-copy",
    agent: "Claude Code",
    state: "Needs you",
    tone: "ask",
    active: false,
  },
  {
    repo: "tidepool-web",
    branch: "fix/date-picker-tz",
    agent: "Claude Code",
    state: "Running",
    tone: "run",
    active: false,
  },
  {
    repo: "lantern-cli",
    branch: "chore/bump-deps",
    agent: "Codex",
    state: "Done",
    tone: "done",
    active: false,
  },
] as const;

function WindowBar({ title }: { title: string }) {
  return (
    <div className="o3m-bar">
      <span className="o3m-lights" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="o3m-bar-title">{title}</span>
    </div>
  );
}

export function ThreadsMock() {
  return (
    <div
      className="o3m o3m-window"
      role="img"
      aria-label="Omnyo with four agent chats, each in its own thread"
    >
      <WindowBar title="Omnyo" />
      <div className="o3m-split">
        <aside className="o3m-side">
          <p className="o3m-label">Chats</p>
          <ul>
            {THREADS.map((thread) => (
              <li
                key={thread.branch}
                className={
                  thread.active ? "o3m-thread is-active" : "o3m-thread"
                }
              >
                <span className={`o3m-dot o3m-dot--${thread.tone}`} />
                <span className="o3m-thread-text">
                  <strong>{thread.branch}</strong>
                  <small>
                    {thread.repo} · {thread.agent}
                  </small>
                </span>
                <em className={`o3m-state o3m-state--${thread.tone}`}>
                  {thread.state}
                </em>
              </li>
            ))}
          </ul>
        </aside>
        <div className="o3m-main">
          <div className="o3m-main-head">
            <span>fix/retry-backoff</span>
            <span className="o3m-chip">Codex</span>
          </div>
          <div className="o3m-msg o3m-msg--you">
            Add exponential backoff to the webhook retries and stop after five
            attempts.
          </div>
          <div className="o3m-msg">
            Updated <code>retry.ts</code> and the worker config. Running the
            webhook tests now.
          </div>
          <div className="o3m-tool">
            <span className="o3m-tool-icon" aria-hidden="true" />
            <code>pnpm test webhooks</code>
            <span className="o3m-pass">18 passed</span>
          </div>
          <div className="o3m-compose">
            <span>Reply to Codex…</span>
            <span className="o3m-send" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReviewMock() {
  return (
    <div
      className="o3m o3m-review"
      role="img"
      aria-label="A builder thread hands a branch to a reviewer thread"
    >
      <div className="o3m-card o3m-card--builder">
        <div className="o3m-card-head">
          <span className="o3m-role">Builder</span>
          <span className="o3m-chip">Codex</span>
        </div>
        <p className="o3m-card-title">feat/export-csv</p>
        <div className="o3m-diff">
          <span className="o3m-diff-add">
            + export async function exportRows(table) {"{"}
          </span>
          <span className="o3m-diff-add">
            + const rows = await table.all();
          </span>
          <span className="o3m-diff-add">+ return toCsv(rows);</span>
          <span className="o3m-diff-ctx"> {"}"}</span>
        </div>
        <p className="o3m-handoff">Branch ready for review</p>
      </div>
      <div className="o3m-link" aria-hidden="true">
        <span />
      </div>
      <div className="o3m-card o3m-card--reviewer">
        <div className="o3m-card-head">
          <span className="o3m-role">Reviewer</span>
          <span className="o3m-chip o3m-chip--alt">Claude Code</span>
        </div>
        <ol className="o3m-findings">
          <li>
            <code>exportRows</code> loads the whole table into memory. Stream
            the rows instead.
          </li>
          <li>No test covers an empty export.</li>
        </ol>
        <div className="o3m-msg o3m-msg--you">
          Fix the first one. Leave the test for a follow-up.
        </div>
      </div>
    </div>
  );
}

export function PhoneMock() {
  return (
    <div
      className="o3m o3m-phone"
      role="img"
      aria-label="A phone following an agent chat through Omnyo Connect"
    >
      <div className="o3m-phone-notch" aria-hidden="true" />
      <div className="o3m-phone-top">
        <span>tidepool-web</span>
        <small>feat/onboarding-copy · Claude Code</small>
      </div>
      <div className="o3m-phone-body">
        <div className="o3m-msg">
          I drafted two versions of the welcome screen. One is three lines, the
          other is a single sentence. Which should I keep?
        </div>
        <div className="o3m-msg o3m-msg--you">The single sentence.</div>
        <div className="o3m-msg">
          Done. Updated <code>welcome.tsx</code> and the snapshot.
        </div>
      </div>
      <div className="o3m-compose">
        <span>Message</span>
        <span className="o3m-send" aria-hidden="true" />
      </div>
    </div>
  );
}

const RUNS = [
  { day: "Fri", note: "Labelled 6 new issues, flagged 1 duplicate" },
  { day: "Thu", note: "Labelled 3 new issues" },
  { day: "Wed", note: "Labelled 4 new issues, asked for 1 repro" },
] as const;

export function ScheduleMock() {
  return (
    <div
      className="o3m o3m-schedule"
      role="img"
      aria-label="An automation that triages issues every weekday at 08:00"
    >
      <div className="o3m-card-head">
        <span className="o3m-role">Automation</span>
        <span className="o3m-chip o3m-chip--alt">Claude Code</span>
      </div>
      <p className="o3m-card-title">Weekday issue triage</p>
      <p className="o3m-sub">harbor-api · every weekday at 08:00</p>
      <div className="o3m-week" aria-hidden="true">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
          <span
            key={`${day}-${index}`}
            className={index < 5 ? "is-on" : undefined}
          >
            {day}
          </span>
        ))}
      </div>
      <ul className="o3m-runs">
        {RUNS.map((run) => (
          <li key={run.day}>
            <span className="o3m-run-time">{run.day} 08:00</span>
            <span>{run.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BrowserMock() {
  return (
    <div
      className="o3m o3m-window o3m-browser"
      role="img"
      aria-label="An agent clicking through a preview of a branch in a real browser"
    >
      <div className="o3m-bar">
        <span className="o3m-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="o3m-url">
          <span className="o3m-url-dot" aria-hidden="true" />
          feat-onboarding-copy · preview
        </span>
      </div>
      <div className="o3m-site">
        <div className="o3m-site-nav">
          <b>Tidepool</b>
          <span />
          <span />
        </div>
        <p className="o3m-site-title">Welcome to Tidepool.</p>
        <div className="o3m-field" />
        <div className="o3m-field" />
        <div className="o3m-site-button">
          Create account
          <span className="o3m-cursor" aria-hidden="true" />
        </div>
      </div>
      <div className="o3m-shots">
        {["Open sign-up", "Fill the form", "See the welcome"].map(
          (step, index) => (
            <figure key={step}>
              <div className={`o3m-shot o3m-shot--${index + 1}`} />
              <figcaption>
                {index + 1}. {step}
              </figcaption>
            </figure>
          ),
        )}
      </div>
    </div>
  );
}
