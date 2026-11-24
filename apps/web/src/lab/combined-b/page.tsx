import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter/index.css";
import "./styles.css";

import { type CSSProperties, useEffect, useRef, useState } from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import {
  CHAPTERS,
  FACTS,
  ROUTE,
  SCATTERED,
  STORY_LINES,
  SWITCH_GUIDES,
  TOPIC_GUIDES,
} from "./content";
import type { Engine } from "./engine";
import { type StoryController, startStory } from "./story";
import { AppWindow, Phone } from "./window";

const MARK_PATH =
  "M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z";

type Status = "loading" | "live" | "failed";

function Mark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="7 7 50 50"
      aria-hidden="true"
      focusable="false"
    >
      <path d={MARK_PATH} fill="currentColor" />
      <circle cx="49.5" cy="14.5" r="6.5" className="cb-mark-dot" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="cb-arrow">
      <path
        d="M3 8h10m0 0L9 4m4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadButton({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <a className={`cb-dl cb-dl--${size}`} href={MACOS_DOWNLOAD_URL}>
      <svg viewBox="0 0 16 16" aria-hidden="true" className="cb-dl-icon">
        <path
          d="M8 2.5v8m0 0L4.5 7M8 10.5 11.5 7M3 13.5h10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>Download for macOS</span>
    </a>
  );
}

function Nav() {
  return (
    <header className="cb-nav">
      <a className="cb-nav-brand" href="#top" aria-label="Omnyo, back to top">
        <Mark className="cb-nav-mark" />
        <span>Omnyo</span>
      </a>
      <div className="cb-nav-act" aria-hidden="true">
        <span className="cb-nav-bar">
          <span />
        </span>
        <span data-nav-label>Daylight</span>
      </div>
      <a className="cb-nav-dl" href={MACOS_DOWNLOAD_URL}>
        Download
      </a>
    </header>
  );
}

function SunPoster() {
  return (
    <span className="cb-sunposter" aria-hidden="true">
      <span className="cb-sunposter-halo" />
      <span className="cb-sunposter-disc" />
    </span>
  );
}

function Hero() {
  return (
    <section className="cb-hero" data-scene="hero" id="top">
      <div className="cb-hero-copy">
        <p className="cb-eyebrow cb-in" style={{ "--i": 0 } as CSSProperties}>
          <span className="cb-eyebrow-dot" />
          Free to use · for macOS
        </p>
        <h1 className="cb-hero-title">
          <span className="cb-line">
            <span className="cb-in" style={{ "--i": 1 } as CSSProperties}>
              All your
            </span>
          </span>
          <span className="cb-line">
            <span className="cb-in" style={{ "--i": 2 } as CSSProperties}>
              coding agents.
            </span>
          </span>
          <span className="cb-line">
            <span className="cb-in" style={{ "--i": 3 } as CSSProperties}>
              One place<span className="cb-accent">.</span>
            </span>
          </span>
        </h1>
        <p className="cb-hero-sub cb-in" style={{ "--i": 4 } as CSSProperties}>
          Omnyo is a free, open-source Mac app that runs Claude Code and Codex
          side by side on your own machines.
        </p>
        <div
          className="cb-hero-actions cb-in"
          style={{ "--i": 5 } as CSSProperties}
        >
          <DownloadButton />
          <a className="cb-text-link" href="#story">
            See how it works
            <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="cb-meta cb-in" style={{ "--i": 6 } as CSSProperties}>
          Apple Silicon · macOS 13 or later · No Omnyo account needed
        </p>
      </div>
      <div className="cb-hero-stage" aria-hidden="true">
        <div className="cb-hero-sun" data-anchor="hero-sun">
          <SunPoster />
          <div className="cb-hero-decor" data-hero-decor>
            <svg className="cb-orbit" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="49.6" />
            </svg>
            <span className="cb-tag cb-tag--a">
              <i className="cb-tone-claude" />
              claude · harbor-ledger
            </span>
            <span className="cb-tag cb-tag--b">
              <i className="cb-tone-codex" />
              codex · atlas-notes
            </span>
            <span className="cb-tag cb-tag--c">
              <i className="cb-tone-accent" />
              preview · feat/csv-export
            </span>
          </div>
        </div>
      </div>
      <div className="cb-hero-scroll" aria-hidden="true">
        <span>Scroll to watch the eclipse</span>
        <span className="cb-hero-scroll-line" />
      </div>
    </section>
  );
}

function Gather() {
  return (
    <section className="cb-gather" data-scene="gather" id="story">
      <div className="cb-pin cb-gather-pin">
        <div className="cb-gather-sun" data-anchor="gather-sun" />
        <div className="cb-wins" aria-hidden="true">
          {SCATTERED.map((entry, index) => (
            <div
              className={`cb-swin cb-swin-${index}`}
              data-win
              key={entry.title}
            >
              <div className="cb-swin-bar">{entry.title}</div>
              <div className="cb-swin-body">
                {entry.lines.map((line, lineIndex) => (
                  <p key={`${index}-${lineIndex}`}>{line || " "}</p>
                ))}
                <p className="cb-swin-cursor">▍</p>
              </div>
            </div>
          ))}
        </div>
        <h2 className="cb-lines">
          <span className="cb-lines-kicker">Without Omnyo</span>
          {STORY_LINES.map((line) => (
            <span className="cb-line-item" data-line key={line}>
              {line}
            </span>
          ))}
        </h2>
        <p className="cb-readout" data-readout aria-hidden="true" />
        <div className="cb-totality" data-totality>
          <p className="cb-kicker">
            <span className="cb-kicker-dot" />
            With Omnyo
          </p>
          <h2 className="cb-totality-title">
            Omnyo brings them into one place.
          </h2>
          <p className="cb-totality-sub">
            Claude Code, Codex, your repositories and every branch preview, in
            one window on your Mac.
          </p>
        </div>
      </div>
    </section>
  );
}

function Chapters({ step, still }: { step: number; still: boolean }) {
  const current = CHAPTERS[step] ?? CHAPTERS[0];

  if (!current) return null;

  if (still) {
    return (
      <section className="cb-chapters" data-scene="chapters">
        {CHAPTERS.map((chapter) => (
          <article className="cb-still-chapter" key={chapter.view}>
            <div className="cb-step is-on">
              <p className="cb-step-kicker">
                <span className="cb-num">{chapter.number}</span>
                {chapter.name}
              </p>
              <h3>{chapter.title}</h3>
              <p className="cb-step-body">{chapter.body}</p>
              <a className="cb-guide" href={chapter.guide.href}>
                {chapter.guide.label}
                <Arrow />
              </a>
            </div>
            <div className="cb-still-rig">
              <AppWindow view={chapter.view} only />
              {chapter.view === "anywhere" ? (
                <div className="cb-rig-phone is-in">
                  <Phone />
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    );
  }

  return (
    <section
      className="cb-chapters"
      data-scene="chapters"
      aria-labelledby="cb-chapters-title"
    >
      <div className="cb-pin cb-chapters-pin">
        <h2 id="cb-chapters-title" className="cb-sr">
          What you can do in Omnyo
        </h2>
        <div className="cb-chap-sun" data-anchor="chap-sun" />
        <div className="cb-band" data-band>
          <ol className="cb-steps">
            {CHAPTERS.map((chapter, index) => (
              <li
                key={chapter.view}
                className={`cb-step ${index === step ? "is-on" : ""}`}
                aria-current={index === step ? "step" : undefined}
              >
                <p className="cb-step-kicker">
                  <span className="cb-num">{chapter.number}</span>
                  {chapter.name}
                </p>
                <h3>{chapter.title}</h3>
                <p className="cb-step-body">{chapter.body}</p>
                <a className="cb-guide" href={chapter.guide.href}>
                  {chapter.guide.label}
                  <Arrow />
                </a>
              </li>
            ))}
          </ol>
          <div className="cb-step-index" aria-hidden="true">
            {CHAPTERS.map((chapter, index) => (
              <span
                key={chapter.view}
                className={
                  index === step ? "is-on" : index < step ? "is-past" : ""
                }
              >
                {chapter.number}
              </span>
            ))}
          </div>
        </div>
        <div className="cb-rig" data-rig>
          <div className="cb-rig-halo" aria-hidden="true" />
          <div className="cb-rig-tilt">
            <AppWindow view={current.view} />
          </div>
          <div
            className={`cb-rig-phone ${current.view === "anywhere" ? "is-in" : ""}`}
          >
            <Phone />
          </div>
        </div>
      </div>
    </section>
  );
}

function Machines() {
  return (
    <section
      className="cb-machines"
      data-scene="machines"
      aria-labelledby="cb-machines-title"
    >
      <div className="cb-section-head">
        <p className="cb-step-kicker">
          <span className="cb-num">05</span>
          Your machines
        </p>
        <h2 id="cb-machines-title" className="cb-h2">
          It runs on your own machines.
        </h2>
        <p className="cb-section-body">
          Prompts, code and files go from your Mac to the Omnyo server you run,
          then to the AI provider you choose. Nothing is hosted by us in
          between.
        </p>
      </div>
      <ol className="cb-route">
        {ROUTE.map((node, index) => (
          <li key={node.name} className={index === 1 ? "is-core" : ""}>
            <span className="cb-route-index">0{index + 1}</span>
            <span className="cb-route-icon" aria-hidden="true">
              {index === 0 ? (
                <svg viewBox="0 0 24 24">
                  <rect x="3" y="4.5" width="18" height="12" rx="2" />
                  <path d="M8.5 20h7M12 16.5V20" />
                </svg>
              ) : index === 1 ? (
                <Mark className="cb-route-mark" />
              ) : (
                <svg viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="8" />
                  <path d="M4 12h16M12 4c2.6 2.6 2.6 13.4 0 16M12 4c-2.6 2.6-2.6 13.4 0 16" />
                </svg>
              )}
            </span>
            <strong>{node.name}</strong>
            <span>{node.detail}</span>
          </li>
        ))}
        <li className="cb-route-beam" aria-hidden="true">
          <i />
          <i />
        </li>
      </ol>
      <ul className="cb-facts">
        {FACTS.map((fact) => (
          <li key={fact.title}>
            <strong>{fact.title}</strong>
            <span>{fact.body}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function More() {
  return (
    <section
      className="cb-more"
      data-scene="more"
      aria-labelledby="cb-more-title"
    >
      <div className="cb-section-head">
        <p className="cb-step-kicker">
          <span className="cb-num">06</span>
          More ways
        </p>
        <h2 id="cb-more-title" className="cb-h2">
          More ways to put agents to work.
        </h2>
      </div>
      <div className="cb-cards">
        <a className="cb-card" href="/guides/run-an-agent-on-a-schedule">
          <div className="cb-card-vis cb-vis-sched" aria-hidden="true">
            <span className="cb-vis-time">09:00</span>
            <span className="cb-vis-days">
              {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
                <i key={`${day}-${index}`} className={index < 5 ? "is-on" : ""}>
                  {day}
                </i>
              ))}
            </span>
            <span className="cb-vis-task">
              <i className="cb-tone-codex" />
              Weekday issue triage · atlas-notes
            </span>
          </div>
          <h3>Agents on a schedule</h3>
          <p>
            Run an agent on a schedule, such as triaging new issues every
            weekday morning.
          </p>
          <span className="cb-card-more">
            Read the guide
            <Arrow />
          </span>
        </a>
        <a className="cb-card" href="/guides/agent-browser">
          <div className="cb-card-vis cb-vis-browser" aria-hidden="true">
            <div className="cb-vis-window">
              <span className="cb-vis-bar">
                <i />
                <i />
                <i />
                <em>localhost:5174/invoices</em>
              </span>
              <span className="cb-vis-page">
                <b />
                <b className="is-short" />
                <span className="cb-vis-btn">Export CSV</span>
                <span className="cb-vis-cursor" />
              </span>
            </div>
            <span className="cb-vis-shots">
              <i />
              <i />
              <i />
            </span>
          </div>
          <h3>A real browser</h3>
          <p>
            Let your agent click through a change in a real browser and show you
            screenshots.
          </p>
          <span className="cb-card-more">
            Read the guide
            <Arrow />
          </span>
        </a>
        <a className="cb-card" href="/plugin-guide">
          <div className="cb-card-vis cb-vis-plugins" aria-hidden="true">
            {[
              ["Release notes", "Thread action", true],
              ["Standup summary", "Agent tool", true],
              ["Ticket links", "Side panel", false],
            ].map(([name, kind, on]) => (
              <span className="cb-vis-plug" key={String(name)}>
                <i>{String(name).slice(0, 1)}</i>
                <span>
                  <b>{name}</b>
                  {kind}
                </span>
                <em className={on ? "is-on" : ""} />
              </span>
            ))}
          </div>
          <h3>Plugins</h3>
          <p>
            Extend Omnyo with plugins when your workflow needs something it does
            not do yet.
          </p>
          <span className="cb-card-more">
            Open the Plugin Guide
            <Arrow />
          </span>
        </a>
      </div>
    </section>
  );
}

function Switching() {
  return (
    <section
      className="cb-switch"
      data-scene="switch"
      aria-labelledby="cb-switch-title"
    >
      <div className="cb-switch-head">
        <p className="cb-step-kicker">Switching over</p>
        <h2 id="cb-switch-title" className="cb-h2">
          Coming from another tool?
        </h2>
        <p className="cb-section-body">
          Read the guide for the tool you use today.
        </p>
      </div>
      <ul className="cb-switch-list">
        {SWITCH_GUIDES.map((guide) => (
          <li key={guide.slug}>
            <a href={`/guides/${guide.slug}`}>
              <span className="cb-switch-from">From</span>
              <span className="cb-switch-name">{guide.label}</span>
              <Arrow />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Dawn() {
  return (
    <section
      className="cb-dawn"
      data-scene="dawn"
      aria-labelledby="cb-dawn-title"
    >
      <div className="cb-pin cb-dawn-pin">
        <div className="cb-dawn-sun" data-anchor="dawn-sun" />
        <p className="cb-dawn-readout" data-dawn-readout aria-hidden="true">
          Totality
        </p>
        <div className="cb-dawn-copy" data-dawn-copy>
          <h2 id="cb-dawn-title" className="cb-dawn-title">
            Put every agent in one place<span className="cb-accent">.</span>
          </h2>
          <div className="cb-dawn-actions">
            <DownloadButton size="lg" />
          </div>
          <p className="cb-meta">
            Free · Open source · Apple Silicon · macOS 13 or later
          </p>
          <p className="cb-dawn-note">
            No Omnyo account needed to use it on your own machines.
          </p>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="cb-foot" data-scene="footer">
      <div className="cb-foot-top">
        <div className="cb-foot-brand">
          <Mark className="cb-foot-mark" />
          <p className="cb-foot-tag">
            The unified interface for coding agents.
          </p>
          <DownloadButton />
        </div>
        <nav className="cb-foot-cols" aria-label="Footer">
          <div>
            <p className="cb-foot-head">Guides</p>
            {TOPIC_GUIDES.map((guide) => (
              <a href={`/guides/${guide.slug}`} key={guide.slug}>
                {guide.label}
              </a>
            ))}
          </div>
          <div>
            <p className="cb-foot-head">Switch to Omnyo</p>
            {SWITCH_GUIDES.map((guide) => (
              <a href={`/guides/${guide.slug}`} key={guide.slug}>
                From {guide.label}
              </a>
            ))}
          </div>
          <div>
            <p className="cb-foot-head">Legal</p>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
            <a href="/imprint">Imprint</a>
          </div>
        </nav>
      </div>
      <p className="cb-foot-word" aria-hidden="true">
        omnyo<span className="cb-accent">.</span>
      </p>
      <div className="cb-foot-bottom">
        <span>
          Built on <a href={BB_URL}>bb</a> (MIT License)
        </span>
        <span>© 2026 Omnyo</span>
      </div>
    </footer>
  );
}

function Poster() {
  return (
    <div className="cb-poster" data-poster aria-hidden="true">
      <span className="cb-poster-corona" />
      <span className="cb-poster-sun" />
      <span className="cb-poster-moon">
        <Mark className="cb-poster-mark" />
      </span>
    </div>
  );
}

export default function Page() {
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Status>("loading");

  const [still, setStill] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setStill(query.matches);
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;

    if (still || !root || !stage) return;
    let cancelled = false;
    let engine: Engine | null = null;
    let canvas: HTMLCanvasElement | null = null;

    const story: StoryController = startStory(root, {
      onStep: setStep,
      onLive: () => setStatus("live"),
    });

    const fail = (reason: unknown) => {
      if (cancelled) return;
      console.warn("Omnyo eclipse is showing its poster", reason);
      story.fail();
      engine?.dispose();
      engine = null;
      setStatus("failed");
    };

    import("./engine")
      .then((module) => {
        if (cancelled) return;

        if (!module.canUseWebGL()) {
          fail("WebGL is unavailable");

          return;
        }

        canvas = document.createElement("canvas");
        canvas.className = "cb-canvas";
        canvas.setAttribute("aria-hidden", "true");
        stage.appendChild(canvas);
        engine = module.createEngine(canvas, {
          onProgress: (fraction) => story.modelProgress(fraction),
          onModelReady: () => story.modelReady(),
          onFailure: fail,
        });
        story.attach(engine);
      })
      .catch(fail);

    return () => {
      cancelled = true;
      story.dispose();
      engine?.dispose();
      canvas?.remove();
    };
  }, [still]);

  return (
    <main
      ref={rootRef}
      className={`lab-combined-b is-${status}${still ? " is-still" : ""}`}
    >
      <div className="cb-sky" data-sky aria-hidden="true" />
      <div className="cb-stage" ref={stageRef} aria-hidden="true" />
      <Poster />
      <div className="cb-grain" aria-hidden="true" />
      <Nav />
      <Hero />
      <Gather />
      <Chapters step={step} still={still} />
      <div className="cb-night" data-scene="night">
        <Machines />
        <More />
      </div>
      <Dawn />
      <Switching />
      <Footer />
    </main>
  );
}
