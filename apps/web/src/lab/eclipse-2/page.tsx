import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/jost";
import "@fontsource-variable/inter-tight";
import "./styles.css";

import {
  type CSSProperties,
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
import { CUT, LEADER_SECONDS, cutVariables } from "./timeline";

const INTERTITLES = [
  { key: "card1", line: "Claude Code." },
  { key: "card2", line: "Codex." },
  { key: "card3", line: "One private workspace." },
] as const;

const CHAPTERS = [
  {
    numeral: "I",
    word: "One",
    name: "Side by side",
    timecode: "01:00:12:08",
    phase: "First contact",
    offset: 11,
    title: "Claude Code and Codex, side by side.",
    body: "Start chats with either agent and keep them open together. Every chat runs in its own thread, so one task never spills into another.",
    scene: <SceneSideBySide />,
  },
  {
    numeral: "II",
    word: "Two",
    name: "The second opinion",
    timecode: "01:00:31:15",
    phase: "Partial",
    offset: 6.5,
    title: "One agent builds. Another reviews.",
    body: "Hand a finished task to a different agent for review. The review runs in its own thread, and you talk the findings through with the reviewer.",
    scene: <SceneReview />,
  },
  {
    numeral: "III",
    word: "Three",
    name: "Your machines",
    timecode: "01:00:52:02",
    phase: "Diamond ring",
    offset: 1.4,
    title: "It runs on your own machines.",
    body: "Prompts, code and files go to the Omnyo server you run, then to the AI provider you choose. Nothing is hosted by us in between, and you need no Omnyo account on your own machines.",
    scene: <SceneMachines />,
  },
  {
    numeral: "IV",
    word: "Four",
    name: "Anywhere",
    timecode: "01:01:14:20",
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
  ["Starring ", "*Claude Code", " and ", "*Codex"],
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

const LATE_MOUNT_MS = 2400;

const CUT_ANIMATIONS = new Set([
  "e2-open",
  "e2-rack",
  "e2-hold",
  "e2-hold-rack",
  "e2-flash",
  "e2-drop",
  "e2-rise",
  "e2-fade",
]);

function syncCut(hero: HTMLElement, clock: number) {
  for (const animation of hero.getAnimations({ subtree: true })) {
    if (
      animation instanceof CSSAnimation &&
      CUT_ANIMATIONS.has(animation.animationName)
    ) {
      animation.startTime = clock;
    }
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

function formatTimecode(totalSeconds: number) {
  const whole = Math.floor(totalSeconds);
  const frames = Math.floor((totalSeconds - whole) * 24);

  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}:${pad(frames)}`;
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
      { rootMargin: "0px 0px -14% 0px", threshold: 0.1 },
    );

    for (const target of targets) observer.observe(target);

    return () => observer.disconnect();
  }, [root]);
}

function useTimecode(
  target: RefObject<HTMLElement | null>,
  clockRef: RefObject<number | null>,
  stage: Stage,
) {
  useEffect(() => {
    const element = target.current;

    if (!element) return;

    if (stage === "is-still") {
      element.textContent = formatTimecode(3600);

      return;
    }

    let frame = 0;
    let visible = true;

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });

    observer.observe(element);

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      if (!visible) return;
      const clock = clockRef.current;
      const elapsed = clock === null ? 0 : (now - clock) / 1000;
      element.textContent = formatTimecode(LEADER_SECONDS + elapsed);
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [target, clockRef, stage]);
}

function PhaseGlyph({ offset }: { offset: number }) {
  return (
    <svg className="e2-phase-glyph" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="7.5" className="e2-phase-sun" />
      <circle
        cx={12 + offset}
        cy={12 - offset * 0.35}
        r="7.6"
        className="e2-phase-moon"
      />
      {offset > 0 && offset < 2 ? (
        <circle cx={12 + 5.3} cy={12 - 5.3} r={1.6} className="e2-phase-bead" />
      ) : null}
    </svg>
  );
}

function CropMarks() {
  return (
    <span className="e2-crop" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
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
    <a className={`e2-download ${className ?? ""}`} href={MACOS_DOWNLOAD_URL}>
      <span className="e2-download-glow" aria-hidden="true" />
      <span className="e2-download-label">{children}</span>
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
  const heroRef = useRef<HTMLElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const timecodeRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<number | null>(null);
  const [status, setStatus] = useState<EclipseStatus | "loading">("loading");
  const [stage, setStage] = useState<Stage>("is-waiting");
  const [Scene, setScene] = useState<typeof EclipseSceneComponent | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStage("is-still");

      return;
    }

    const now = performance.now();
    clockRef.current =
      now > LATE_MOUNT_MS ? now - (CUT.card3 + 0.12) * 1000 : now;
    setStage("is-rolling");
  }, []);

  useEffect(() => {
    const hero = heroRef.current;
    const clock = clockRef.current;

    if (stage !== "is-rolling" || !hero || clock === null) return;
    syncCut(hero, clock);
  }, [stage, Scene, status]);

  const replay = () => {
    const root = rootRef.current;
    const hero = heroRef.current;

    if (!root || !hero) return;
    const clock = performance.now();
    clockRef.current = clock;
    root.classList.remove("is-rolling");
    void root.offsetWidth;
    root.classList.add("is-rolling");
    syncCut(hero, clock);
  };

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

  useReveal(rootRef);
  useTimecode(timecodeRef, clockRef, stage);

  return (
    <main
      ref={rootRef}
      className={`lab-eclipse-2 ${stage} is-${status}`}
      style={cutVariables() as CSSProperties}
      aria-label="Omnyo"
    >
      <section
        ref={heroRef}
        className="e2-hero"
        id="top"
        aria-labelledby="e2-title"
      >
        {Scene ? (
          <Scene slotRef={slotRef} onStatus={setStatus} clockRef={clockRef} />
        ) : null}
        <div className="e2-curtain" aria-hidden="true" />
        <div className="e2-grain" aria-hidden="true" />

        <div className="e2-cards" aria-hidden="true">
          {INTERTITLES.map((card) => (
            <p key={card.key} className={`e2-card e2-card--${card.key}`}>
              {card.line}
            </p>
          ))}
        </div>

        <div className="e2-bar e2-bar--top">
          <header className="e2-nav">
            <a className="e2-brand" href="#top" aria-label="Omnyo, back to top">
              <FlatMark className="e2-brand-mark" />
              <span>Omnyo</span>
            </a>
            <nav aria-label="Primary">
              <a href="#story">The story</a>
              <a href="#cast">Features</a>
              <a href="#guides">Guides</a>
              <a className="e2-nav-download" href={MACOS_DOWNLOAD_URL}>
                Download
              </a>
            </nav>
          </header>
        </div>

        <div className="e2-hero-inner">
          <div ref={slotRef} className="e2-slot">
            <EclipsePoster />
            <div className="e2-flash" aria-hidden="true" />
          </div>

          <div className="e2-title">
            <h1 id="e2-title">
              <span className="e2-drop">Omnyo</span>
              <span className="e2-tagline">
                The unified interface for coding agents.
              </span>
            </h1>
            <p className="e2-lede">
              Run Claude Code and Codex side by side on your own machines, each
              chat in its own thread.
            </p>
            <div className="e2-actions">
              <DownloadButton>Download for macOS</DownloadButton>
              <a className="e2-ghost" href="#story">
                Watch the story
              </a>
            </div>
            <p className="e2-meta e2-meta--inline">
              <span>Free to use</span>
              <i className="e2-meta-break" />
              <span>Apple Silicon</span>
              <i />
              <span>macOS 13 or later</span>
            </p>
          </div>
        </div>

        <div className="e2-bar e2-bar--bottom">
          <div className="e2-hero-foot">
            <span className="e2-rec" aria-hidden="true">
              <i />
              <span ref={timecodeRef}>00:59:55:23</span>
            </span>
            <p className="e2-meta e2-meta--bar">
              <span>Free to use</span>
              <i />
              <span>Apple Silicon</span>
              <i />
              <span>macOS 13 or later</span>
            </p>
            <button
              type="button"
              className="e2-replay"
              onClick={replay}
              aria-label="Replay the opening sequence"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M3.2 8a4.8 4.8 0 1 0 1.4-3.4M3 2.6v2.6h2.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Replay the opening
            </button>
          </div>
        </div>
      </section>

      <section className="e2-logline" id="story" aria-labelledby="e2-story">
        <div className="e2-logline-inner" data-reveal>
          <p className="e2-label">The logline</p>
          <h2 id="e2-story">
            Your coding agents, together in <em>one private workspace.</em>
          </h2>
          <p className="e2-logline-body">
            Omnyo is a free, open-source Mac app. It runs on machines you own,
            and it keeps every agent chat in its own thread. Four scenes show
            how a working day goes.
          </p>
        </div>
      </section>

      {CHAPTERS.map((chapter, index) => (
        <section
          key={chapter.numeral}
          className={`e2-chapter e2-chapter--${index + 1}`}
          aria-labelledby={`e2-chapter-${index + 1}`}
        >
          <header className="e2-slate" data-reveal>
            <CropMarks />
            <p className="e2-slate-kicker">
              <span className="e2-slate-rule" aria-hidden="true" />
              Chapter {chapter.word}
              <span className="e2-slate-rule" aria-hidden="true" />
            </p>
            <h3 id={`e2-chapter-${index + 1}`}>{chapter.title}</h3>
            <p className="e2-slate-body">{chapter.body}</p>
            <p className="e2-slate-credits" aria-hidden="true">
              <span>SC. {pad(index + 1)}</span>
              <span className="e2-phase">
                <PhaseGlyph offset={chapter.offset} />
                {chapter.phase}
              </span>
              <span>{chapter.timecode}</span>
            </p>
          </header>
          <figure className="e2-frame" data-reveal>
            <div className="e2-frame-light" aria-hidden="true" />
            <div className="e2-frame-scene">{chapter.scene}</div>
            <figcaption className="e2-frame-caption" aria-hidden="true">
              <span>
                {chapter.numeral} / {chapter.name.toUpperCase()}
              </span>
              <span>{chapter.timecode}</span>
            </figcaption>
          </figure>
        </section>
      ))}

      <section className="e2-cast" id="cast" aria-labelledby="e2-cast-title">
        <div className="e2-cast-head" data-reveal>
          <p className="e2-label">Also featuring</p>
          <h2 id="e2-cast-title">
            The supporting <em>cast.</em>
          </h2>
        </div>
        <div className="e2-strip" data-reveal>
          <div className="e2-strip-track">
            {SUPPORTING.map((item, index) => (
              <article key={item.title} className="e2-strip-frame">
                <span className="e2-strip-index" aria-hidden="true">
                  {pad(index + 1)}A
                </span>
                <div className="e2-strip-visual" aria-hidden="true">
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
        className="e2-guides"
        id="guides"
        aria-labelledby="e2-guides-title"
      >
        <div className="e2-guides-head" data-reveal>
          <p className="e2-label">Switching over</p>
          <h2 id="e2-guides-title">
            Coming from <em>another tool?</em>
          </h2>
          <p>
            Each guide walks you through moving your work into Omnyo, step by
            step.
          </p>
        </div>
        <ul className="e2-guide-list" data-reveal>
          {SWITCH_GUIDES.map((guide, index) => (
            <li key={guide.slug}>
              <a href={`/guides/${guide.slug}`}>
                <span className="e2-guide-index">{pad(index + 1)}</span>
                <span className="e2-guide-from">From</span>
                <span className="e2-guide-name">{guide.label}</span>
                <span className="e2-guide-go" aria-hidden="true">
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
        <div className="e2-more" data-reveal>
          <span className="e2-more-label">More guides</span>
          {MORE_GUIDES.map((guide) => (
            <a key={guide.slug} href={`/guides/${guide.slug}`}>
              {guide.label}
            </a>
          ))}
        </div>
      </section>

      <section className="e2-release" aria-labelledby="e2-release-title">
        <div className="e2-release-slate" data-reveal>
          <CropMarks />
          <div className="e2-release-eclipse">
            <EclipsePoster className="e2-poster--finale" />
          </div>
          <p className="e2-release-name" aria-hidden="true">
            Omnyo
          </p>
          <h2 id="e2-release-title">
            Now showing <em>on macOS.</em>
          </h2>
          <p className="e2-release-body">
            Free to use. For Macs with Apple Silicon running macOS 13 or later.
            No Omnyo account needed on your own machines.
          </p>
          <DownloadButton className="e2-download--large">
            Download Omnyo for macOS
          </DownloadButton>
        </div>
        <div className="e2-billing" data-reveal>
          <p className="e2-billing-lead">
            <span>Omnyo</span> The unified interface for coding agents
          </p>
          <p className="e2-billing-block">
            {BILLING.map((phrase, index) => (
              <span key={phrase.join("")}>
                {index > 0 ? " · " : null}
                <span className="e2-billing-item">
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

      <footer className="e2-footer">
        <div className="e2-footer-brand">
          <FlatMark className="e2-brand-mark" />
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
        <p className="e2-copyright">© 2026 Omnyo</p>
      </footer>
    </main>
  );
}
