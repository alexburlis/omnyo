import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
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
import { AppMock, type MockView, PhoneMock } from "../app-mock/app-mock";
import { startGlide } from "../app-mock/glide";

const TITLE_CARDS = ["Claude Code.", "Codex.", "One private workspace."];

const STEPS: readonly {
  view: MockView;
  numeral: string;
  name: string;
  title: ReactNode;
  body: string;
}[] = [
  {
    view: "overview",
    numeral: "",
    name: "Inside the app",
    title: (
      <>
        A working day, <em>in one window.</em>
      </>
    ),
    body: "Keep scrolling. Each chapter shows a flow you will use in the Omnyo app on your Mac.",
  },
  {
    view: "split",
    numeral: "I",
    name: "Side by side",
    title: "Claude Code and Codex, open together.",
    body: "Start chats with either agent and keep them open side by side. Every chat runs in its own thread, so one task never spills into another.",
  },
  {
    view: "review",
    numeral: "II",
    name: "The second opinion",
    title: "One agent builds. Another reviews.",
    body: "Hand a finished task to a different agent. The review runs in its own thread, and you talk the findings through with the reviewer.",
  },
  {
    view: "preview",
    numeral: "III",
    name: "Every branch, running",
    title: "A live preview for every branch.",
    body: "Each branch runs its own dev server with a preview link. Your agent can click through the change in a real browser and show you screenshots.",
  },
  {
    view: "schedule",
    numeral: "IV",
    name: "On a schedule",
    title: "Agents that start on time.",
    body: "Run an agent on a schedule, such as issue triage every weekday morning, so the work is under way before you sit down.",
  },
  {
    view: "anywhere",
    numeral: "V",
    name: "Anywhere",
    title: "Leave your desk. Keep the thread.",
    body: "Turn on Omnyo Connect, the optional remote access with a free account, to follow a running chat and steer it from another device.",
  },
];

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

const ROUTE = [
  {
    index: "01",
    name: "Your Mac",
    body: "The Omnyo app, where you write prompts and read diffs.",
  },
  {
    index: "02",
    name: "Your Omnyo server",
    body: "Runs on a machine you own. Prompts, code and files go here first.",
  },
  {
    index: "03",
    name: "Your AI provider",
    body: "The one you choose for Claude Code or Codex.",
  },
] as const;

const FACTS = [
  { title: "Free", body: "Download it and use it at no cost." },
  { title: "Open source", body: "Read the code, and build on it." },
  { title: "Plugins", body: "Extend Omnyo when your workflow needs more." },
  {
    title: "No Omnyo account",
    body: "Not needed to use it on your own machines.",
  },
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

const pad = (value: number) => String(value).padStart(2, "0");

function timeOfDay(now: Date) {
  const frames = Math.floor((now.getMilliseconds() / 1000) * 24);

  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}:${pad(frames)}`;
}

function useTimecode(target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = target.current;

    if (!element) return;
    element.textContent = timeOfDay(new Date());

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let visible = true;

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });

    observer.observe(element);

    const tick = () => {
      frame = requestAnimationFrame(tick);

      if (visible) element.textContent = timeOfDay(new Date());
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [target]);
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

function useStory(story: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const element = story.current;

    if (!element) return;
    let frame = 0;

    const update = () => {
      frame = 0;
      const bounds = element.getBoundingClientRect();
      const top = bounds.top + window.scrollY;
      const viewport = window.innerHeight;
      const step = viewport * 0.8;
      const travelled = -bounds.top;
      const rise = top > 0 ? clamp01(1 - bounds.top / top) : 1;

      const index = Math.min(
        STEPS.length - 1,
        Math.max(0, Math.floor(travelled / step + 0.35)),
      );

      const total = step * (STEPS.length - 1);
      element.style.setProperty("--e4-rise", rise.toFixed(4));
      element.parentElement?.style.setProperty("--e4-lift", rise.toFixed(4));
      element.style.setProperty(
        "--e4-progress",
        clamp01(travelled / total).toFixed(4),
      );
      setActive(index);
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    const stopGlide = startGlide(() => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      const step = window.innerHeight * 0.8;

      return STEPS.map((_, index) => top + (index + 0.15) * step);
    });

    return () => {
      stopGlide();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [story]);

  return active;
}

function DownloadButton({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <a className={`e4-download ${className ?? ""}`} href={MACOS_DOWNLOAD_URL}>
      <span className="e4-download-glow" aria-hidden="true" />
      <span className="e4-download-label">{children}</span>
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
  const storyRef = useRef<HTMLElement>(null);
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
  const active = useStory(storyRef);
  const current = STEPS[active] ?? STEPS[0];

  return (
    <main
      ref={rootRef}
      className={`lab-eclipse-4 ${stage} is-${status}`}
      aria-label="Omnyo"
    >
      <header className="e4-nav">
        <a className="e4-brand" href="#top" aria-label="Omnyo, back to top">
          <FlatMark className="e4-brand-mark" />
          <span>Omnyo</span>
        </a>
        <nav aria-label="Primary">
          <a href="#story">The app</a>
          <a href="#yours">Privacy</a>
          <a href="#guides">Guides</a>
          <a className="e4-nav-download" href={MACOS_DOWNLOAD_URL}>
            Download
          </a>
        </nav>
      </header>

      <section className="e4-hero" id="top" aria-labelledby="e4-title">
        {Scene ? (
          <Scene slotRef={slotRef} onStatus={setStatus} startedAt={startedAt} />
        ) : null}
        <div className="e4-bar e4-bar--top" aria-hidden="true" />
        <div className="e4-bar e4-bar--bottom" aria-hidden="true" />

        <div className="e4-hero-inner">
          <div ref={slotRef} className="e4-slot">
            <EclipsePoster />
          </div>

          <div className="e4-hero-copy">
            <div className="e4-cards" aria-hidden="true">
              {TITLE_CARDS.map((card, index) => (
                <p key={card} className={`e4-card e4-card--${index + 1}`}>
                  {card}
                </p>
              ))}
            </div>
            <div className="e4-title">
              <p className="e4-eyebrow">
                <span>Omnyo</span> for macOS
              </p>
              <h1 id="e4-title">The unified interface for coding agents.</h1>
              <p className="e4-lede">
                Run Claude Code and Codex side by side on your own machines,
                each chat in its own thread. Free to use.
              </p>
              <div className="e4-actions">
                <DownloadButton>Download for macOS</DownloadButton>
                <a className="e4-ghost" href="#story">
                  See the app
                </a>
              </div>
              <p className="e4-meta">
                <span>Apple Silicon</span>
                <i />
                <span>macOS 13 or later</span>
                <i className="e4-meta-break" />
                <span>No Omnyo account needed</span>
              </p>
            </div>
          </div>
        </div>

        <div className="e4-hero-foot" aria-hidden="true">
          <span className="e4-rec">
            <i />
            <span ref={timecodeRef}>--:--:--:--</span>
          </span>
          <span className="e4-scroll">Scroll</span>
        </div>
      </section>

      <section
        ref={storyRef}
        className={`e4-story is-step-${active}`}
        id="story"
        aria-labelledby="e4-story-title"
        style={{ "--e4-steps": STEPS.length } as CSSProperties}
      >
        <div className="e4-set">
          <div className="e4-set-sky" aria-hidden="true" />
          <div className="e4-set-sun" aria-hidden="true">
            <EclipsePoster className="e4-poster--set" />
          </div>

          <div className="e4-band">
            <h2 id="e4-story-title" className="e4-visually-hidden">
              Omnyo, chapter by chapter
            </h2>
            <ol className="e4-band-texts">
              {STEPS.map((step, index) => (
                <li
                  key={step.view}
                  className={index === active ? "is-active" : ""}
                  aria-current={index === active ? "step" : undefined}
                >
                  <p className="e4-band-kicker">
                    {step.numeral ? (
                      <span className="e4-band-numeral">{step.numeral}</span>
                    ) : null}
                    {step.name}
                  </p>
                  <h3>{step.title}</h3>
                  <p className="e4-band-body">{step.body}</p>
                </li>
              ))}
            </ol>
            <div className="e4-band-index" aria-hidden="true">
              {STEPS.slice(1).map((step, index) => (
                <span
                  key={step.view}
                  className={index + 1 === active ? "is-active" : ""}
                >
                  {step.numeral}
                </span>
              ))}
              <i className="e4-band-track">
                <b />
              </i>
            </div>
          </div>

          <div className="e4-rig">
            <div className="e4-rig-halo" aria-hidden="true" />
            <div className="e4-rig-tilt">
              <AppMock view={current.view} />
            </div>
            <div
              className={`e4-rig-phone ${current.view === "anywhere" ? "is-in" : ""}`}
            >
              <PhoneMock />
            </div>
          </div>
        </div>
      </section>

      <section className="e4-yours" id="yours" aria-labelledby="e4-yours-title">
        <div className="e4-yours-head" data-reveal>
          <p className="e4-label">Your machines</p>
          <h2 id="e4-yours-title">
            Nothing hosted by us <em>in between.</em>
          </h2>
          <p>
            Prompts, code and files go to the Omnyo server you run, then to the
            AI provider you choose.
          </p>
        </div>
        <ol className="e4-route" data-reveal>
          {ROUTE.map((node, index) => (
            <li key={node.index} className={index === 1 ? "is-core" : ""}>
              <span className="e4-route-index">{node.index}</span>
              <strong>{node.name}</strong>
              <span>{node.body}</span>
            </li>
          ))}
          <li className="e4-route-beam" aria-hidden="true">
            <i />
            <i />
          </li>
        </ol>
        <ul className="e4-facts" data-reveal>
          {FACTS.map((fact) => (
            <li key={fact.title}>
              <strong>{fact.title}</strong>
              <span>{fact.body}</span>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="e4-guides"
        id="guides"
        aria-labelledby="e4-guides-title"
      >
        <div className="e4-guides-head" data-reveal>
          <p className="e4-label">Switching over</p>
          <h2 id="e4-guides-title">
            Coming from <em>another tool?</em>
          </h2>
          <p>
            Each guide walks you through moving your work into Omnyo, step by
            step.
          </p>
        </div>
        <ul className="e4-guide-list" data-reveal>
          {SWITCH_GUIDES.map((guide, index) => (
            <li key={guide.slug}>
              <a href={`/guides/${guide.slug}`}>
                <span className="e4-guide-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="e4-guide-from">From</span>
                <span className="e4-guide-name">{guide.label}</span>
                <span className="e4-guide-go" aria-hidden="true">
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
        <div className="e4-more" data-reveal>
          <span className="e4-more-label">More guides</span>
          {MORE_GUIDES.map((guide) => (
            <a key={guide.slug} href={`/guides/${guide.slug}`}>
              {guide.label}
            </a>
          ))}
        </div>
      </section>

      <section className="e4-finale" aria-labelledby="e4-finale-title">
        <div className="e4-finale-eclipse" data-reveal>
          <EclipsePoster className="e4-poster--finale" />
        </div>
        <div className="e4-finale-copy" data-reveal>
          <p className="e4-label">Now available</p>
          <h2 id="e4-finale-title">
            Bring your coding agents <em>together.</em>
          </h2>
          <p>
            Free to use, for Macs with Apple Silicon running macOS 13 or later.
          </p>
          <DownloadButton className="e4-download--large">
            Download Omnyo for macOS
          </DownloadButton>
        </div>
        <div className="e4-billing" data-reveal>
          <p className="e4-billing-lead">
            <span>Omnyo</span> The unified interface for coding agents
          </p>
          <p className="e4-billing-block">
            {BILLING.map((phrase, index) => (
              <span key={phrase.join("")}>
                {index > 0 ? " · " : null}
                <span className="e4-billing-item">
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

      <footer className="e4-footer">
        <div className="e4-footer-brand">
          <FlatMark className="e4-brand-mark" />
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
        <p className="e4-copyright">© 2026 Omnyo</p>
      </footer>
    </main>
  );
}
