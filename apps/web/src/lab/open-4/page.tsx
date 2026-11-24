import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/fraunces/full-italic.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import { type RefObject, useEffect, useRef } from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import ClayMark from "./clay-mark";
import {
  AppWindow,
  BranchArt,
  BrowserArt,
  PhoneArt,
  PluginArt,
  ProviderDot,
  ReviewPair,
  RouteDiagram,
  ScheduleArt,
} from "./illustrations";

const SWITCH_GUIDES = [
  ["Claude Code", "switch-from-claude-code"],
  ["Codex", "switch-from-codex"],
  ["Conductor", "switch-from-conductor"],
  ["Cursor", "switch-from-cursor"],
  ["Superset", "switch-from-superset"],
  ["T3 Code", "switch-from-t3-code"],
  ["Vibe Kanban", "switch-from-vibe-kanban"],
] as const;

const FEATURES = [
  {
    key: "anywhere",
    title: "Keep working from anywhere",
    body: "Turn on Omnyo Connect with a free account to follow and steer your chats from another device. It is optional.",
    href: "/guides/work-from-anywhere",
    more: "Read the guide",
    Art: PhoneArt,
  },
  {
    key: "branches",
    title: "A dev server for every branch",
    body: "Each branch can run its own dev server, with a live preview link you can open while the agent works.",
    href: "/guides/remote-dev-servers",
    more: "Read the guide",
    Art: BranchArt,
  },
  {
    key: "schedule",
    title: "Agents on a schedule",
    body: "Run an agent at set times, like a weekday pass over new issues before you sit down.",
    href: "/guides/run-an-agent-on-a-schedule",
    more: "Read the guide",
    Art: ScheduleArt,
  },
  {
    key: "browser",
    title: "A real browser for your agent",
    body: "Your agent can click through a change in a real browser and show you screenshots of what it saw.",
    href: "/guides/agent-browser",
    more: "Read the guide",
    Art: BrowserArt,
  },
  {
    key: "plugins",
    title: "Make it yours with plugins",
    body: "Add commands, tools and panels with plugins.",
    href: "/plugin-guide",
    more: "Open the Plugin Guide",
    Art: PluginArt,
  },
] as const;

function Mark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z" />
      <circle cx="49.5" cy="14.5" r="6.5" className="mark-dot" />
    </svg>
  );
}

function DownloadButton({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <a className={`download download--${size}`} href={MACOS_DOWNLOAD_URL}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="apple">
        <path d="M16.37 12.6c.03 2.9 2.55 3.87 2.58 3.88-.02.07-.4 1.38-1.33 2.73-.8 1.17-1.63 2.33-2.94 2.36-1.29.02-1.7-.77-3.17-.77-1.47 0-1.93.75-3.15.79-1.26.05-2.22-1.26-3.03-2.42-1.65-2.38-2.9-6.73-1.22-9.67.84-1.46 2.33-2.38 3.95-2.4 1.24-.03 2.4.83 3.16.83.75 0 2.17-1.03 3.66-.88.62.03 2.37.25 3.5 1.9-.1.06-2.08 1.22-2.01 3.65ZM13.97 5.5c.67-.81 1.12-1.94 1-3.06-.96.04-2.13.64-2.82 1.45-.62.71-1.16 1.86-1.02 2.96 1.08.08 2.17-.55 2.84-1.35Z" />
      </svg>
      <span>Download for macOS</span>
    </a>
  );
}

function Fineprint() {
  return (
    <p className="fineprint">
      <span>Apple Silicon · macOS 13 or later</span>
      <span>No Omnyo account needed</span>
    </p>
  );
}

function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;

    if (!element) return;
    const targets = element.querySelectorAll<HTMLElement>("[data-reveal]");

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const target of targets) target.classList.add("is-in");

      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );

    for (const target of targets) observer.observe(target);

    return () => observer.disconnect();
  }, [root]);
}

export default function Page() {
  const root = useRef<HTMLElement>(null);
  useReveal(root);

  return (
    <main className="lab-open-4" ref={root}>
      <div className="grain" aria-hidden="true" />

      <header className="nav">
        <a className="brand" href="/" aria-label="Omnyo home">
          <Mark className="brand-mark" />
          <span>Omnyo</span>
        </a>
        <nav className="nav-links" aria-label="Main">
          <a href="#story">How it works</a>
          <a href="#features">Features</a>
          <a href="#switch">Guides</a>
          <a href="/plugin-guide">Plugin Guide</a>
        </nav>
        <a className="nav-download" href={MACOS_DOWNLOAD_URL}>
          Download
        </a>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="eyebrow-pill">Free</span>
            Open source · for macOS
          </p>
          <h1>
            <span className="h1-line">Your coding agents,</span>
            <span className="h1-line">
              <em>at home</em> on your Mac.
            </span>
          </h1>
          <p className="lede">
            Omnyo brings Claude Code and Codex together in one private
            workspace. It runs on your own machines and talks straight to the AI
            provider you choose.
          </p>
          <div className="hero-actions">
            <DownloadButton size="lg" />
            <a className="text-link" href="#story">
              See how it works
            </a>
          </div>
          <Fineprint />
        </div>

        <div className="hero-stage">
          <div className="stage-sun" aria-hidden="true" />
          <div className="stage-ledge" aria-hidden="true" />
          <div className="stage-arch" aria-hidden="true">
            <span className="arch-light">
              <i />
              <i />
              <i />
              <i />
            </span>
          </div>
          <div className="stage-plant" aria-hidden="true">
            <span className="leaf leaf--1" />
            <span className="leaf leaf--2" />
            <span className="leaf leaf--3" />
            <span className="pot" />
          </div>
          <ClayMark className="stage-canvas" />
          <div className="float float--a" aria-hidden="true">
            <ProviderDot provider="claude" />
            <span>
              <b>Claude Code</b>
              <small>Building · feat/receipt-export</small>
            </span>
          </div>
          <div className="float float--b" aria-hidden="true">
            <ProviderDot provider="codex" />
            <span>
              <b>Codex</b>
              <small>Reviewing · 3 notes</small>
            </span>
          </div>
          <div className="float float--c" aria-hidden="true">
            <span className="pulse" />
            <span>
              <b>Preview ready</b>
              <small>feat/receipt-export</small>
            </span>
          </div>
        </div>
      </section>

      <section className="story" id="story">
        <p className="statement" data-reveal>
          One terminal for Claude Code, another for Codex, a dev server in a
          third. Omnyo puts them in <em>one calm window</em>, each chat in its
          own thread.
        </p>
        <div className="window-wrap" data-reveal>
          <AppWindow />
        </div>
        <ul className="story-points" data-reveal>
          <li>
            <span className="num">01</span>
            <b>Side by side.</b> Claude Code and Codex work next to each other,
            never in the same thread.
          </li>
          <li>
            <span className="num">02</span>
            <b>One place to look.</b> Every chat sits in the same sidebar,
            whichever agent is running it.
          </li>
          <li>
            <span className="num">03</span>
            <b>On your machines.</b> Use it on your own Macs without an Omnyo
            account.
          </li>
        </ul>
      </section>

      <section className="review">
        <div className="section-head" data-reveal>
          <p className="kicker">Orchestrate</p>
          <h2>
            One agent builds.
            <br />
            <em>Another</em> reviews.
          </h2>
          <p>
            Ask one agent to build a task, then hand it to a different agent for
            review in its own thread. Talk the notes through with the reviewer
            before anything is merged.
          </p>
          <a className="text-link" href="/guides/orchestrate-coding-agents">
            How to orchestrate coding agents
          </a>
        </div>
        <div data-reveal>
          <ReviewPair />
        </div>
      </section>

      <section className="private">
        <div className="private-card" data-reveal>
          <div className="section-head section-head--center">
            <p className="kicker">Private by design</p>
            <h2>
              Your work stays on <em>your</em> side.
            </h2>
            <p>
              Prompts, code and files go to the Omnyo server you run, then to
              the AI provider you choose. Nothing is hosted by us in between.
            </p>
          </div>
          <RouteDiagram />
        </div>
      </section>

      <section className="features" id="features">
        <div className="section-head" data-reveal>
          <p className="kicker">Everything around the chat</p>
          <h2>
            The rest of the job, <em>close at hand</em>.
          </h2>
        </div>
        <div className="feature-grid">
          {FEATURES.map(({ key, title, body, href, more, Art }) => (
            <a
              key={key}
              className={`feature feature--${key}`}
              href={href}
              data-reveal
            >
              <Art />
              <div className="feature-text">
                <h3>{title}</h3>
                <p>{body}</p>
                <span className="feature-more">{more}</span>
              </div>
            </a>
          ))}
        </div>
      </section>

      <section className="switch" id="switch">
        <div className="switch-inner" data-reveal>
          <div>
            <p className="kicker">Moving in</p>
            <h2>
              Coming from <em>another tool</em>?
            </h2>
            <p>Short guides show how your current setup maps onto Omnyo.</p>
          </div>
          <ul className="switch-list">
            {SWITCH_GUIDES.map(([label, slug]) => (
              <li key={slug}>
                <a href={`/guides/${slug}`}>
                  <span>From {label}</span>
                  <span className="arrow" aria-hidden="true">
                    →
                  </span>
                </a>
              </li>
            ))}
            <li>
              <a href="/guides/claude-code-and-codex-together">
                <span>Claude Code and Codex together</span>
                <span className="arrow" aria-hidden="true">
                  →
                </span>
              </a>
            </li>
          </ul>
        </div>
      </section>

      <section className="closing">
        <div className="closing-card" data-reveal>
          <div className="closing-shapes" aria-hidden="true">
            <span className="cs cs1" />
            <span className="cs cs2" />
            <span className="cs cs3" />
          </div>
          <div className="closing-arch" aria-hidden="true">
            <Mark className="closing-mark" />
          </div>
          <h2>
            Bring your agents <em>home</em>.
          </h2>
          <p>Free to use. Download it and open your first project.</p>
          <DownloadButton size="lg" />
          <Fineprint />
        </div>
      </section>

      <footer className="footer">
        <div className="footer-brand">
          <a className="brand" href="/" aria-label="Omnyo home">
            <Mark className="brand-mark" />
            <span>Omnyo</span>
          </a>
          <p>The unified interface for coding agents.</p>
        </div>
        <div className="footer-cols">
          <div>
            <h3>Product</h3>
            <a href={MACOS_DOWNLOAD_URL}>Download</a>
            <a href="/plugin-guide">Plugin Guide</a>
          </div>
          <div>
            <h3>Guides</h3>
            <a href="/guides/orchestrate-coding-agents">Orchestrate agents</a>
            <a href="/guides/work-from-anywhere">Work from anywhere</a>
            <a href="/guides/remote-dev-servers">Dev servers</a>
            <a href="/guides/run-an-agent-on-a-schedule">Schedules</a>
          </div>
          <div>
            <h3>Legal</h3>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
            <a href="/imprint">Imprint</a>
          </div>
        </div>
        <div className="footer-base">
          <span>
            Built on <a href={BB_URL}>bb</a> (MIT License)
          </span>
          <span>© 2026 Omnyo</span>
        </div>
      </footer>
    </main>
  );
}
