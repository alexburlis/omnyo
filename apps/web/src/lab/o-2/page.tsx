import "@fontsource-variable/inter-tight";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./styles.css";

import { type ReactNode, useEffect, useRef, useState } from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import { FlatMark } from "./glass-mark";
import lensMarkUrl from "./lens-o.webp";
import { LensScene, type LensStatus } from "./lens-scene";

const SWITCH_GUIDES = [
  { label: "Claude Code", slug: "switch-from-claude-code" },
  { label: "Codex", slug: "switch-from-codex" },
  { label: "Conductor", slug: "switch-from-conductor" },
  { label: "Cursor", slug: "switch-from-cursor" },
  { label: "Superset", slug: "switch-from-superset" },
  { label: "T3 Code", slug: "switch-from-t3-code" },
  { label: "Vibe Kanban", slug: "switch-from-vibe-kanban" },
] as const;

const FOOTER_GUIDES = [
  { label: "Orchestrate coding agents", slug: "orchestrate-coding-agents" },
  {
    label: "Claude Code and Codex together",
    slug: "claude-code-and-codex-together",
  },
  { label: "Work from anywhere", slug: "work-from-anywhere" },
  { label: "Remote dev servers", slug: "remote-dev-servers" },
  { label: "Run an agent on a schedule", slug: "run-an-agent-on-a-schedule" },
  { label: "Agent browser", slug: "agent-browser" },
] as const;

function useReveal(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;

    if (!element) return;
    const targets = element.querySelectorAll<HTMLElement>("[data-reveal]");

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

function useDarkNav(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    const band = element?.querySelector(".o2-private-inner");

    if (!element || !band) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        element.toggleAttribute(
          "data-nav-dark",
          entry?.isIntersecting ?? false,
        );
      },
      { rootMargin: "-40px 0px -92% 0px" },
    );

    observer.observe(band);

    return () => observer.disconnect();
  }, [root]);
}

function DownloadButton({ size = "lg" }: { size?: "lg" | "sm" }) {
  return (
    <a className={`o2-download o2-download--${size}`} href={MACOS_DOWNLOAD_URL}>
      <span className="o2-download-label">
        {size === "lg" ? "Download for macOS" : "Download"}
      </span>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M10 3.5v10m0 0 4-4m-4 4-4-4M4 16.5h12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

function Requirements() {
  return (
    <p className="o2-requirements">
      <span>Free</span>
      <span>Open source</span>
      <span>Apple Silicon</span>
      <span>macOS 13 or later</span>
    </p>
  );
}

function Capability({
  title,
  href,
  linkLabel,
  className,
  art,
  children,
}: {
  title: string;
  href: string;
  linkLabel: string;
  className?: string;
  art: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className={`o2-card ${className ?? ""}`} data-reveal>
      <div className="o2-card-art" aria-hidden="true">
        {art}
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      <a className="o2-card-link" href={href}>
        {linkLabel}
        <span aria-hidden="true">→</span>
      </a>
    </article>
  );
}

export default function Page() {
  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<LensStatus>("loading");

  useReveal(rootRef);
  useDarkNav(rootRef);

  return (
    <div className="lab-o-2" ref={rootRef} data-lens={status}>
      <header className="o2-nav">
        <a className="o2-brand" href="/" aria-label="Omnyo home">
          <FlatMark className="o2-brand-mark" />
          <span>Omnyo</span>
        </a>
        <nav className="o2-nav-links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#capabilities">Capabilities</a>
          <a href="#private">Privacy</a>
          <a href="/plugin-guide">Plugins</a>
        </nav>
        <DownloadButton size="sm" />
      </header>

      <main>
        <section className="o2-hero" ref={heroRef} aria-labelledby="o2-title">
          <div className="o2-stage">
            <LensScene
              slotRef={slotRef}
              heroRef={heroRef}
              onStatus={setStatus}
            />
          </div>
          <div className="o2-hero-grid">
            <div className="o2-hero-copy">
              <p className="o2-eyebrow">
                <span className="o2-eyebrow-dot" />
                Omnyo for macOS
              </p>
              <h1 id="o2-title">
                All your coding agents.
                <em>One clear view.</em>
              </h1>
              <p className="o2-lead">
                Omnyo is the unified interface for coding agents. Run Claude
                Code and Codex side by side, each chat in its own thread, on
                machines you own.
              </p>
              <div className="o2-hero-actions">
                <DownloadButton />
                <a className="o2-ghost" href="#how">
                  See how it works
                </a>
              </div>
              <Requirements />
            </div>
            <div className="o2-slot" ref={slotRef}>
              <div className="o2-poster" aria-hidden="true">
                <img className="o2-poster-mark" src={lensMarkUrl} alt="" />
              </div>
              <p className="o2-callout" aria-hidden="true">
                <span className="o2-callout-line" />
                <span className="o2-callout-label">In focus</span>
                Codex reviewing a change from Claude Code
              </p>
            </div>
          </div>
          <div className="o2-hero-foot" aria-hidden="true">
            <span>Claude Code</span>
            <span className="o2-hero-foot-rule" />
            <span>Codex</span>
            <span className="o2-hero-foot-rule" />
            <span>Your machines</span>
          </div>
        </section>

        <section
          className="o2-section o2-how"
          id="how"
          aria-labelledby="o2-how-title"
        >
          <div className="o2-section-head" data-reveal>
            <p className="o2-kicker">01 · Orchestrate</p>
            <h2 id="o2-how-title">
              One agent builds.
              <em> Another reviews.</em>
            </h2>
            <p className="o2-section-lead">
              Hand a task to Claude Code. Ask Codex to review the work in its
              own thread. Then talk the findings through with the reviewer,
              right next to the build.
            </p>
          </div>

          <div className="o2-duo" data-reveal>
            <div className="o2-duo-chrome">
              <span className="o2-lights">
                <i />
                <i />
                <i />
              </span>
              <span className="o2-duo-repo">
                orbit-api <b>feat/upload-retries</b>
              </span>
            </div>
            <div className="o2-duo-panes">
              <article className="o2-pane">
                <header>
                  <span className="o2-agent o2-agent--claude">Claude Code</span>
                  <span className="o2-state o2-state--done">Done</span>
                </header>
                <h3>Add a retry budget to uploads</h3>
                <ol className="o2-steps">
                  <li className="done">Read src/upload/retry.ts</li>
                  <li className="done">Added a per-session retry budget</li>
                  <li className="done">Updated 4 tests in retry.test.ts</li>
                  <li className="done">Ran the upload tests</li>
                  <li className="now">Waiting for the Codex review</li>
                </ol>
                <div className="o2-term">
                  <span>$ pnpm test upload</span>
                  <span className="ok">✓ 18 passed</span>
                </div>
              </article>
              <article className="o2-pane o2-pane--review">
                <header>
                  <span className="o2-agent o2-agent--codex">Codex</span>
                  <span className="o2-state">Reviewing</span>
                </header>
                <h3>Review: upload retry budget</h3>
                <div className="o2-finding">
                  <b>1</b>
                  <p>
                    The budget is never reset after a successful upload, so long
                    sessions stop retrying.
                  </p>
                </div>
                <div className="o2-finding">
                  <b>2</b>
                  <p>
                    Delays line up across clients. Add jitter to the backoff.
                  </p>
                </div>
                <div className="o2-reply">
                  <span className="o2-reply-you">You</span>
                  <p>Reset per file or per session? Draft the change.</p>
                </div>
              </article>
            </div>
          </div>

          <ol className="o2-flow" data-reveal>
            <li>
              <span>Build</span>
              <p>Claude Code takes the task in its own thread.</p>
            </li>
            <li>
              <span>Review</span>
              <p>Codex checks the work in a separate thread.</p>
            </li>
            <li>
              <span>Discuss</span>
              <p>You ask the reviewer follow-up questions before you merge.</p>
            </li>
          </ol>
        </section>

        <section
          className="o2-section o2-capabilities"
          id="capabilities"
          aria-labelledby="o2-cap-title"
        >
          <div className="o2-section-head" data-reveal>
            <p className="o2-kicker">02 · Capabilities</p>
            <h2 id="o2-cap-title">
              The rest of the work,
              <em> in the same window.</em>
            </h2>
          </div>

          <div className="o2-bento">
            <Capability
              className="o2-card--wide"
              title="Claude Code and Codex, side by side"
              href="/guides/claude-code-and-codex-together"
              linkLabel="Use both together"
              art={
                <div className="art-duo">
                  <div className="art-thread">
                    <span className="art-chip art-chip--claude">
                      Claude Code
                    </span>
                    <b>Add a retry budget to uploads</b>
                    <span className="art-meta">
                      <i className="art-pulse art-pulse--build" />
                      Building · step 4 of 5
                    </span>
                  </div>
                  <div className="art-thread">
                    <span className="art-chip art-chip--codex">Codex</span>
                    <b>Review: upload retry budget</b>
                    <span className="art-meta">
                      <i className="art-pulse art-pulse--review" />
                      Reviewing · 2 notes so far
                    </span>
                  </div>
                </div>
              }
            >
              Use both agents in one workspace. Each chat runs in its own
              thread, so every conversation keeps its own history.
            </Capability>
            <Capability
              title="A dev server for every branch"
              href="/guides/remote-dev-servers"
              linkLabel="Run dev servers"
              art={
                <div className="art-branches">
                  <span>feat/search-filters</span>
                  <span>fix/upload-retries</span>
                  <span>main</span>
                </div>
              }
            >
              Start a dev server per branch and open each one from its live
              preview link.
            </Capability>
            <Capability
              title="Agents on a schedule"
              href="/guides/run-an-agent-on-a-schedule"
              linkLabel="Schedule an agent"
              art={
                <div className="art-week">
                  {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
                    <span
                      key={`${day}-${index}`}
                      className={index < 5 ? "on" : ""}
                    >
                      {day}
                    </span>
                  ))}
                  <em>09:00 issue triage</em>
                </div>
              }
            >
              Run an agent on a schedule, for example triaging new issues every
              weekday morning.
            </Capability>
            <Capability
              title="A real browser for your agent"
              href="/guides/agent-browser"
              linkLabel="Give agents a browser"
              art={
                <div className="art-browser">
                  <span className="art-browser-bar" />
                  <span className="art-browser-shot" />
                  <span className="art-browser-shot" />
                  <span className="art-cursor" />
                </div>
              }
            >
              Your agent clicks through a change in a real browser and shows you
              the screenshots.
            </Capability>
            <Capability
              title="Work from anywhere"
              href="/guides/work-from-anywhere"
              linkLabel="Set up remote access"
              art={
                <div className="art-phone">
                  <span className="art-phone-island" />
                  <span className="art-phone-card">
                    <span className="art-chip art-chip--codex">Codex</span>
                    <b>Review is ready</b>
                    <span>orbit-api · 2 notes</span>
                  </span>
                  <span className="art-phone-reply">Apply both notes</span>
                </div>
              }
            >
              Optional remote access with Omnyo Connect and a free account lets
              you follow and steer chats from another device.
            </Capability>
            <Capability
              className="o2-card--banner"
              title="Extend it with plugins"
              href="/plugin-guide"
              linkLabel="Read the Plugin Guide"
              art={
                <div className="art-plugins">
                  <span>
                    <i>/</i>Command
                  </span>
                  <span>
                    <i>{"{}"}</i>Agent tool
                  </span>
                  <span className="lit">
                    <i>＋</i>Your plugin
                  </span>
                  <span>
                    <i>▭</i>Panel
                  </span>
                </div>
              }
            >
              Add your own commands, tools and panels with plugins.
            </Capability>
          </div>
        </section>

        <section
          className="o2-section o2-private"
          id="private"
          aria-labelledby="o2-private-title"
        >
          <div className="o2-private-inner">
            <div className="o2-section-head" data-reveal>
              <p className="o2-kicker">03 · Private by design</p>
              <h2 id="o2-private-title">
                Your prompts take
                <em> the short route.</em>
              </h2>
              <p className="o2-section-lead">
                Prompts, code and files go to the Omnyo server you run, then to
                the AI provider you choose. Nothing is hosted by us in between.
              </p>
            </div>
            <ol className="o2-route" data-reveal>
              <li>
                <span className="o2-node">
                  <FlatMark className="o2-node-mark" />
                </span>
                <b>Omnyo on your Mac</b>
                <p>Where you write and read every chat.</p>
              </li>
              <li>
                <span className="o2-node o2-node--server" />
                <b>Your Omnyo server</b>
                <p>Runs on a machine you own.</p>
              </li>
              <li>
                <span className="o2-node o2-node--provider" />
                <b>Your AI provider</b>
                <p>The one you choose for each agent.</p>
              </li>
            </ol>
            <ul className="o2-facts" data-reveal>
              <li>No Omnyo account needed on your own machines</li>
              <li>Open source, built on bb (MIT License)</li>
              <li>Remote access is optional</li>
            </ul>
          </div>
        </section>

        <section
          className="o2-section o2-switch"
          aria-labelledby="o2-switch-title"
        >
          <div className="o2-switch-inner" data-reveal>
            <div>
              <p className="o2-kicker">04 · Switching</p>
              <h2 id="o2-switch-title">Coming from another tool?</h2>
              <p className="o2-section-lead">
                Migration guides for the tool you use today.
              </p>
            </div>
            <ul className="o2-switch-list">
              {SWITCH_GUIDES.map((guide) => (
                <li key={guide.slug}>
                  <a href={`/guides/${guide.slug}`}>
                    <span className="o2-switch-from">From</span>
                    {guide.label}
                    <span aria-hidden="true" className="o2-switch-arrow">
                      →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="o2-closing" aria-labelledby="o2-closing-title">
          <div className="o2-closing-glow" aria-hidden="true" />
          <img
            className="o2-closing-mark"
            src={lensMarkUrl}
            alt=""
            aria-hidden="true"
          />
          <h2 id="o2-closing-title" data-reveal>
            Bring your agents
            <em> into focus.</em>
          </h2>
          <p className="o2-section-lead" data-reveal>
            Free for your Mac, open source, and no Omnyo account needed to run
            it on your own machines.
          </p>
          <div className="o2-closing-actions" data-reveal>
            <DownloadButton />
          </div>
          <Requirements />
        </section>
      </main>

      <footer className="o2-footer">
        <div className="o2-footer-brand">
          <a className="o2-brand" href="/" aria-label="Omnyo home">
            <FlatMark className="o2-brand-mark" />
            <span>Omnyo</span>
          </a>
          <p>The unified interface for coding agents.</p>
        </div>
        <div className="o2-footer-col">
          <h2>Product</h2>
          <ul>
            <li>
              <a href={MACOS_DOWNLOAD_URL}>Download for macOS</a>
            </li>
            <li>
              <a href="/plugin-guide">Plugin Guide</a>
            </li>
          </ul>
        </div>
        <div className="o2-footer-col">
          <h2>Guides</h2>
          <ul>
            {FOOTER_GUIDES.map((guide) => (
              <li key={guide.slug}>
                <a href={`/guides/${guide.slug}`}>{guide.label}</a>
              </li>
            ))}
          </ul>
        </div>
        <div className="o2-footer-col">
          <h2>Legal</h2>
          <ul>
            <li>
              <a href="/terms">Terms</a>
            </li>
            <li>
              <a href="/privacy">Privacy</a>
            </li>
            <li>
              <a href="/imprint">Imprint</a>
            </li>
          </ul>
        </div>
        <div className="o2-footer-base">
          <span>
            Built on <a href={BB_URL}>bb</a> (MIT License)
          </span>
          <span>© 2026 Omnyo</span>
        </div>
      </footer>
    </div>
  );
}
