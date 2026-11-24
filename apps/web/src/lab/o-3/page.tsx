import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import {
  type ReactNode,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import {
  BrowserMock,
  PhoneMock,
  ReviewMock,
  ScheduleMock,
  ThreadsMock,
} from "./mocks";
import type { StageStatus } from "./stage";
import type { Journey, WorldName } from "./worlds";

const Stage = lazy(() => import("./stage"));

const CHAPTERS = [
  {
    id: "parallel",
    world: "dawn",
    number: "01",
    name: "Parallel agents",
    title: "Claude Code and Codex, side by side.",
    body: "Start a chat with either agent. Every chat lives in its own thread, so several tasks move at once and you switch between them without losing your place.",
    points: [
      "Claude Code and Codex in one app",
      "Each chat in its own thread",
      "Extend it with plugins",
    ],
    mock: <ThreadsMock />,
  },
  {
    id: "review",
    world: "mist",
    number: "02",
    name: "Review",
    title: "One agent builds. Another reviews.",
    body: "Hand a finished task to a different agent. The reviewer works in its own thread, and you talk its findings through with it before you decide what to change.",
    points: [
      "Builder and reviewer in separate threads",
      "Mix providers: Codex builds, Claude Code reviews",
      "Discuss the review like any other chat",
    ],
    mock: <ReviewMock />,
  },
  {
    id: "anywhere",
    world: "noon",
    number: "03",
    name: "Work from anywhere",
    title: "Leave the desk. Keep the thread.",
    body: "Turn on Omnyo Connect to follow and steer your chats from another device. It is optional and needs a free account. Omnyo itself does not.",
    points: [
      "Follow running chats from your phone",
      "Answer an agent that needs you",
      "Optional, with a free account",
    ],
    mock: <PhoneMock />,
  },
  {
    id: "schedules",
    world: "morning",
    number: "04",
    name: "Schedules",
    title: "Agents that start on time.",
    body: "Put an agent on a schedule. A weekday run can triage new issues before you start work, and its reports collect in one thread.",
    points: [
      "Recurring or one-off runs",
      "Pick the agent and the repository",
      "Reports in one thread, or a worktree per run",
    ],
    mock: <ScheduleMock />,
  },
  {
    id: "browser",
    world: "lilac",
    number: "05",
    name: "Browser",
    title: "It clicks through the change for you.",
    body: "Give your agent a real browser. It walks through the change and comes back with screenshots. Each branch can run its own dev server with a live preview link.",
    points: [
      "A real browser for the agent",
      "Screenshots of every step",
      "A dev server and preview link per branch",
    ],
    mock: <BrowserMock />,
  },
] as const satisfies readonly {
  id: string;
  world: WorldName;
  number: string;
  name: string;
  title: string;
  body: string;
  points: readonly string[];
  mock: ReactNode;
}[];

const SWITCH_GUIDES = [
  ["Claude Code", "switch-from-claude-code"],
  ["Codex", "switch-from-codex"],
  ["Conductor", "switch-from-conductor"],
  ["Cursor", "switch-from-cursor"],
  ["Superset", "switch-from-superset"],
  ["T3 Code", "switch-from-t3-code"],
  ["Vibe Kanban", "switch-from-vibe-kanban"],
] as const;

const READING = [
  ["Orchestrate coding agents", "orchestrate-coding-agents"],
  ["Claude Code and Codex together", "claude-code-and-codex-together"],
  ["Work from anywhere", "work-from-anywhere"],
  ["Remote dev servers", "remote-dev-servers"],
  ["Run an agent on a schedule", "run-an-agent-on-a-schedule"],
  ["Give your agent a browser", "agent-browser"],
] as const;

const FACTS = [
  ["Free", "Uses your own agent plans"],
  ["Open source", "Built on bb"],
  ["macOS 13 or later", "For Apple Silicon"],
  ["No Omnyo account", "On your own machines"],
] as const;

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

const smooth = (t: number) => t * t * (3 - 2 * t);

function timecode(seconds: number) {
  const whole = Math.floor(seconds);
  const frames = Math.floor((seconds - whole) * 24);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}:${pad(frames)}`;
}

function OMark() {
  return <span className="o3-mark" aria-hidden="true" />;
}

function Download({ variant = "solid" }: { variant?: "solid" | "ghost" }) {
  return (
    <a
      className={`o3-download o3-download--${variant}`}
      href={MACOS_DOWNLOAD_URL}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2v8m0 0 3.2-3.2M8 10 4.8 6.8M3 13.5h10" />
      </svg>
      Download for macOS
    </a>
  );
}

export default function Page() {
  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const finaleRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const railRef = useRef<HTMLSpanElement>(null);

  const journey = useRef<Journey>({
    hero: 0,
    finale: 0,
    from: "dawn",
    to: "dawn",
    blend: 0,
  });

  const [status, setStatus] = useState<StageStatus | "loading">("loading");
  const [webgl, setWebgl] = useState(true);

  useEffect(() => {
    const probe = document.createElement("canvas");

    const supported = Boolean(
      window.WebGL2RenderingContext && probe.getContext("webgl2"),
    );

    if (!supported) setWebgl(false);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const hero = heroRef.current;
    const finale = finaleRef.current;
    const footer = footerRef.current;

    if (!root || !hero || !finale || !footer) return;

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let frame = 0;
    let width = 0;
    let lastHeight = 0;

    const finePointer = window.matchMedia("(pointer: fine)").matches;

    const setViewport = () => {
      const height = window.innerHeight;

      if (
        window.innerWidth === width &&
        (!finePointer || height === lastHeight)
      )
        return;
      width = window.innerWidth;
      lastHeight = height;
      root.style.setProperty("--o3-vh", `${window.innerHeight}px`);
    };

    const reveals = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            reveals.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );

    for (const element of root.querySelectorAll(".o3-reveal")) {
      reveals.observe(element);
    }

    const update = () => {
      frame = 0;
      const vh = window.innerHeight;
      const heroRect = hero.getBoundingClientRect();

      let heroProgress = clamp01(
        -heroRect.top / Math.max(heroRect.height - vh, 1),
      );

      if (reduced) heroProgress = heroProgress < 0.5 ? 0 : 1;

      const finaleRect = finale.getBoundingClientRect();

      let finaleProgress = clamp01((vh * 0.4 - finaleRect.top) / (vh * 1.25));

      if (reduced) finaleProgress = finaleProgress > 0.2 ? 1 : 0;

      const sections = root.querySelectorAll<HTMLElement>("[data-world]");
      const center = vh * 0.5;
      let from: WorldName = "dawn";
      let to: WorldName = "dawn";
      let blend = 0;
      let label = "Opening";

      for (let index = 0; index < sections.length; index++) {
        const section = sections[index];

        if (!section) continue;
        const rect = section.getBoundingClientRect();

        if (rect.top <= center && rect.bottom > center) {
          from = section.dataset.world as WorldName;
          label = section.dataset.label ?? label;
          const next = sections[index + 1];
          const zone = vh * 0.5;
          const remaining = rect.bottom - center;

          if (next && remaining < zone) {
            to = next.dataset.world as WorldName;
            blend = smooth(clamp01(1 - remaining / zone));
          } else {
            to = from;
          }

          break;
        }
      }

      if (heroProgress < 0.8 && heroRect.bottom > center) label = "Opening";

      const state = journey.current;
      state.hero = heroProgress;
      state.finale = finaleProgress;
      state.from = from;
      state.to = to;
      state.blend = blend;

      const max = document.documentElement.scrollHeight - vh;
      const ratio = max > 0 ? clamp01(window.scrollY / max) : 0;
      root.style.setProperty("--o3-hero", heroProgress.toFixed(4));
      root.style.setProperty("--o3-finale", finaleProgress.toFixed(4));
      const lift = Math.max(0, vh - footer.getBoundingClientRect().top);
      root.style.setProperty("--o3-lift", `${Math.round(lift)}px`);

      if (finaleProgress > 0.96) root.dataset.finale = "seen";

      if (labelRef.current && labelRef.current.textContent !== label) {
        labelRef.current.textContent = label;
      }

      if (clockRef.current)
        clockRef.current.textContent = timecode(ratio * 312);

      if (railRef.current) railRef.current.style.transform = `scaleX(${ratio})`;
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    setViewport();
    update();

    const onResize = () => {
      setViewport();
      schedule();
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frame);
      reveals.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const staticMode = !webgl || status === "failed";

  return (
    <div
      ref={rootRef}
      className={`lab-o-3${staticMode ? " is-static" : ""}${status === "live" ? " is-live" : ""}`}
    >
      <div className="o3-stage">
        {webgl && status !== "failed" ? (
          <Suspense fallback={null}>
            <Stage journey={journey} onStatus={setStatus} />
          </Suspense>
        ) : null}
        <div className="o3-poster" aria-hidden="true">
          <div className="o3-poster-sun" />
          <div className="o3-poster-water" />
          <div className="o3-poster-ring">
            <div className="o3-poster-hole" />
          </div>
        </div>
      </div>
      <div className="o3-grain" aria-hidden="true" />

      <header className="o3-bar o3-bar--top">
        <a className="o3-brand" href="/">
          <OMark />
          Omnyo
        </a>
        <nav className="o3-nav" aria-label="Main">
          <a href="/guides/orchestrate-coding-agents">Guides</a>
          <a href="/plugin-guide">Plugins</a>
          <a className="o3-nav-download" href={MACOS_DOWNLOAD_URL}>
            Download
          </a>
        </nav>
      </header>
      <div className="o3-bar o3-bar--bottom" aria-hidden="true">
        <span className="o3-slate">
          <i className="o3-rec" />
          <span ref={labelRef}>Opening</span>
        </span>
        <span className="o3-rail">
          <span ref={railRef} />
        </span>
        <span className="o3-clock" ref={clockRef}>
          00:00:00:00
        </span>
      </div>

      <main>
        <section
          ref={heroRef}
          className="o3-hero"
          data-world="dawn"
          data-label="Opening"
        >
          <div className="o3-hero-frame">
            <p className="o3-kicker">
              <span>Omnyo</span>
              <span>for macOS</span>
            </p>
            <h1 className="o3-hero-title">
              <span className="o3-hero-left">The unified interface</span>
              <span className="o3-hero-gap" aria-hidden="true" />
              <span className="o3-hero-right">for coding agents.</span>
            </h1>
            <div className="o3-hero-foot">
              <p className="o3-hero-lede">
                Run Claude Code and Codex side by side on your own machines.
                Free, open source, and no Omnyo account needed.
              </p>
              <div className="o3-hero-actions">
                <Download />
                <span className="o3-hero-meta">
                  Apple Silicon · macOS 13 or later
                </span>
              </div>
            </div>
            <div className="o3-crossing" aria-hidden="true">
              <span>Through the O</span>
              <strong>Five chapters, one workspace.</strong>
            </div>
            <p className="o3-cue">
              <span>Scroll to step through</span>
              <i aria-hidden="true" />
            </p>
          </div>
        </section>

        {CHAPTERS.map((chapter, index) => (
          <section
            key={chapter.id}
            id={chapter.id}
            className={`o3-chapter${index % 2 ? " o3-chapter--flip" : ""}`}
            data-world={chapter.world}
            data-label={`${chapter.number} ${chapter.name}`}
          >
            <div className="o3-card o3-reveal">
              <p className="o3-card-num">
                <span>Chapter {chapter.number}</span>
                <span className="o3-card-rule" aria-hidden="true" />
                <span>{chapter.name}</span>
              </p>
              <h2 className="o3-card-title">{chapter.title}</h2>
              <p className="o3-card-count" aria-hidden="true">
                {chapter.number} / 05
              </p>
            </div>
            <div className="o3-scene">
              <div className="o3-scene-copy o3-reveal">
                <p className="o3-scene-label">
                  {chapter.number} · {chapter.name}
                </p>
                <p className="o3-scene-body">{chapter.body}</p>
                <ul className="o3-points">
                  {chapter.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
              <div className="o3-scene-mock o3-reveal">{chapter.mock}</div>
            </div>
          </section>
        ))}

        <section
          className="o3-private"
          data-world="blue"
          data-label="Interlude · Private"
        >
          <div className="o3-card o3-reveal">
            <p className="o3-card-num">
              <span>Interlude</span>
              <span className="o3-card-rule" aria-hidden="true" />
              <span>Private by design</span>
            </p>
            <h2 className="o3-card-title o3-card-title--wide">
              <span>Your machines. Your provider.</span>{" "}
              <span>Nothing in between.</span>
            </h2>
          </div>
          <div className="o3-route o3-reveal">
            <div className="o3-node">
              <span className="o3-node-tag">You</span>
              <strong>Your Mac</strong>
              <small>Prompts, code and files</small>
            </div>
            <span className="o3-route-line" aria-hidden="true" />
            <div className="o3-node">
              <span className="o3-node-tag">Yours</span>
              <strong>Your Omnyo server</strong>
              <small>Runs on your machines</small>
            </div>
            <span className="o3-route-line" aria-hidden="true" />
            <div className="o3-node">
              <span className="o3-node-tag">Your choice</span>
              <strong>Your AI provider</strong>
              <small>The one you choose</small>
            </div>
          </div>
          <p className="o3-private-note o3-reveal">
            Prompts, code and files go to the Omnyo server you run, then to the
            AI provider you choose. Nothing is hosted by us in between.
          </p>
          <dl className="o3-facts o3-reveal">
            {FACTS.map(([term, detail]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{detail}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          className="o3-credits"
          data-world="night"
          data-label="Credits · Guides"
        >
          <div className="o3-credits-inner o3-reveal">
            <p className="o3-card-num o3-card-num--center">
              <span>Coming from another tool</span>
            </p>
            <h2 className="o3-credits-title">Switching guides</h2>
            <ul className="o3-roll">
              {SWITCH_GUIDES.map(([name, slug]) => (
                <li key={slug}>
                  <span className="o3-roll-role">From</span>
                  <span className="o3-roll-dots" aria-hidden="true" />
                  <a href={`/guides/${slug}`}>{name}</a>
                </li>
              ))}
            </ul>
            <h3 className="o3-credits-sub">Further reading</h3>
            <ul className="o3-reading">
              {READING.map(([name, slug]) => (
                <li key={slug}>
                  <a href={`/guides/${slug}`}>{name}</a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          ref={finaleRef}
          className="o3-finale"
          data-world="dusk"
          data-label="Finale"
        >
          <div className="o3-finale-backdrop" aria-hidden="true">
            <div className="o3-poster-ring">
              <div className="o3-poster-hole" />
            </div>
          </div>
          <div className="o3-finale-frame">
            <div className="o3-finale-content">
              <p className="o3-finale-kicker">Omnyo for macOS</p>
              <h2 className="o3-finale-title">Step through.</h2>
              <Download />
              <p className="o3-finale-meta">Free · Open source · macOS 13+</p>
            </div>
          </div>
        </section>
      </main>

      <footer ref={footerRef} className="o3-footer">
        <div className="o3-footer-brand">
          <OMark />
          <span>Omnyo</span>
          <small>The unified interface for coding agents.</small>
        </div>
        <p className="o3-footer-built">
          Built on <a href={BB_URL}>bb</a> (MIT License)
        </p>
        <nav className="o3-footer-links" aria-label="Legal">
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/imprint">Imprint</a>
        </nav>
        <p className="o3-footer-copy">© 2026 Omnyo</p>
      </footer>
    </div>
  );
}
