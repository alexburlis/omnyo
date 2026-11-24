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
    timecode: "01:00:04:12",
    phase: "First contact",
    offset: 11,
    title: "Claude Code and Codex, side by side.",
    body: "Start chats with either agent and keep them open together. Every chat runs in its own thread, so one task never spills into another.",
    scene: <SceneSideBySide />,
  },
  {
    numeral: "II",
    name: "The second opinion",
    timecode: "01:07:21:03",
    phase: "Partial",
    offset: 6.5,
    title: "One agent builds. Another reviews.",
    body: "Hand a finished task to a different agent for review. The review runs in its own thread, and you talk the findings through with the reviewer.",
    scene: <SceneReview />,
  },
  {
    numeral: "III",
    name: "Your machines",
    timecode: "01:15:48:20",
    phase: "Diamond ring",
    offset: 1.4,
    title: "It runs on your own machines.",
    body: "Prompts, code and files go to the Omnyo server you run, then to the AI provider you choose. Nothing is hosted by us in between, and you need no Omnyo account on your own machines.",
    scene: <SceneMachines />,
  },
  {
    numeral: "IV",
    name: "Anywhere",
    timecode: "01:26:02:09",
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

const BILLING = [
  ["Works with ", "*Claude Code", " and ", "*Codex"],
  ["Runs on your own machines"],
  ["Each chat in its own thread"],
  ["One agent builds, another reviews"],
  ["Optional remote access with ", "*Omnyo Connect"],
  ["A dev server for every branch"],
  ["Agents on a schedule"],
  ["A real browser"],
  ["Plugins"],
  ["A macOS app for Apple Silicon"],
  ["macOS 13 or later"],
  ["Free"],
  ["Open source"],
] as const;

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

function useTimecode(target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = target.current;

    if (
      !element ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    let frame = 0;
    let visible = true;
    const started = performance.now();
    const pad = (value: number) => String(value).padStart(2, "0");

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });

    observer.observe(element);

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      if (!visible) return;
      const total = (now - started) / 1000;
      const frames = Math.floor((total % 1) * 24);
      const seconds = Math.floor(total) % 60;
      const minutes = Math.floor(total / 60) % 60;
      element.textContent = `00:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [target]);
}

function PhaseGlyph({ offset }: { offset: number }) {
  return (
    <svg className="o1-phase-glyph" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="7.5" className="o1-phase-sun" />
      <circle
        cx={12 + offset}
        cy={12 - offset * 0.35}
        r="7.6"
        className="o1-phase-moon"
      />
      {offset > 0 && offset < 2 ? (
        <circle cx={12 + 5.3} cy={12 - 5.3} r={1.6} className="o1-phase-bead" />
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
    <a className={`o1-download ${className ?? ""}`} href={MACOS_DOWNLOAD_URL}>
      <span className="o1-download-glow" aria-hidden="true" />
      <span className="o1-download-label">{children}</span>
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
  useTimecode(timecodeRef);

  return (
    <main
      ref={rootRef}
      className={`lab-o-1 ${stage} is-${status}`}
      aria-label="Omnyo"
    >
      <header className="o1-nav">
        <a className="o1-brand" href="#top" aria-label="Omnyo, back to top">
          <FlatMark className="o1-brand-mark" />
          <span>Omnyo</span>
        </a>
        <nav aria-label="Primary">
          <a href="#story">The story</a>
          <a href="#cast">Features</a>
          <a href="#guides">Guides</a>
          <a className="o1-nav-download" href={MACOS_DOWNLOAD_URL}>
            Download
          </a>
        </nav>
      </header>

      <section className="o1-hero" id="top" aria-labelledby="o1-title">
        {Scene ? (
          <Scene slotRef={slotRef} onStatus={setStatus} startedAt={startedAt} />
        ) : null}
        <div className="o1-bar o1-bar--top" aria-hidden="true" />
        <div className="o1-bar o1-bar--bottom" aria-hidden="true" />

        <div className="o1-hero-inner">
          <div ref={slotRef} className="o1-slot">
            <EclipsePoster />
          </div>

          <div className="o1-hero-copy">
            <div className="o1-cards" aria-hidden="true">
              {TITLE_CARDS.map((card, index) => (
                <p key={card} className={`o1-card o1-card--${index + 1}`}>
                  {card}
                </p>
              ))}
            </div>
            <div className="o1-title">
              <p className="o1-eyebrow">
                <span>Omnyo</span> for macOS
              </p>
              <h1 id="o1-title">The unified interface for coding agents.</h1>
              <p className="o1-lede">
                Run Claude Code and Codex side by side on your own machines,
                each chat in its own thread. Free to use.
              </p>
              <div className="o1-actions">
                <DownloadButton>Download for macOS</DownloadButton>
                <a className="o1-ghost" href="#story">
                  See how it works
                </a>
              </div>
              <p className="o1-meta">
                <span>Apple Silicon</span>
                <i />
                <span>macOS 13 or later</span>
                <i className="o1-meta-break" />
                <span>No Omnyo account needed</span>
              </p>
            </div>
          </div>
        </div>

        <div className="o1-hero-foot" aria-hidden="true">
          <span className="o1-rec">
            <i />
            <span ref={timecodeRef}>00:00:00:00</span>
          </span>
          <span className="o1-scroll">Scroll for the story</span>
        </div>
      </section>

      <section className="o1-prologue" id="story" aria-labelledby="o1-story">
        <p className="o1-label" data-reveal>
          The story, in four chapters
        </p>
        <h2 id="o1-story" data-reveal>
          Your agents, your machines,
          <br />
          <em>one workspace.</em>
        </h2>
        <p className="o1-prologue-body" data-reveal>
          Omnyo is a Mac app that brings your coding agents together. Here is
          what a working day with it looks like.
        </p>
      </section>

      {CHAPTERS.map((chapter, index) => (
        <section
          key={chapter.numeral}
          className={`o1-chapter o1-chapter--${index + 1}`}
          aria-labelledby={`o1-chapter-${index + 1}`}
        >
          <div className="o1-chapter-head" data-reveal>
            <div className="o1-chapter-mark">
              <span className="o1-numeral">{chapter.numeral}</span>
              <span className="o1-chapter-name">
                Chapter {chapter.numeral}
                <b>{chapter.name}</b>
              </span>
            </div>
            <h3 id={`o1-chapter-${index + 1}`}>{chapter.title}</h3>
            <p>{chapter.body}</p>
          </div>
          <figure className="o1-frame" data-reveal>
            <div className="o1-frame-light" aria-hidden="true" />
            <div className="o1-frame-scene">{chapter.scene}</div>
            <figcaption className="o1-frame-caption" aria-hidden="true">
              <span>
                SC. {String(index + 1).padStart(2, "0")} /{" "}
                {chapter.name.toUpperCase()}
              </span>
              <span className="o1-phase">
                <PhaseGlyph offset={chapter.offset} />
                {chapter.phase}
              </span>
              <span>{chapter.timecode}</span>
            </figcaption>
          </figure>
        </section>
      ))}

      <section className="o1-cast" id="cast" aria-labelledby="o1-cast-title">
        <div className="o1-cast-head" data-reveal>
          <p className="o1-label">Also featuring</p>
          <h2 id="o1-cast-title">
            The supporting <em>cast.</em>
          </h2>
        </div>
        <div className="o1-strip" data-reveal>
          <div className="o1-strip-track">
            {SUPPORTING.map((item, index) => (
              <article key={item.title} className="o1-strip-frame">
                <span className="o1-strip-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}A
                </span>
                <div className="o1-strip-visual" aria-hidden="true">
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
        className="o1-guides"
        id="guides"
        aria-labelledby="o1-guides-title"
      >
        <div className="o1-guides-head" data-reveal>
          <p className="o1-label">Switching over</p>
          <h2 id="o1-guides-title">
            Coming from <em>another tool?</em>
          </h2>
          <p>
            Each guide walks you through moving your work into Omnyo, step by
            step.
          </p>
        </div>
        <ul className="o1-guide-list" data-reveal>
          {SWITCH_GUIDES.map((guide, index) => (
            <li key={guide.slug}>
              <a href={`/guides/${guide.slug}`}>
                <span className="o1-guide-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="o1-guide-from">From</span>
                <span className="o1-guide-name">{guide.label}</span>
                <span className="o1-guide-go" aria-hidden="true">
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
        <div className="o1-more" data-reveal>
          <span className="o1-more-label">More guides</span>
          {MORE_GUIDES.map((guide) => (
            <a key={guide.slug} href={`/guides/${guide.slug}`}>
              {guide.label}
            </a>
          ))}
        </div>
      </section>

      <section className="o1-finale" aria-labelledby="o1-finale-title">
        <div className="o1-finale-eclipse" data-reveal>
          <EclipsePoster className="o1-poster--finale" />
        </div>
        <div className="o1-finale-copy" data-reveal>
          <p className="o1-label">Now available</p>
          <h2 id="o1-finale-title">
            Bring your coding agents <em>together.</em>
          </h2>
          <p>
            Free to use, for Macs with Apple Silicon running macOS 13 or later.
          </p>
          <DownloadButton className="o1-download--large">
            Download Omnyo for macOS
          </DownloadButton>
        </div>
        <div className="o1-billing" data-reveal>
          <p className="o1-billing-lead">
            <span>Omnyo</span> The unified interface for coding agents
          </p>
          <p className="o1-billing-block">
            {BILLING.map((phrase, index) => (
              <span key={phrase.join("")}>
                {index > 0 ? "\u00a0· " : null}
                <span className="o1-billing-item">
                  {phrase.map((part) =>
                    part.startsWith("*") ? (
                      <b key={part}>{part.slice(1)}</b>
                    ) : (
                      part
                    ),
                  )}
                </span>
              </span>
            ))}
          </p>
        </div>
      </section>

      <footer className="o1-footer">
        <div className="o1-footer-brand">
          <FlatMark className="o1-brand-mark" />
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
        <p className="o1-copyright">© 2026 Omnyo</p>
      </footer>
    </main>
  );
}
