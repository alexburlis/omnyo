import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter-tight";
import "./styles.css";

import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import { EclipsePoster, FlatMark } from "./eclipse-mark";
import type EclipseSceneComponent from "./eclipse-scene";
import type { EclipseStatus } from "./eclipse-scene";
import {
  SceneAnywhere,
  SceneMachines,
  SceneReview,
  SceneSideBySide,
  StripBrowser,
  StripPlugins,
  StripPreview,
  StripSchedule,
} from "./scenes";

const TITLE_CARDS = ["Claude Code.", "Codex.", "One private workspace."];

const CHAPTERS = [
  {
    numeral: "I",
    name: "Side by side",
    contact: "C1",
    phase: "First contact",
    offset: 11,
    title: "Claude Code and Codex, side by side.",
    body: "Start chats with either agent and keep them open together. Every chat runs in its own thread, so one task never spills into another.",
    scene: <SceneSideBySide />,
  },
  {
    numeral: "II",
    name: "The second opinion",
    contact: "C1–C2",
    phase: "Partial",
    offset: 6.5,
    title: "One agent builds. Another reviews.",
    body: "Hand a finished task to a different agent for review. The review runs in its own thread, and you talk the findings through with the reviewer.",
    scene: <SceneReview />,
  },
  {
    numeral: "III",
    name: "Your machines",
    contact: "C2",
    phase: "Diamond ring",
    offset: 1.4,
    title: "It runs on your own machines.",
    body: "Prompts, code and files go to the Omnyo server you run, then to the AI provider you choose. Nothing is hosted by us in between, and you need no Omnyo account on your own machines.",
    scene: <SceneMachines />,
  },
  {
    numeral: "IV",
    name: "Anywhere",
    contact: "Max",
    phase: "Totality",
    offset: 0,
    title: "Leave your desk. Keep the thread.",
    body: "Turn on Omnyo Connect, the optional remote access, with a free account. Follow a running chat and steer it from another device.",
    scene: <SceneAnywhere />,
  },
] as const;

const SUPPORTING = [
  {
    title: "A dev server for every branch",
    body: "Each branch runs its own dev server with a live preview link.",
    visual: <StripPreview />,
  },
  {
    title: "Agents on a schedule",
    body: "Run an agent on a timer, such as issue triage every weekday morning.",
    visual: <StripSchedule />,
  },
  {
    title: "A real browser",
    body: "Your agent clicks through a change in a real browser and shows you screenshots.",
    visual: <StripBrowser />,
  },
  {
    title: "Plugins",
    body: "Extend Omnyo with plugins when your workflow needs something more.",
    visual: <StripPlugins />,
  },
] as const;

const SWITCH_GUIDES = [
  { label: "Claude Code", slug: "switch-from-claude-code" },
  { label: "Codex", slug: "switch-from-codex" },
  { label: "Conductor", slug: "switch-from-conductor" },
  { label: "Cursor", slug: "switch-from-cursor" },
  { label: "Superset", slug: "switch-from-superset" },
  { label: "T3 Code", slug: "switch-from-t3-code" },
  { label: "Vibe Kanban", slug: "switch-from-vibe-kanban" },
] as const;

const MORE_GUIDES = [
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

const RECORD = [
  ["Agents", "Claude Code and Codex, each chat in its own thread"],
  ["Runs on", "Your own machines"],
  ["Data path", "Your Omnyo server, then the AI provider you choose"],
  ["Remote access", "Optional, with Omnyo Connect and a free account"],
  ["Also", "Branch previews, schedules, a real browser, plugins"],
  ["Platform", "macOS 13 or later on Apple Silicon"],
  ["Account", "None needed on your own machines"],
  ["Price", "Free to use"],
] as const;

const GRATICULE_TICKS = Array.from({ length: 72 }, (_, index) => index * 5);

type Stage = "is-waiting" | "is-rolling" | "is-still";

function useStage() {
  const [stage, setStage] = useState<Stage>("is-waiting");

  useEffect(() => {
    setStage(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "is-still"
        : "is-rolling",
    );
  }, []);

  return stage;
}

function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;

    if (!element) return;
    const targets = element.querySelectorAll<HTMLElement>("[data-reveal]");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );

    for (const target of targets) observer.observe(target);

    return () => observer.disconnect();
  }, [root]);
}

function universalTime() {
  return new Date().toISOString().slice(11, 21);
}

function useUniversalClock(target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = target.current;

    if (!element) return;
    element.textContent = universalTime();

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let visible = true;

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });

    observer.observe(element);

    const timer = window.setInterval(() => {
      if (visible) element.textContent = universalTime();
    }, 100);

    return () => {
      window.clearInterval(timer);
      observer.disconnect();
    };
  }, [target]);
}

function Graticule() {
  return (
    <svg
      className="e3-graticule"
      viewBox="-120 -120 240 240"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="e3-graticule-ring" r="96" />
      <circle className="e3-graticule-ring e3-graticule-ring--inner" r="70" />
      {GRATICULE_TICKS.map((angle) => {
        const major = angle % 30 === 0;
        const radians = ((angle - 90) * Math.PI) / 180;
        const from = major ? 89 : 92.5;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);

        return (
          <line
            key={angle}
            className={major ? "e3-tick e3-tick--major" : "e3-tick"}
            x1={from * cos}
            y1={from * sin}
            x2={96 * cos}
            y2={96 * sin}
          />
        );
      })}
      {[0, 90, 270].map((angle) => {
        const radians = ((angle - 90) * Math.PI) / 180;

        return (
          <text
            key={angle}
            className="e3-graticule-label"
            x={106 * Math.cos(radians)}
            y={106 * Math.sin(radians)}
          >
            {angle}°
          </text>
        );
      })}
    </svg>
  );
}

function PhaseGlyph({ offset }: { offset: number }) {
  return (
    <svg className="e3-phase-glyph" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="7.5" className="e3-phase-sun" />
      <circle
        cx={12 + offset}
        cy={12 - offset * 0.35}
        r="7.6"
        className="e3-phase-moon"
      />
      {offset > 0 && offset < 2 ? (
        <circle cx={12 + 5.3} cy={12 - 5.3} r={1.6} className="e3-phase-bead" />
      ) : null}
    </svg>
  );
}

function DownloadButton({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <a className={`e3-download ${className ?? ""}`} href={MACOS_DOWNLOAD_URL}>
      <span className="e3-download-glow" aria-hidden="true" />
      <span className="e3-download-label">{children}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M8 2.5v8m0 0L4.5 7M8 10.5 11.5 7M3 13.5h10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

export default function Page() {
  const rootRef = useRef<HTMLElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const timecodeRef = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<EclipseStatus | "loading">("loading");
  const [startedAt] = useState(() => performance.now());

  const [Scene, setScene] = useState<typeof EclipseSceneComponent | null>(null);

  useEffect(() => {
    let cancelled = false;

    import("./eclipse-scene")
      .then((module) => {
        if (!cancelled) setScene(() => module.default);
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });

    return () => {
      cancelled = true;
    };
  }, []);
  const stage = useStage();

  useReveal(rootRef);
  useUniversalClock(timecodeRef);

  return (
    <main
      ref={rootRef}
      className={`lab-eclipse-3 ${stage} is-${status}`}
      aria-label="Omnyo"
    >
      <header className="e3-nav">
        <a className="e3-brand" href="#top" aria-label="Omnyo, back to top">
          <FlatMark className="e3-brand-mark" />
          <span>Omnyo</span>
        </a>
        <nav aria-label="Primary">
          <a href="#story">The story</a>
          <a href="#cast">Features</a>
          <a href="#guides">Guides</a>
          <a className="e3-nav-download" href={MACOS_DOWNLOAD_URL}>
            Download
          </a>
        </nav>
      </header>

      <section className="e3-hero" id="top" aria-labelledby="e3-title">
        {Scene ? (
          <Scene slotRef={slotRef} onStatus={setStatus} startedAt={startedAt} />
        ) : null}

        <div className="e3-hero-inner">
          <div ref={slotRef} className="e3-slot">
            <Graticule />
            <EclipsePoster />
          </div>

          <div className="e3-hero-copy">
            <div className="e3-cards" aria-hidden="true">
              {TITLE_CARDS.map((card, index) => (
                <p key={card} className={`e3-card e3-card--${index + 1}`}>
                  {card}
                </p>
              ))}
            </div>
            <div className="e3-title">
              <p className="e3-eyebrow">
                <span>Omnyo</span> for macOS
              </p>
              <h1 id="e3-title">The unified interface for coding agents.</h1>
              <p className="e3-lede">
                Run Claude Code and Codex side by side on your own machines,
                each chat in its own thread. Free to use.
              </p>
              <div className="e3-actions">
                <DownloadButton>Download for macOS</DownloadButton>
                <a className="e3-ghost" href="#story">
                  See how it works
                </a>
              </div>
              <p className="e3-meta">
                <span>Apple Silicon</span>
                <i />
                <span>macOS 13 or later</span>
                <i className="e3-meta-break" />
                <span>No Omnyo account needed</span>
              </p>
            </div>
          </div>
        </div>

        <div className="e3-hero-foot" aria-hidden="true">
          <span className="e3-rec">
            <i />
            UT <span ref={timecodeRef}>--:--:--.-</span>
          </span>
          <span className="e3-plate">Plate I · Totality · White light</span>
          <span className="e3-scroll">Scroll for the story</span>
        </div>
      </section>

      <section className="e3-prologue" id="story" aria-labelledby="e3-story">
        <p className="e3-label" data-reveal>
          The story, in four phases
        </p>
        <h2 id="e3-story" data-reveal>
          Your agents, your machines,
          <br />
          <em>one workspace.</em>
        </h2>
        <p className="e3-prologue-body" data-reveal>
          Omnyo is a Mac app that brings your coding agents together. Here is
          what a working day with it looks like.
        </p>
      </section>

      {CHAPTERS.map((chapter, index) => (
        <section
          key={chapter.numeral}
          className={`e3-chapter e3-chapter--${index + 1}`}
          aria-labelledby={`e3-chapter-${index + 1}`}
        >
          <div className="e3-chapter-head" data-reveal>
            <div className="e3-chapter-mark">
              <span className="e3-numeral">{chapter.numeral}</span>
              <span className="e3-chapter-name">
                Chapter {chapter.numeral}
                <b>{chapter.name}</b>
              </span>
            </div>
            <h3 id={`e3-chapter-${index + 1}`}>{chapter.title}</h3>
            <p>{chapter.body}</p>
          </div>
          <figure className="e3-frame" data-reveal>
            <div className="e3-frame-light" aria-hidden="true" />
            <div className="e3-frame-marks" aria-hidden="true" />
            <div className="e3-frame-scene">{chapter.scene}</div>
            <figcaption className="e3-frame-caption" aria-hidden="true">
              <span>
                Pl. {String(index + 2).padStart(2, "0")} / {chapter.name}
              </span>
              <span className="e3-phase">
                <PhaseGlyph offset={chapter.offset} />
                {chapter.phase}
              </span>
              <span className="e3-contact">{chapter.contact}</span>
            </figcaption>
          </figure>
        </section>
      ))}

      <section className="e3-cast" id="cast" aria-labelledby="e3-cast-title">
        <div className="e3-cast-head" data-reveal>
          <p className="e3-label">Also in Omnyo</p>
          <h2 id="e3-cast-title">
            More, in <em>the same app.</em>
          </h2>
        </div>
        <div className="e3-strip" data-reveal>
          <div className="e3-strip-track">
            {SUPPORTING.map((item, index) => (
              <article key={item.title} className="e3-strip-frame">
                <span className="e3-strip-index" aria-hidden="true">
                  Pl. {String(index + 6).padStart(2, "0")}
                </span>
                <div className="e3-strip-visual" aria-hidden="true">
                  {item.visual}
                </div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        className="e3-guides"
        id="guides"
        aria-labelledby="e3-guides-title"
      >
        <div className="e3-guides-head" data-reveal>
          <p className="e3-label">Switching over</p>
          <h2 id="e3-guides-title">
            Coming from <em>another tool?</em>
          </h2>
          <p>
            Each guide walks you through moving your work into Omnyo, step by
            step.
          </p>
        </div>
        <ul className="e3-guide-list" data-reveal>
          {SWITCH_GUIDES.map((guide, index) => (
            <li key={guide.slug}>
              <a href={`/guides/${guide.slug}`}>
                <span className="e3-guide-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="e3-guide-from">From</span>
                <span className="e3-guide-name">{guide.label}</span>
                <span className="e3-guide-go" aria-hidden="true">
                  Read the guide
                  <svg viewBox="0 0 16 16" focusable="false">
                    <path
                      d="M3 8h10m0 0L9 4m4 4-4 4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </a>
            </li>
          ))}
        </ul>
        <div className="e3-more" data-reveal>
          <span className="e3-more-label">More guides</span>
          {MORE_GUIDES.map((guide) => (
            <a key={guide.slug} href={`/guides/${guide.slug}`}>
              {guide.label}
            </a>
          ))}
        </div>
      </section>

      <section className="e3-finale" aria-labelledby="e3-finale-title">
        <div className="e3-finale-eclipse" data-reveal>
          <Graticule />
          <EclipsePoster className="e3-poster--finale" />
        </div>
        <div className="e3-finale-copy" data-reveal>
          <p className="e3-label">Free for macOS</p>
          <h2 id="e3-finale-title">
            Bring your coding agents <em>together.</em>
          </h2>
          <p>
            Free to use, for Macs with Apple Silicon running macOS 13 or later.
          </p>
          <DownloadButton className="e3-download--large">
            Download Omnyo for macOS
          </DownloadButton>
        </div>
        <div className="e3-record" data-reveal>
          <p className="e3-record-head">
            <span>Omnyo</span>
            <span>At a glance</span>
          </p>
          <dl>
            {RECORD.map(([term, value]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <footer className="e3-footer">
        <div className="e3-footer-brand">
          <FlatMark className="e3-brand-mark" />
          <span>Omnyo</span>
        </div>
        <p>
          Built on{" "}
          <a href={BB_URL} rel="noreferrer">
            bb
          </a>{" "}
          (MIT License)
        </p>
        <nav aria-label="Legal">
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/imprint">Imprint</a>
        </nav>
        <p className="e3-copyright">© 2026 Omnyo</p>
      </footer>
    </main>
  );
}
