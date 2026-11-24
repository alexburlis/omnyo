import type { ReactNode } from "react";

export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="6 6 52 52" aria-hidden="true">
      <path
        d="M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z"
        fill="currentColor"
      />
      <circle cx="49.5" cy="14.5" r="6.5" fill="currentColor" />
    </svg>
  );
}

export function Plate({
  number,
  title,
  note,
  caption,
  className,
  children,
}: {
  number: string;
  title: string;
  note: string;
  caption: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={`o1-plate ${className ?? ""}`} data-reveal>
      <div className="o1-plate-head">
        <span>Plate {number}</span>
        <span>{title}</span>
        <span>{note}</span>
      </div>
      <div className="o1-plate-body">{children}</div>
      <figcaption className="o1-plate-cap">
        <b>Plate {number}.</b> {caption}
      </figcaption>
    </figure>
  );
}

function Tag({ agent }: { agent: "Claude Code" | "Codex" | "Automation" }) {
  return (
    <span
      className={`o1-tag o1-tag--${agent === "Codex" ? "x" : agent === "Automation" ? "a" : "c"}`}
    >
      {agent}
    </span>
  );
}

const THREADS = [
  {
    title: "Fix flaky checkout test",
    agent: "Claude Code",
    meta: "fix/flaky-checkout",
    state: "run",
  },
  {
    title: "Add token-bucket rate limiter",
    agent: "Codex",
    meta: "feat/rate-limit",
    state: "run",
    active: true,
  },
  {
    title: "Review: rate limiter",
    agent: "Claude Code",
    meta: "feat/rate-limit",
    state: "idle",
  },
  {
    title: "Weekday issue triage",
    agent: "Automation",
    meta: "Mon–Fri",
    state: "sched",
  },
] as const;

export function WorkspaceDrawing() {
  return (
    <div className="o1-app">
      <div className="o1-app-bar">
        <span className="o1-app-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="o1-app-title">harbor-api</span>
        <span className="o1-app-bar-end">4 chats</span>
      </div>
      <div className="o1-app-body">
        <aside className="o1-app-side">
          <div className="o1-app-side-head">
            <Mark className="o1-app-mark" />
            <span>harbor-api</span>
          </div>
          <ul>
            {THREADS.map((thread) => (
              <li
                key={thread.title}
                className={"active" in thread ? "is-active" : undefined}
              >
                <span className={`o1-dot o1-dot--${thread.state}`} />
                <span className="o1-app-thread">
                  <span>{thread.title}</span>
                  <span className="o1-app-thread-meta">
                    <Tag agent={thread.agent} />
                    <span>{thread.meta}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="o1-app-side-foot">+ New chat</div>
        </aside>
        <section className="o1-app-pane">
          <header>
            <Tag agent="Claude Code" />
            <span>fix/flaky-checkout</span>
          </header>
          <div className="o1-msg o1-msg--you">
            The checkout test fails about one run in ten. Find out why.
          </div>
          <div className="o1-msg">
            The test reads the cart before the price cache has warmed. I added
            an <code>await warmCache()</code> to the setup and ran the file 50
            times. It passed every run.
          </div>
          <div className="o1-tool">
            <span>Ran</span> pnpm test checkout.spec.ts --repeat 50
          </div>
          <div className="o1-composer">Reply to Claude Code…</div>
        </section>
        <section className="o1-app-pane o1-app-pane--b">
          <header>
            <Tag agent="Codex" />
            <span>feat/rate-limit</span>
          </header>
          <div className="o1-msg o1-msg--you">
            Add a token-bucket limiter to <code>/v1/orders</code>.
          </div>
          <div className="o1-msg">
            Added <code>src/limits/bucket.ts</code> and wired it into the orders
            router.
          </div>
          <pre className="o1-diff">
            <span className="o1-diff-file">src/limits/bucket.ts</span>
            <span className="add">
              + export function take(key: string) {"{"}
            </span>
            <span className="add">
              + const b = buckets.get(key) ?? fill(key);
            </span>
            <span className="add">+ refill(b, now());</span>
            <span className="add">+ if (b.tokens &lt; 1) return false;</span>
            <span className="del">- return true;</span>
          </pre>
          <div className="o1-preview">
            <i />
            <span>Dev server running</span>
            <b>feat-rate-limit preview ↗</b>
          </div>
          <div className="o1-composer">Reply to Codex…</div>
        </section>
      </div>
    </div>
  );
}

export function ReviewDrawing() {
  return (
    <div className="o1-review">
      <div className="o1-review-col">
        <div className="o1-review-label">
          <span className="o1-num">A</span> Builds
        </div>
        <div className="o1-card">
          <header>
            <Tag agent="Codex" />
            <span>feat/rate-limit</span>
          </header>
          <p>Token-bucket limiter for the orders API.</p>
          <ul className="o1-files">
            <li>
              <span>src/limits/bucket.ts</span>
              <b>+62</b>
            </li>
            <li>
              <span>src/routes/orders.ts</span>
              <b>+9 −4</b>
            </li>
            <li>
              <span>test/bucket.spec.ts</span>
              <b>+13</b>
            </li>
          </ul>
        </div>
      </div>
      <div className="o1-review-arrow" aria-hidden="true">
        <svg viewBox="0 0 80 16">
          <path d="M0 8h76M68 1l8 7-8 7" fill="none" />
        </svg>
      </div>
      <div className="o1-review-col">
        <div className="o1-review-label">
          <span className="o1-num">B</span> Reviews
        </div>
        <div className="o1-card">
          <header>
            <Tag agent="Claude Code" />
            <span>Review thread</span>
          </header>
          <ol className="o1-notes">
            <li>
              <code>refill()</code> uses wall-clock time. Use a monotonic clock
              so a clock change cannot refill a bucket early.
            </li>
            <li>No test covers a burst at full capacity.</li>
          </ol>
        </div>
      </div>
      <div className="o1-review-arrow" aria-hidden="true">
        <svg viewBox="0 0 80 16">
          <path d="M0 8h76M68 1l8 7-8 7" fill="none" />
        </svg>
      </div>
      <div className="o1-review-col">
        <div className="o1-review-label">
          <span className="o1-num">C</span> You discuss
        </div>
        <div className="o1-card o1-card--talk">
          <div className="o1-msg o1-msg--you">
            How likely is note 1 in production?
          </div>
          <div className="o1-msg">
            Likely enough: the API runs on two hosts that sync their clocks. One
            line fixes it.
          </div>
          <div className="o1-composer">Reply to the reviewer…</div>
        </div>
      </div>
    </div>
  );
}

export function FlowDrawing() {
  return (
    <div className="o1-flow">
      <div className="o1-flow-node">
        <span className="o1-flow-k">01</span>
        <div className="o1-flow-box">
          <svg viewBox="0 0 64 44" aria-hidden="true">
            <rect x="6" y="3" width="52" height="33" rx="3" />
            <path d="M1 40h62" />
          </svg>
        </div>
        <b>Your Mac</b>
        <span>The Omnyo app, where you write prompts and read answers.</span>
      </div>
      <div className="o1-flow-link">
        <span>prompts, code, files</span>
        <i />
      </div>
      <div className="o1-flow-node">
        <span className="o1-flow-k">02</span>
        <div className="o1-flow-box o1-flow-box--accent">
          <svg viewBox="0 0 64 44" aria-hidden="true">
            <rect x="10" y="4" width="44" height="11" rx="2" />
            <rect x="10" y="18" width="44" height="11" rx="2" />
            <path d="M16 9.5h2M16 23.5h2M32 34v6M22 40h20" />
          </svg>
        </div>
        <b>Your Omnyo server</b>
        <span>Runs on a machine you own, not on ours.</span>
      </div>
      <div className="o1-flow-link">
        <span>then on to</span>
        <i />
      </div>
      <div className="o1-flow-node">
        <span className="o1-flow-k">03</span>
        <div className="o1-flow-box">
          <svg viewBox="0 0 64 44" aria-hidden="true">
            <circle cx="32" cy="22" r="16" />
            <path d="M16 22h32M32 6c-6 5-6 27 0 32M32 6c6 5 6 27 0 32" />
          </svg>
        </div>
        <b>The provider you choose</b>
        <span>The AI provider behind the agent you picked for the chat.</span>
      </div>
    </div>
  );
}

export function RemoteSpecimen() {
  return (
    <svg className="o1-spec" viewBox="0 0 120 72" aria-hidden="true">
      <rect x="4" y="8" width="72" height="50" rx="3" />
      <path d="M0 62h80" />
      <rect
        x="88"
        y="14"
        width="28"
        height="52"
        rx="5"
        className="o1-spec-accent"
      />
      <path d="M96 24h12M96 30h9M96 36h12" className="o1-spec-accent" />
      <path d="M80 34c4 0 4-6 8-6" strokeDasharray="2 3" />
    </svg>
  );
}

export function PreviewSpecimen() {
  return (
    <div className="o1-chip-stack" aria-hidden="true">
      <span>
        <i />
        feat/rate-limit <b>↗</b>
      </span>
      <span>
        <i />
        fix/flaky-checkout <b>↗</b>
      </span>
      <span>
        <i />
        main <b>↗</b>
      </span>
    </div>
  );
}

export function ScheduleSpecimen() {
  return (
    <div className="o1-week" aria-hidden="true">
      {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
        <span key={`${day}${index}`} className={index < 5 ? "on" : undefined}>
          {day}
        </span>
      ))}
    </div>
  );
}

export function BrowserSpecimen() {
  return (
    <svg className="o1-spec" viewBox="0 0 120 72" aria-hidden="true">
      <rect x="2" y="4" width="100" height="62" rx="3" />
      <path d="M2 14h100" />
      <circle cx="8" cy="9" r="1.4" />
      <circle cx="13" cy="9" r="1.4" />
      <rect x="12" y="24" width="40" height="5" />
      <rect x="12" y="34" width="60" height="3" />
      <rect x="12" y="41" width="52" height="3" />
      <rect
        x="12"
        y="52"
        width="24"
        height="8"
        rx="1"
        className="o1-spec-accent"
      />
      <path
        d="M34 56l12 4-5 1.6 3.6 4.4-2 1.6-3.6-4.4-3 4z"
        className="o1-spec-fill"
      />
      <rect
        x="84"
        y="36"
        width="32"
        height="24"
        rx="1"
        className="o1-spec-paper"
      />
      <path d="M88 52l6-6 5 4 4-3 9 7" />
    </svg>
  );
}

export function PluginSpecimen() {
  return (
    <svg className="o1-spec" viewBox="0 0 120 72" aria-hidden="true">
      <rect x="8" y="8" width="44" height="56" rx="3" />
      <rect
        x="58"
        y="8"
        width="26"
        height="26"
        rx="3"
        className="o1-spec-accent"
      />
      <rect x="58" y="38" width="26" height="26" rx="3" strokeDasharray="3 3" />
      <rect x="90" y="8" width="26" height="26" rx="3" strokeDasharray="3 3" />
      <path d="M18 20h24M18 28h18M18 36h22" />
    </svg>
  );
}
