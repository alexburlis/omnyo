import "@fontsource-variable/inter-tight";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import { type CSSProperties, type ReactNode, useRef } from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import {
  CHATS,
  EVENTS,
  FIELD_GUIDES,
  FLIGHT_PLAN,
  SATELLITES,
  STATE_LABEL,
  SWITCH_GUIDES,
} from "./data";
import { clock, duration, nextWeekdayRun, useNow, useReveal } from "./live";
import Orbit, { type AgentState } from "./orbit";

const MOUNTED_AT = Date.now();

function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="6 6 52 52" aria-hidden="true">
      <path
        d="M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z"
        fill="currentColor"
      />
      <circle cx="49.5" cy="14.5" r="6.5" className="o3-mark-dot" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="o3-icon">
      <path
        d="M8 2v8.5M4.5 7 8 10.5 11.5 7M3 13.5h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="o3-icon">
      <path
        d="M3 8h9.5M8.5 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StateDot({ state }: { state: AgentState }) {
  return <span className={`o3-dot o3-state--${state}`} aria-hidden="true" />;
}

function LocalClock() {
  const now = useNow();

  return <span className="o3-tabular">{clock(new Date(now))}</span>;
}

function Elapsed({ secondsAgo }: { secondsAgo: number }) {
  const now = useNow();

  return (
    <span className="o3-tabular">
      {duration(secondsAgo + (now - MOUNTED_AT) / 1000)}
    </span>
  );
}

function NextRun() {
  const now = useNow();
  const next = nextWeekdayRun(now, 8, 30);

  return (
    <span className="o3-tabular">
      {duration((next.getTime() - now) / 1000)}
    </span>
  );
}

function Uptime() {
  const now = useNow();

  return (
    <span className="o3-tabular">
      T+{duration(2_841 + (now - MOUNTED_AT) / 1000)}
    </span>
  );
}

function PanelHead({
  code,
  title,
  aside,
}: {
  code: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <header className="o3-panel-head">
      <span className="o3-code">{code}</span>
      <span className="o3-panel-title">{title}</span>
      {aside ? <span className="o3-panel-aside">{aside}</span> : null}
    </header>
  );
}

function SiteHeader() {
  return (
    <header className="o3-top">
      <a className="o3-brand" href="#console" aria-label="Omnyo, back to top">
        <Mark className="o3-brand-mark" />
        <span>Omnyo</span>
      </a>
      <nav className="o3-nav" aria-label="Sections">
        <a href="#flight-plan">Flight plan</a>
        <a href="#modules">Modules</a>
        <a href="#data-path">Data path</a>
        <a href="#guides">Guides</a>
      </nav>
      <div className="o3-top-status" aria-hidden="true">
        <span className="o3-live-dot" />
        <span>Local</span>
        <LocalClock />
      </div>
      <a className="o3-btn o3-btn--small" href={MACOS_DOWNLOAD_URL}>
        <DownloadIcon />
        Download
      </a>
    </header>
  );
}

function Hero() {
  return (
    <section className="o3-hero" id="console" aria-labelledby="o3-title">
      <div className="o3-deck">
        <div className="o3-panel o3-a">
          <PanelHead
            code="A1"
            title="The unified interface for coding agents"
          />
          <div className="o3-a-body">
            <h1 id="o3-title" className="o3-h1">
              Every agent.
              <br />
              <span>One console.</span>
            </h1>
            <p className="o3-lede">
              Omnyo runs Claude Code and Codex side by side on your own Mac,
              each chat in its own thread. See what is running, what needs you
              and what runs next, all on one screen.
            </p>
            <div className="o3-actions">
              <a className="o3-btn o3-btn--primary" href={MACOS_DOWNLOAD_URL}>
                <DownloadIcon />
                Download for macOS
              </a>
              <a className="o3-btn o3-btn--ghost" href="#flight-plan">
                See how it works
                <Arrow />
              </a>
            </div>
            <div className="o3-specs">
              <p>Free · Open source · Apple Silicon · macOS 13+</p>
              <p>No Omnyo account needed on your own machines.</p>
            </div>
          </div>
        </div>

        <div className="o3-panel o3-b">
          <PanelHead
            code="B1"
            title="Orbit · 4 agents active"
            aside={<Uptime />}
          />
          <Orbit satellites={SATELLITES} />
          <ul className="o3-legend" aria-hidden="true">
            {(["running", "review", "waiting"] as const).map((state) => (
              <li key={state}>
                <StateDot state={state} />
                {STATE_LABEL[state]}
              </li>
            ))}
          </ul>
        </div>

        <div className="o3-panel o3-c">
          <PanelHead code="C1" title="Chats" aside="7 open" />
          <ol className="o3-chats" aria-label="Example chats">
            {CHATS.map((chat) => (
              <li key={chat.id} className={`o3-chat o3-state--${chat.state}`}>
                <div className="o3-chat-row">
                  <StateDot state={chat.state} />
                  <span className="o3-chat-agent">{chat.agent}</span>
                  <span className="o3-chat-state">
                    {STATE_LABEL[chat.state]}
                  </span>
                  <span className="o3-chat-time">
                    {chat.state === "running" || chat.state === "review" ? (
                      <Elapsed secondsAgo={chat.startedSecondsAgo} />
                    ) : chat.state === "scheduled" ? (
                      <>
                        in <NextRun />
                      </>
                    ) : chat.state === "waiting" ? (
                      "waiting"
                    ) : (
                      "✓"
                    )}
                  </span>
                </div>
                <p className="o3-chat-title">{chat.title}</p>
                <p className="o3-chat-meta">
                  {chat.repo} · {chat.meta}
                </p>
                {chat.state === "running" ? (
                  <span className="o3-chat-bar" aria-hidden="true" />
                ) : null}
              </li>
            ))}
          </ol>
          <div className="o3-composer" aria-hidden="true">
            <p>Describe a task for a new chat</p>
            <div className="o3-composer-row">
              <span className="o3-chip is-on">Claude Code</span>
              <span className="o3-chip">Codex</span>
              <span className="o3-composer-send">
                <Arrow />
              </span>
            </div>
          </div>
        </div>

        <div className="o3-panel o3-d">
          <PanelHead code="D1" title="Machines" aside="2 linked" />
          <ul className="o3-machines">
            <li>
              <div className="o3-machine-name">
                <StateDot state="running" />
                studio-mac
                <em>This Mac</em>
              </div>
              <p>4 chats active</p>
            </li>
            <li>
              <div className="o3-machine-name">
                <StateDot state="review" />
                travel-laptop
                <em>Remote</em>
              </div>
              <p>Following 2 chats via Omnyo Connect</p>
            </li>
          </ul>
        </div>

        <div className="o3-panel o3-e">
          <PanelHead code="E1" title="Next run" aside="Mon–Fri 08:30" />
          <div className="o3-e-body">
            <p className="o3-e-name">Weekday issue triage</p>
            <p className="o3-countdown">
              <small>T−</small>
              <NextRun />
            </p>
            <ol className="o3-week" aria-label="Runs Monday to Friday at 08:30">
              {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
                <li key={`${day}${index}`} className={index < 5 ? "is-on" : ""}>
                  {day}
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="o3-panel o3-f">
          <PanelHead
            code="F1"
            title="Review in flight"
            aside="fix/retry-backoff"
          />
          <ol className="o3-relay">
            <li className="o3-state--done">
              <span className="o3-relay-role">Builder</span>
              <span className="o3-relay-agent">Codex</span>
              <span className="o3-relay-note">Change ready</span>
            </li>
            <li className="o3-state--review">
              <span className="o3-relay-role">Reviewer</span>
              <span className="o3-relay-agent">Claude Code</span>
              <span className="o3-relay-note">2 notes</span>
            </li>
            <li className="o3-state--waiting">
              <span className="o3-relay-role">Debrief</span>
              <span className="o3-relay-agent">You</span>
              <span className="o3-relay-note">Talk it through</span>
            </li>
          </ol>
          <div className="o3-relay-track" aria-hidden="true">
            <span />
          </div>
        </div>
      </div>

      <div className="o3-ticker" aria-hidden="true">
        <div className="o3-ticker-tape">
          {[0, 1].map((copy) => (
            <div key={copy} className="o3-ticker-run">
              {EVENTS.map(([time, source, message]) => (
                <span key={`${copy}-${time}`} className="o3-event">
                  <time>{time}</time>
                  <b>{source}</b>
                  {message}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHead({
  code,
  label,
  title,
  lede,
}: {
  code: string;
  label: string;
  title: ReactNode;
  lede: string;
}) {
  return (
    <div className="o3-section-head" data-reveal>
      <p className="o3-kicker">
        <span>{code}</span>
        {label}
      </p>
      <h2 className="o3-h2">{title}</h2>
      <p className="o3-section-lede">{lede}</p>
    </div>
  );
}

function FlightPlan() {
  return (
    <section className="o3-section" id="flight-plan" aria-labelledby="o3-fp">
      <SectionHead
        code="02"
        label="Flight plan"
        title={
          <span id="o3-fp">
            One agent builds.
            <br />
            Another reviews.
            <br />
            <em>You decide.</em>
          </span>
        }
        lede="Hand the work to one agent and the review to a different one. Each works in its own thread, and you talk the findings through with the reviewer."
      />
      <ol className="o3-plan" data-reveal>
        {FLIGHT_PLAN.map((step, index) => (
          <li
            key={step.code}
            className={`o3-step o3-state--${step.state}`}
            style={{ "--i": index } as CSSProperties}
          >
            <span className="o3-step-code">{step.code}</span>
            <span className="o3-step-node" aria-hidden="true" />
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            <code className="o3-step-log">{step.log}</code>
            <span className="o3-step-agent">
              <StateDot state={step.state} />
              {step.agent}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ModuleSideBySide() {
  return (
    <div className="o3-mod-viz o3-split" aria-hidden="true">
      {[
        { agent: "Claude Code", lines: [82, 64, 90, 48] },
        { agent: "Codex", lines: [70, 92, 55, 76] },
      ].map((column) => (
        <div key={column.agent} className="o3-split-col">
          <span className="o3-split-head">
            <StateDot state="running" />
            {column.agent}
          </span>
          {column.lines.map((width, index) => (
            <i
              key={index}
              style={{ width: `${width}%`, animationDelay: `${index * 0.35}s` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ModuleReview() {
  return (
    <div className="o3-mod-viz o3-pair" aria-hidden="true">
      <span className="o3-node o3-state--done">
        <StateDot state="done" />
        Codex
        <small>builds</small>
      </span>
      <span className="o3-pair-wire">
        <i />
      </span>
      <span className="o3-node o3-state--review">
        <StateDot state="review" />
        Claude Code
        <small>reviews</small>
      </span>
    </div>
  );
}

function ModuleRemote() {
  return (
    <div className="o3-mod-viz o3-remote" aria-hidden="true">
      <span className="o3-node">
        <StateDot state="running" />
        studio-mac
      </span>
      <span className="o3-remote-wire">
        <i />
        <i />
        <i />
      </span>
      <span className="o3-node">
        <StateDot state="review" />
        travel-laptop
      </span>
    </div>
  );
}

function ModuleDevServers() {
  return (
    <ul className="o3-mod-viz o3-servers" aria-hidden="true">
      {[
        ["feat/invoice-export", ":5174"],
        ["fix/retry-backoff", ":5175"],
        ["chore/deps-nov", ":5176"],
      ].map(([branch, port]) => (
        <li key={branch}>
          <StateDot state="running" />
          <span>{branch}</span>
          <em>{port}</em>
          <b>Preview ↗</b>
        </li>
      ))}
    </ul>
  );
}

function ModuleSchedule() {
  return (
    <div className="o3-mod-viz o3-sched" aria-hidden="true">
      <div className="o3-sched-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, index) => (
          <span key={day} className={index < 5 ? "is-on" : ""}>
            <small>{day}</small>
            <i />
          </span>
        ))}
      </div>
      <p>
        Next run in <NextRun />
      </p>
    </div>
  );
}

function ModuleBrowser() {
  return (
    <div className="o3-mod-viz o3-browser" aria-hidden="true">
      <div className="o3-browser-frame">
        <span className="o3-browser-bar">
          <i />
          <i />
          <i />
          <em>localhost:5174/settings</em>
        </span>
        <span className="o3-browser-page">
          <b />
          <b />
          <b />
          <span className="o3-cursor" />
        </span>
      </div>
      <div className="o3-shots">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

const MODULES = [
  {
    code: "M-01",
    title: "Claude Code and Codex, side by side",
    body: "Use both agents in one app. Every chat gets its own thread, so parallel work stays readable.",
    href: "/guides/claude-code-and-codex-together",
    Viz: ModuleSideBySide,
  },
  {
    code: "M-02",
    title: "A builder and a reviewer",
    body: "One agent builds the task. A different agent reviews it in its own thread, and you talk it through with the reviewer.",
    href: "/guides/orchestrate-coding-agents",
    Viz: ModuleReview,
  },
  {
    code: "M-03",
    title: "Work from anywhere",
    body: "Follow and steer chats from another device with Omnyo Connect. It is optional and uses a free account.",
    href: "/guides/work-from-anywhere",
    Viz: ModuleRemote,
  },
  {
    code: "M-04",
    title: "A dev server for every branch",
    body: "Run a dev server for each branch and open its live preview link.",
    href: "/guides/remote-dev-servers",
    Viz: ModuleDevServers,
  },
  {
    code: "M-05",
    title: "Agents on a schedule",
    body: "Run an agent on a timetable, such as issue triage every weekday morning.",
    href: "/guides/run-an-agent-on-a-schedule",
    Viz: ModuleSchedule,
  },
  {
    code: "M-06",
    title: "A real browser",
    body: "Let your agent click through a change in a real browser and show you screenshots.",
    href: "/guides/agent-browser",
    Viz: ModuleBrowser,
  },
] as const;

function Modules() {
  return (
    <section className="o3-section" id="modules" aria-labelledby="o3-mod">
      <SectionHead
        code="03"
        label="Modules"
        title={<span id="o3-mod">Built for many agents at once.</span>}
        lede="Each part of the console does one job: keep agents apart, pass work between them, and keep you in the loop wherever you are."
      />
      <div className="o3-modules" data-reveal>
        {MODULES.map(({ code, title, body, href, Viz }) => (
          <article key={code} className="o3-module">
            <span className="o3-code">{code}</span>
            <Viz />
            <h3>{title}</h3>
            <p>{body}</p>
            <a href={href} className="o3-more">
              Read the guide
              <Arrow />
            </a>
          </article>
        ))}
        <article className="o3-module o3-module--wide">
          <span className="o3-code">M-07</span>
          <div className="o3-plugins" aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <span key={index} className={index < 5 ? "is-on" : ""} />
            ))}
          </div>
          <div className="o3-module-copy">
            <h3>Plugins</h3>
            <p>
              Extend the console with plugins when you need something it does
              not do yet.
            </p>
          </div>
          <a href="/plugin-guide" className="o3-more">
            Plugin Guide
            <Arrow />
          </a>
        </article>
      </div>
    </section>
  );
}

function DataPath() {
  return (
    <section
      className="o3-section o3-path-section"
      id="data-path"
      aria-labelledby="o3-path"
    >
      <SectionHead
        code="04"
        label="Data path"
        title={<span id="o3-path">Nothing hosted by us in between.</span>}
        lede="Omnyo runs on your own machines. Prompts, code and files go to the Omnyo server you run, then to the AI provider you choose."
      />
      <div className="o3-path" data-reveal>
        <div className="o3-path-node">
          <span className="o3-code">N1</span>
          <Mark className="o3-path-mark" />
          <h3>Your Mac</h3>
          <p>The Omnyo app</p>
        </div>
        <div className="o3-path-wire" aria-hidden="true">
          <span className="o3-packet" />
          <span className="o3-packet" />
          <small>prompts · code · files</small>
        </div>
        <div className="o3-path-node o3-path-node--core">
          <span className="o3-code">N2</span>
          <span className="o3-path-glyph" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <h3>Your Omnyo server</h3>
          <p>Runs on your machines</p>
        </div>
        <div className="o3-path-wire" aria-hidden="true">
          <span className="o3-packet" />
          <span className="o3-packet" />
          <small>to your provider</small>
        </div>
        <div className="o3-path-node">
          <span className="o3-code">N3</span>
          <span
            className="o3-path-glyph o3-path-glyph--ai"
            aria-hidden="true"
          />
          <h3>Your AI provider</h3>
          <p>The one you choose</p>
        </div>
      </div>
      <dl className="o3-facts" data-reveal>
        <div>
          <dt>Account</dt>
          <dd>None needed on your own machines</dd>
        </div>
        <div>
          <dt>Remote access</dt>
          <dd>Optional, with a free Omnyo Connect account</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>Open source</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>Free</dd>
        </div>
      </dl>
    </section>
  );
}

function Guides() {
  return (
    <section className="o3-section" id="guides" aria-labelledby="o3-guides">
      <SectionHead
        code="05"
        label="Guides"
        title={<span id="o3-guides">Coming from another tool?</span>}
        lede="Step-by-step guides show how your current setup maps onto Omnyo."
      />
      <div className="o3-guides" data-reveal>
        <ol className="o3-switch">
          {SWITCH_GUIDES.map((guide, index) => (
            <li key={guide.slug}>
              <a href={`/guides/${guide.slug}`}>
                <span className="o3-code">
                  CH {String(index + 1).padStart(2, "0")}
                </span>
                <span className="o3-switch-from">Switch from {guide.from}</span>
                <Arrow />
              </a>
            </li>
          ))}
        </ol>
        <div className="o3-field">
          <p className="o3-field-head">Field guides</p>
          <ul>
            {FIELD_GUIDES.map((guide) => (
              <li key={guide.slug}>
                <a href={`/guides/${guide.slug}`}>
                  {guide.title}
                  <Arrow />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Launch() {
  return (
    <section className="o3-launch" aria-labelledby="o3-launch">
      <div className="o3-launch-inner" data-reveal>
        <p className="o3-kicker">
          <span>06</span>
          Launch
        </p>
        <h2 id="o3-launch" className="o3-launch-title">
          Take the controls.
        </h2>
        <p className="o3-section-lede">
          Download Omnyo for your Mac and bring your coding agents into one
          console.
        </p>
        <a
          className="o3-btn o3-btn--primary o3-btn--large"
          href={MACOS_DOWNLOAD_URL}
        >
          <DownloadIcon />
          Download for macOS
        </a>
        <dl className="o3-readout">
          <div>
            <dt>Platform</dt>
            <dd>macOS 13 or later</dd>
          </div>
          <div>
            <dt>Chip</dt>
            <dd>Apple Silicon</dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd>Free</dd>
          </div>
          <div>
            <dt>Licence</dt>
            <dd>Open source</dd>
          </div>
        </dl>
      </div>
      <div className="o3-launch-dial" aria-hidden="true">
        <svg viewBox="-100 -100 200 200" className="o3-dial">
          <circle r="97" className="o3-dial-ring" />
          <circle r="74" className="o3-dial-faint" />
          <circle r="52" className="o3-dial-faint" />
          {Array.from({ length: 144 }, (_, index) => {
            const angle = (index / 144) * Math.PI * 2;
            const major = index % 12 === 0;
            const inner = major ? 88 : 92;

            return (
              <line
                key={index}
                x1={Math.cos(angle) * inner}
                y1={Math.sin(angle) * inner}
                x2={Math.cos(angle) * 97}
                y2={Math.sin(angle) * 97}
                className={major ? "o3-dial-major" : "o3-dial-tick"}
              />
            );
          })}
          <circle r="74" className="o3-dial-arc" pathLength="100" />
          <g className="o3-dial-orbit">
            <circle cx="74" cy="0" r="3.2" className="o3-dial-sat" />
          </g>
          <g className="o3-dial-orbit o3-dial-orbit--slow">
            <circle
              cx="0"
              cy="-52"
              r="2.4"
              className="o3-dial-sat o3-dial-sat--review"
            />
          </g>
        </svg>
        <Mark className="o3-launch-mark" />
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="o3-footer">
      <div className="o3-footer-brand">
        <Mark className="o3-brand-mark" />
        <span>Omnyo</span>
        <p>The unified interface for coding agents.</p>
      </div>
      <nav className="o3-footer-links" aria-label="Legal">
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
        <a href="/imprint">Imprint</a>
      </nav>
      <p className="o3-footer-meta">
        Built on <a href={BB_URL}>bb</a> (MIT License) · © 2026 Omnyo
      </p>
    </footer>
  );
}

export default function Page() {
  const rootRef = useRef<HTMLElement>(null);
  useReveal(rootRef);

  return (
    <main ref={rootRef} className="lab-open-3">
      <SiteHeader />
      <Hero />
      <FlightPlan />
      <Modules />
      <DataPath />
      <Guides />
      <Launch />
      <SiteFooter />
    </main>
  );
}
