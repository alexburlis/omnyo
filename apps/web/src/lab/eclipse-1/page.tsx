import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter-tight";
import "./styles.css";

import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
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
} from "./scenes";

const PHASES = [
  {
    phase: "First contact",
    numeral: "I",
    offset: 9,
    title: "Claude Code and Codex, side by side.",
    body: "Start chats with either agent and keep them open together. Every chat runs in its own thread, so one task never spills into another.",
    scene: <SceneSideBySide />,
  },
  {
    phase: "Partial",
    numeral: "II",
    offset: 4.5,
    title: "One agent builds. Another reviews.",
    body: "Hand a finished task to a different agent for review. The review runs in its own thread, and you talk the findings through with the reviewer.",
    scene: <SceneReview />,
  },
  {
    phase: "Diamond ring",
    numeral: "III",
    offset: 1.2,
    title: "It runs on your own machines.",
    body: "Prompts, code and files go to the Omnyo server you run, then to the AI provider you choose. Nothing is hosted by us in between.",
    scene: <SceneMachines />,
  },
  {
    phase: "Totality",
    numeral: "IV",
    offset: 0,
    title: "Leave your desk. Keep the thread.",
    body: "Turn on Omnyo Connect, the optional remote access, with a free account. Follow a running chat and steer it from another device.",
    scene: <SceneAnywhere />,
  },
] as const;

const DETAILS = [
  {
    title: "A dev server for every branch",
    body: "Each branch runs its own dev server, with a live preview link.",
  },
  {
    title: "Agents on a schedule",
    body: "Run an agent on a timer, such as issue triage every weekday morning.",
  },
  {
    title: "A real browser",
    body: "Your agent clicks through a change in a real browser and shows you screenshots.",
  },
  {
    title: "Plugins",
    body: "Extend Omnyo with plugins when your workflow needs something more.",
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
      { rootMargin: "0px 0px -10% 0px", threshold: 0.06 },
    );

    for (const target of targets) observer.observe(target);

    return () => observer.disconnect();
  }, [root]);
}

function PhaseGlyph({ offset }: { offset: number }) {
  const id = useId().replace(/:/g, "");
  const total = offset === 0;

  return (
    <svg
      className={`e1-glyph${total ? " e1-glyph--total" : ""}`}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0.62" stopColor="#fff6ea" stopOpacity="0.55" />
          <stop offset="0.72" stopColor="#ffe9cf" stopOpacity="0.16" />
          <stop offset="1" stopColor="#ffe9cf" stopOpacity="0" />
        </radialGradient>
      </defs>
      {total ? (
        <>
          <circle cx="24" cy="24" r="24" fill={`url(#${id}-glow)`} />
          <circle cx="24" cy="24" r="15" className="e1-glyph-moon" />
          <circle cx="24" cy="24" r="15.4" className="e1-glyph-limb" />
        </>
      ) : (
        <>
          <circle cx="24" cy="24" r="15" className="e1-glyph-sun" />
          <circle
            cx={24 - offset * 1.5}
            cy={24 + offset * 1.5}
            r="15.3"
            className="e1-glyph-moon"
          />
        </>
      )}
      {offset > 0 && offset < 2 ? (
        <circle cx="34.8" cy="13.2" r="2.1" className="e1-glyph-bead" />
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
    <a className={`e1-download ${className ?? ""}`} href={MACOS_DOWNLOAD_URL}>
      <span>{children}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M8 2.5v8m0 0L4.5 7M8 10.5 11.5 7M3 13.5h10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
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

  return (
    <main
      ref={rootRef}
      className={`lab-eclipse-1 ${stage} is-${status}`}
      aria-label="Omnyo"
    >
      <header className="e1-nav">
        <a className="e1-brand" href="#top" aria-label="Omnyo, back to top">
          <FlatMark className="e1-brand-mark" />
          <span>Omnyo</span>
        </a>
        <nav aria-label="Primary">
          <a href="#guides">Guides</a>
          <a className="e1-nav-download" href={MACOS_DOWNLOAD_URL}>
            Download
          </a>
        </nav>
      </header>

      <section className="e1-hero" id="top" aria-labelledby="e1-title">
        {Scene ? (
          <Scene slotRef={slotRef} onStatus={setStatus} startedAt={startedAt} />
        ) : null}

        <div className="e1-hero-inner">
          <div ref={slotRef} className="e1-slot">
            <EclipsePoster />
          </div>

          <div className="e1-hero-copy">
            <h1 id="e1-title">
              <span>The unified interface</span> <span>for coding agents.</span>
            </h1>
            <p className="e1-lede">
              Claude Code and Codex, side by side, on machines you own.
            </p>
            <div className="e1-actions">
              <DownloadButton>Download for macOS</DownloadButton>
              <p className="e1-meta">
                Free to use
                <i aria-hidden="true" />
                Apple Silicon, macOS 13 or later
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="e1-statement" id="story" aria-label="What Omnyo is">
        <p className="e1-statement-lead" data-reveal>
          Bring your coding agents together in one private workspace.
        </p>
        <p className="e1-statement-body" data-reveal>
          Omnyo is a Mac app. Each chat runs in its own thread, and your
          prompts, code and files never pass through a server we host.
        </p>
      </section>

      {PHASES.map((item, index) => (
        <section
          key={item.phase}
          className={`e1-phase e1-phase--${index + 1}`}
          aria-labelledby={`e1-phase-${index + 1}`}
        >
          <div className="e1-phase-head" data-reveal>
            <p className="e1-phase-label">
              <PhaseGlyph offset={item.offset} />
              <span>
                <b>{item.numeral}</b> {item.phase}
              </span>
            </p>
            <h2 id={`e1-phase-${index + 1}`}>{item.title}</h2>
            <p className="e1-phase-body">{item.body}</p>
          </div>
          <figure className="e1-frame" data-reveal>
            <div className="e1-frame-scene">{item.scene}</div>
          </figure>
        </section>
      ))}

      <section className="e1-details" aria-labelledby="e1-details-title">
        <h2 id="e1-details-title" data-reveal>
          Also in Omnyo.
        </h2>
        <ul data-reveal>
          {DETAILS.map((item) => (
            <li key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="e1-guides"
        id="guides"
        aria-labelledby="e1-guides-title"
      >
        <div className="e1-guides-head" data-reveal>
          <h2 id="e1-guides-title">Coming from another tool?</h2>
          <p>
            Each guide walks you through moving your work into Omnyo, step by
            step.
          </p>
        </div>
        <ul className="e1-guide-list" data-reveal>
          {SWITCH_GUIDES.map((guide) => (
            <li key={guide.slug}>
              <a href={`/guides/${guide.slug}`}>
                <span className="e1-guide-from">From</span>
                {guide.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="e1-more" data-reveal>
          {MORE_GUIDES.map((guide) => (
            <a key={guide.slug} href={`/guides/${guide.slug}`}>
              {guide.label}
            </a>
          ))}
        </div>
      </section>

      <section className="e1-finale" aria-labelledby="e1-finale-title">
        <div className="e1-finale-eclipse" data-reveal>
          <EclipsePoster className="e1-poster--finale" />
        </div>
        <div className="e1-finale-copy" data-reveal>
          <h2 id="e1-finale-title">Download Omnyo.</h2>
          <p>
            Free to use, for Macs with Apple Silicon running macOS 13 or later.
            No Omnyo account needed on your own machines.
          </p>
          <DownloadButton className="e1-download--large">
            Download for macOS
          </DownloadButton>
        </div>
      </section>

      <footer className="e1-footer">
        <a className="e1-footer-brand" href="#top" aria-label="Omnyo">
          <FlatMark className="e1-brand-mark" />
          <span>Omnyo</span>
        </a>
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
        <p>© 2026 Omnyo</p>
      </footer>
    </main>
  );
}
