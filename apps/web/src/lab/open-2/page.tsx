import "./styles.css";

import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import {
  AppleIcon,
  ArrowRight,
  BranchIcon,
  Check,
  ProviderGlyph,
} from "./icons";
import { Orb } from "./orb";
import type { Provider } from "./threads";
import { Workspace } from "./workspace";

const SWITCH_GUIDES = [
  { name: "Claude Code", slug: "switch-from-claude-code" },
  { name: "Codex", slug: "switch-from-codex" },
  { name: "Conductor", slug: "switch-from-conductor" },
  { name: "Cursor", slug: "switch-from-cursor" },
  { name: "Superset", slug: "switch-from-superset" },
  { name: "T3 Code", slug: "switch-from-t3-code" },
  { name: "Vibe Kanban", slug: "switch-from-vibe-kanban" },
];

const PLUGINS = [
  { name: "Release notes", detail: "Thread action", hue: 28, state: "on" },
  { name: "Standup summary", detail: "Agent tool", hue: 250, state: "on" },
  { name: "Ticket links", detail: "Side panel", hue: 160, state: "new" },
];

function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={(size * 405) / 507}
      viewBox="0 0 507 405"
      aria-hidden="true"
    >
      <g transform="translate(55.05 4.05) scale(6.2015625)">
        <path
          d="M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z"
          fill="currentColor"
        />
        <circle cx="49.5" cy="14.5" r="6.5" fill="currentColor" />
      </g>
    </svg>
  );
}

function DownloadButton({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <a className={`o2-dl-btn o2-dl-btn--${size}`} href={MACOS_DOWNLOAD_URL}>
      <AppleIcon />
      Download for macOS
    </a>
  );
}

function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = root.current;

    if (!node) return;
    const targets = node.querySelectorAll<HTMLElement>("[data-reveal]");

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const target of targets) target.classList.add("is-in");

      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );

    for (const target of targets) observer.observe(target);

    return () => observer.disconnect();
  }, [root]);
}

function Chip({ provider }: { provider: Provider }) {
  return (
    <span className={`o2-ichip o2-ichip--${provider}`}>
      <ProviderGlyph provider={provider} size={16} />
      {provider === "claude" ? "Claude Code" : "Codex"}
    </span>
  );
}

function LanesVisual() {
  const lanes = [
    {
      provider: "claude" as const,
      title: "Keep drafts when offline",
      steps: [
        "Read 4 files",
        "Edited draftStore.ts",
        "Edited Draft.tsx",
        "pnpm test drafts",
      ],
      message: "Drafts now stay on the device until sync is back.",
    },
    {
      provider: "codex" as const,
      title: "Fix flaky sync test",
      steps: [
        "vitest --repeat 50",
        "Found the timer race",
        "Edited sync.retry.test.ts",
        "50 of 50 passed",
      ],
      message: "Fixed. Only the test depended on timing.",
    },
  ];

  return (
    <div className="o2-vis o2-lanes" aria-hidden="true">
      {lanes.map((lane, laneIndex) => (
        <div key={lane.title} className={`o2-lane o2-lane--${lane.provider}`}>
          <div className="o2-lane-head">
            <ProviderGlyph provider={lane.provider} size={14} />
            <span>{lane.provider === "claude" ? "Claude Code" : "Codex"}</span>
            <em>Running</em>
          </div>
          <b className="o2-lane-title">{lane.title}</b>
          <ol>
            {lane.steps.map((step, index) => (
              <li
                key={step}
                style={
                  {
                    "--d": `${index * 0.9 + laneIndex * 0.45}s`,
                  } as CSSProperties
                }
              >
                <span className="o2-lane-tick">
                  <Check size={10} />
                </span>
                {step}
              </li>
            ))}
          </ol>
          <p
            className="o2-lane-msg"
            style={{ "--d": `${3.6 + laneIndex * 0.45}s` } as CSSProperties}
          >
            {lane.message}
          </p>
          <div className="o2-lane-bar">
            <i style={{ "--d": `${laneIndex * 0.45}s` } as CSSProperties} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewVisual() {
  return (
    <div className="o2-vis o2-review" aria-hidden="true">
      <div className="o2-rv-thread o2-rv-thread--build">
        <ProviderGlyph provider="claude" size={14} />
        <span>
          <b>Keep drafts when offline</b>
          Claude Code · Builder
        </span>
        <em>Ready for review</em>
      </div>
      <div className="o2-rv-link">
        <i />
        <span>Handed to a different agent</span>
      </div>
      <div className="o2-rv-card">
        <div className="o2-rv-thread o2-rv-thread--review">
          <ProviderGlyph provider="codex" size={14} />
          <span>
            <b>Review offline drafts</b>
            Codex · Reviewer
          </span>
          <em className="o2-rv-needs">Needs you</em>
        </div>
        <p className="o2-rv-agent">
          One issue: queued drafts never upload after a restart.
        </p>
        <p className="o2-rv-user">Is retrying on startup enough?</p>
        <p className="o2-rv-agent">
          Yes. Call <code>flushDrafts()</code> once the store opens.
        </p>
      </div>
    </div>
  );
}

function PreviewsVisual() {
  const branches = [
    { branch: "share-sheet", port: 5175, title: "Day 3: Alfama" },
    { branch: "fix-sync-retry", port: 5174, title: "Sync status" },
    { branch: "offline-drafts", port: 5173, title: "Ferry timetable" },
  ];

  return (
    <div className="o2-vis o2-previews" aria-hidden="true">
      {branches.map((entry, index) => (
        <div
          key={entry.branch}
          className="o2-pv"
          style={{ "--i": index } as CSSProperties}
        >
          <div className="o2-pv-bar">
            <span className="o2-pv-branch">
              <BranchIcon />
              {entry.branch}
            </span>
            <span className="o2-pv-url">localhost:{entry.port}</span>
            <span className="o2-live">
              <i />
              Live
            </span>
          </div>
          {index === branches.length - 1 ? (
            <div className="o2-pv-body o2-pv-body--live">
              <span className="o2-pv-side">
                <b className="o2-pv-note o2-pv-note--on">Ferry timetable</b>
                <b className="o2-pv-note">Day 3: Alfama</b>
                <b className="o2-pv-note">Packing list</b>
              </span>
              <span className="o2-pv-main">
                <span className="o2-pv-saved">
                  <Check size={9} />
                  Saved on this device
                </span>
                <b>{entry.title}</b>
                <span className="o2-pv-text">
                  08:40 Cais do Sodré to Cacilhas, then every 20 minutes.
                </span>
                <span className="o2-pv-text">Last ferry back is 21:00.</span>
              </span>
              <i className="o2-pv-reload" />
            </div>
          ) : (
            <div className="o2-pv-body">
              <span className="o2-pv-side">
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="o2-pv-main">
                <b>{entry.title}</b>
                <i style={{ width: "86%" }} />
                <i style={{ width: "64%" }} />
                <i style={{ width: "74%" }} />
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FlowVisual() {
  return (
    <div className="o2-flow" aria-hidden="true">
      <div className="o2-node">
        <span className="o2-node-icon">
          <AppleIcon />
        </span>
        <b>Your Mac</b>
        <span>Omnyo app</span>
      </div>
      <div className="o2-wire">
        <i />
        <i />
      </div>
      <div className="o2-node o2-node--server">
        <span className="o2-node-icon">
          <Mark size={18} />
        </span>
        <b>Your Omnyo server</b>
        <span>On a machine you run</span>
      </div>
      <div className="o2-wire">
        <i />
        <i />
      </div>
      <div className="o2-node">
        <span className="o2-node-icon o2-node-icon--pair">
          <ProviderGlyph provider="claude" size={15} />
          <ProviderGlyph provider="codex" size={15} />
        </span>
        <b>Your AI provider</b>
        <span>The one you choose</span>
      </div>
    </div>
  );
}

export default function Page() {
  const root = useRef<HTMLElement>(null);
  const [provider, setProvider] = useState<Provider>("claude");
  const [scrolled, setScrolled] = useState(false);

  const onProviderChange = useCallback(
    (next: Provider) => setProvider(next),
    [],
  );

  useReveal(root);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 12);
    update();
    window.addEventListener("scroll", update, { passive: true });

    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <main ref={root} className={`lab-open-2 o2-mood--${provider}`}>
      <header className={scrolled ? "o2-nav o2-nav--solid" : "o2-nav"}>
        <a className="o2-brand" href="/">
          <Mark />
          Omnyo
        </a>
        <nav className="o2-nav-links" aria-label="Main">
          <a href="#story">How it works</a>
          <a href="#private">Privacy</a>
          <a href="/guides/orchestrate-coding-agents">Guides</a>
          <a href="/plugin-guide">Plugins</a>
        </nav>
        <a className="o2-nav-cta" href={MACOS_DOWNLOAD_URL}>
          Download
        </a>
      </header>

      <section className="o2-hero">
        <div className="o2-aura" aria-hidden="true">
          <i className="o2-aura-claude" />
          <i className="o2-aura-codex" />
          <i className="o2-aura-base" />
        </div>
        <div className="o2-hero-copy">
          <div className="o2-hero-left">
            <p className="o2-eyebrow">
              <span className="o2-eyebrow-dot" />
              Free to use · for macOS
            </p>
            <h1 className="o2-h1">
              Your coding agents,
              <br />
              <span className="o2-h1-pair">
                <span className="o2-w o2-w--claude">side</span>{" "}
                <span className="o2-w o2-w--by">by</span>{" "}
                <span className="o2-w o2-w--codex">
                  side<span className="o2-w-dot">.</span>
                </span>
              </span>
            </h1>
          </div>
          <div className="o2-hero-right">
            <p className="o2-lede">
              Omnyo runs Claude Code and Codex in parallel threads on your own
              Mac. One agent builds, another reviews, and every branch gets a
              live preview.
            </p>
            <div className="o2-cta-row">
              <DownloadButton />
              <a className="o2-ghost" href="#story">
                How it works
                <ArrowRight />
              </a>
            </div>
            <p className="o2-fine">
              Apple Silicon · macOS 13 or later
              <span className="o2-fine-extra"> · No Omnyo account needed</span>
            </p>
          </div>
        </div>

        <div className="o2-stage">
          <span className="o2-stage-note">
            <i />
            Live demo
            <span className="o2-for-pointer">· hover a thread</span>
            <span className="o2-for-touch">· tap a thread</span>
          </span>
          <Workspace onProviderChange={onProviderChange} />
        </div>
        <div className="o2-legend">
          <p>
            <b>Threads</b>
            Every chat runs in its own thread.
            <span className="o2-for-pointer">
              {" "}
              Hover or click one to switch.
            </span>
            <span className="o2-for-touch"> Tap one to switch.</span>
          </p>
          <p>
            <b>Chat</b>
            Watch each agent read, edit and test, and reply when it needs you.
          </p>
          <p>
            <b>Side panel</b>
            The branch preview, diff, terminal or browser for that thread.
          </p>
        </div>
      </section>

      <section className="o2-statement" id="story">
        <p className="o2-kicker" data-reveal>
          How it works
        </p>
        <p className="o2-big" data-reveal>
          Start a task with <Chip provider="claude" /> in one thread. Hand the
          result to <Chip provider="codex" /> for review and talk it through.
          Then open the branch in its own live preview at{" "}
          <span className="o2-ichip o2-ichip--url">
            <i />
            localhost:5173
          </span>
          .
        </p>
      </section>

      <section className="o2-features">
        <article className="o2-feature" data-reveal>
          <div className="o2-feature-copy">
            <span className="o2-num">01</span>
            <h2>Claude Code and Codex in one list</h2>
            <p>
              Each chat runs in its own thread, so Codex can chase a flaky test
              while Claude Code finishes a feature. You see what every agent is
              doing and switch between them with one click.
            </p>
            <a
              className="o2-link"
              href="/guides/claude-code-and-codex-together"
            >
              Use Claude Code and Codex together
              <ArrowRight />
            </a>
          </div>
          <LanesVisual />
        </article>

        <article className="o2-feature o2-feature--flip" data-reveal>
          <div className="o2-feature-copy">
            <span className="o2-num">02</span>
            <h2>A second agent reviews the first</h2>
            <p>
              When one agent finishes a task, a different agent reviews it in
              its own thread. You talk the findings through with the reviewer,
              the way you would with a colleague.
            </p>
            <a className="o2-link" href="/guides/orchestrate-coding-agents">
              Orchestrate coding agents
              <ArrowRight />
            </a>
          </div>
          <ReviewVisual />
        </article>

        <article className="o2-feature" data-reveal>
          <div className="o2-feature-copy">
            <span className="o2-num">03</span>
            <h2>A live preview for every branch</h2>
            <p>
              Omnyo runs a dev server for each branch and gives you a preview
              link, so you can check the work in a browser while the agent is
              still going.
            </p>
            <a className="o2-link" href="/guides/remote-dev-servers">
              Run dev servers per branch
              <ArrowRight />
            </a>
          </div>
          <PreviewsVisual />
        </article>
      </section>

      <section className="o2-private" id="private">
        <div className="o2-private-inner">
          <p className="o2-kicker o2-kicker--dark" data-reveal>
            Private by design
          </p>
          <h2 className="o2-h2" data-reveal>
            Your machines. Your server.
            <br />
            Your choice of provider.
          </h2>
          <p className="o2-private-lede" data-reveal>
            Prompts, code and files go from your Mac to the Omnyo server you
            run, then to the AI provider you choose. Nothing is hosted by us in
            between.
          </p>
          <div data-reveal>
            <FlowVisual />
          </div>
          <ul className="o2-facts" data-reveal>
            <li>
              <b>Free</b>
              <span>Free to download and use.</span>
            </li>
            <li>
              <b>Open source</b>
              <span>Built on bb (MIT License).</span>
            </li>
            <li>
              <b>No Omnyo account</b>
              <span>Not needed on your own machines.</span>
            </li>
            <li>
              <b>Made for macOS</b>
              <span>Apple Silicon, macOS 13 or later.</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="o2-more">
        <div className="o2-more-head" data-reveal>
          <p className="o2-kicker">Also in the workspace</p>
          <h2 className="o2-h2 o2-h2--ink">More ways to put agents to work.</h2>
        </div>
        <div className="o2-bento">
          <a
            className="o2-tile o2-tile--remote"
            href="/guides/work-from-anywhere"
            data-reveal
          >
            <div className="o2-tile-vis" aria-hidden="true">
              <div className="o2-phone">
                <span className="o2-phone-notch" />
                <span className="o2-phone-head">plover-web</span>
                <span className="o2-phone-row o2-phone-row--run">
                  <i />
                  Keep drafts when offline
                </span>
                <span className="o2-phone-row o2-phone-row--needs">
                  <i />
                  Review offline drafts
                </span>
                <span className="o2-phone-row">
                  <i />
                  Fix flaky sync test
                </span>
                <span className="o2-phone-input">Reply to the reviewer…</span>
              </div>
            </div>
            <h3>Work from anywhere</h3>
            <p>
              Follow and steer chats from another device with Omnyo Connect.
              Optional, with a free account.
            </p>
            <span className="o2-tile-more">
              Read the guide
              <ArrowRight />
            </span>
          </a>
          <a
            className="o2-tile o2-tile--sched"
            href="/guides/run-an-agent-on-a-schedule"
            data-reveal
          >
            <div className="o2-tile-vis" aria-hidden="true">
              <div className="o2-sched">
                <span className="o2-sched-time">09:00</span>
                <span className="o2-sched-days">
                  {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
                    <i
                      key={`${day}-${index}`}
                      className={index < 5 ? "on" : undefined}
                    >
                      {day}
                    </i>
                  ))}
                </span>
                <span className="o2-sched-task">Weekday issue triage</span>
              </div>
            </div>
            <h3>Run agents on a schedule</h3>
            <p>
              Triage new issues every weekday morning, or any task you repeat.
            </p>
            <span className="o2-tile-more">
              Read the guide
              <ArrowRight />
            </span>
          </a>
          <a
            className="o2-tile o2-tile--browser"
            href="/guides/agent-browser"
            data-reveal
          >
            <div className="o2-tile-vis" aria-hidden="true">
              <div className="o2-snaps">
                <span className="o2-snap o2-snap--a">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="o2-snap o2-snap--b">
                  <i />
                  <i />
                </span>
                <span className="o2-snap-cursor" />
              </div>
            </div>
            <h3>An agent with a real browser</h3>
            <p>Your agent clicks through a change and shows you screenshots.</p>
            <span className="o2-tile-more">
              Read the guide
              <ArrowRight />
            </span>
          </a>
          <a
            className="o2-tile o2-tile--plugins"
            href="/plugin-guide"
            data-reveal
          >
            <div className="o2-tile-vis" aria-hidden="true">
              <div className="o2-plugs">
                {PLUGINS.map((plugin) => (
                  <span
                    key={plugin.name}
                    className={`o2-plug o2-plug--${plugin.state}`}
                    style={{ "--h": plugin.hue } as CSSProperties}
                  >
                    <i className="o2-plug-ic">{plugin.name.slice(0, 1)}</i>
                    <span>
                      <b>{plugin.name}</b>
                      {plugin.detail}
                    </span>
                    <em className="o2-toggle" />
                  </span>
                ))}
              </div>
            </div>
            <h3>Extend it with plugins</h3>
            <p>Add the tools your workflow needs, or build your own.</p>
            <span className="o2-tile-more">
              Open the Plugin Guide
              <ArrowRight />
            </span>
          </a>
        </div>
      </section>

      <section className="o2-switch" data-reveal>
        <h2>Coming from another tool?</h2>
        <div className="o2-switch-list">
          {SWITCH_GUIDES.map((guide) => (
            <a key={guide.slug} href={`/guides/${guide.slug}`}>
              {guide.name}
              <ArrowRight />
            </a>
          ))}
        </div>
      </section>

      <section className="o2-close">
        <Orb />
        <div className="o2-close-copy" data-reveal>
          <h2 className="o2-h2 o2-h2--ink">
            Bring your agents
            <br />
            into one workspace.
          </h2>
          <DownloadButton size="lg" />
          <p className="o2-fine">
            Free to use · Apple Silicon · macOS 13 or later
          </p>
        </div>
      </section>

      <footer className="o2-footer">
        <div className="o2-footer-brand">
          <Mark size={20} />
          <span>Omnyo</span>
          <p>The unified interface for coding agents.</p>
        </div>
        <nav className="o2-footer-links" aria-label="Footer">
          <a href={MACOS_DOWNLOAD_URL}>Download</a>
          <a href="/guides/orchestrate-coding-agents">Guides</a>
          <a href="/plugin-guide">Plugin Guide</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/imprint">Imprint</a>
        </nav>
        <p className="o2-footer-legal">
          Built on <a href={BB_URL}>bb</a> (MIT License) · © 2026 Omnyo
        </p>
      </footer>
    </main>
  );
}
