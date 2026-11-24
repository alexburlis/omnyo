import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./scenes.css";
import "./styles.css";

import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import { EclipsePoster, FlatMark, PhaseGlyph } from "./eclipse-mark";
import type EclipseSceneComponent from "./eclipse-scene";
import type { EclipseStatus } from "./eclipse-scene";
import {
  type PathDriver,
  type PathState,
  countdown,
  createPathDriver,
} from "./path";
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

const STOPS = [
  { href: "#top", c: 0.19, label: "First contact" },
  { href: "#e5-ch-1", c: 0.42, label: "Partial eclipse" },
  { href: "#e5-ch-2", c: 0.66, label: "Deep partial" },
  { href: "#e5-ch-3", c: 0.86, label: "Crescent" },
  { href: "#e5-ch-4", c: 0.955, label: "Baily’s beads" },
  { href: "#more", c: 0.971, label: "Diamond ring" },
  { href: "#totality", c: 1, label: "Totality" },
] as const;

const CHAPTERS = [
  {
    numeral: "I",
    stop: 1,
    name: "Side by side",
    title: "Claude Code and Codex, side by side.",
    body: "Start chats with either agent and keep them open together. Every chat runs in its own thread, so one task never spills into another.",
    scene: <SceneSideBySide />,
  },
  {
    numeral: "II",
    stop: 2,
    name: "The second opinion",
    title: "One agent builds. Another reviews.",
    body: "Hand a finished task to a different agent for review. The review runs in its own thread, and you talk the findings through with the reviewer.",
    scene: <SceneReview />,
  },
  {
    numeral: "III",
    stop: 3,
    name: "Your machines",
    title: "It runs on your own machines.",
    body: "Prompts, code and files go to the Omnyo server you run, then to the AI provider you choose. Nothing is hosted by us in between, and you need no Omnyo account on your own machines.",
    scene: <SceneMachines />,
  },
  {
    numeral: "IV",
    stop: 4,
    name: "Anywhere",
    title: "Leave your desk. Keep the thread.",
    body: "Turn on Omnyo Connect, the optional remote access, with a free account. Follow a running chat and steer it from another device.",
    scene: <SceneAnywhere />,
  },
] as const;

const MORE = [
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

const pad2 = (value: number) => String(value).padStart(2, "0");

function activeStop(c: number) {
  let active = 0;

  for (let index = 0; index < STOPS.length; index++) {
    if (c + 0.004 >= (STOPS[index]?.c ?? 1)) active = index;
  }

  return active;
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

function useHud(root: RefObject<HTMLElement | null>) {
  const cache = useRef<{
    phase: HTMLElement[];
    covered: HTMLElement[];
    clock: HTMLElement[];
    filter: HTMLElement[];
    rail: HTMLElement | null;
    poster: HTMLElement | null;
    nav: HTMLElement | null;
    last: Record<string, string>;
  } | null>(null);

  return (state: PathState) => {
    const element = root.current;

    if (!element) return;

    if (!cache.current) {
      const all = (name: string) =>
        Array.from(
          element.querySelectorAll<HTMLElement>(`[data-hud="${name}"]`),
        );

      cache.current = {
        phase: all("phase"),
        covered: all("covered"),
        clock: all("clock"),
        filter: all("filter"),
        rail: element.querySelector<HTMLElement>(".e5-rail"),
        poster: element.querySelector<HTMLElement>(".e5-poster"),
        nav: element.querySelector<HTMLElement>(".e5-nav"),
        last: {},
      };
    }

    const hud = cache.current;
    const active = activeStop(state.c);

    const write = (key: string, targets: HTMLElement[], text: string) => {
      if (hud.last[key] === text) return;
      hud.last[key] = text;

      for (const target of targets) target.textContent = text;
    };

    write("phase", hud.phase, STOPS[active]?.label ?? "");
    write(
      "covered",
      hud.covered,
      `${(state.obscuration * 100).toFixed(state.obscuration > 0.995 ? 0 : 1)}%`,
    );
    write("clock", hud.clock, countdown(state.c));
    write(
      "filter",
      hud.filter,
      state.filter > 0.5 ? "Solar filter on" : "Filter off",
    );

    if (hud.rail && hud.last.active !== String(active)) {
      hud.last.active = String(active);
      hud.rail.dataset.active = String(active);
    }

    if (hud.nav) {
      const solid = window.scrollY > 24 ? "true" : "false";

      if (hud.last.solid !== solid) {
        hud.last.solid = solid;
        hud.nav.dataset.solid = solid;
      }
    }

    const poster = hud.poster;

    if (poster) {
      const set = (name: string, value: number) =>
        poster.style.setProperty(name, value.toFixed(3));

      set("--e5-cx", state.cx);
      set("--e5-cy", state.cy);
      set("--e5-r", state.r);
      set("--e5-ox", state.ox);
      set("--e5-oy", state.oy);
      set("--e5-or", state.or);
      set("--e5-dark", state.dark);
      set("--e5-corona", state.corona);
      set("--e5-filter", state.filter);
      set("--e5-horizon", state.horizon);
      set("--e5-exposure", 1 - state.obscuration);
    }
  };
}

function DownloadButton({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <a className={`e5-download ${className ?? ""}`} href={MACOS_DOWNLOAD_URL}>
      <span className="e5-download-glow" aria-hidden="true" />
      <span className="e5-download-label">{children}</span>
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

function PhaseTag({ stop }: { stop: number }) {
  const data = STOPS[stop];

  if (!data) return null;

  return (
    <p className="e5-tag">
      <PhaseGlyph c={data.c} />
      <span className="e5-tag-count">
        {pad2(stop + 1)} / {pad2(STOPS.length)}
      </span>
      <span className="e5-tag-name">{data.label}</span>
    </p>
  );
}

export default function Page() {
  const rootRef = useRef<HTMLElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const posterRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<EclipseStatus | "loading">("loading");
  const [driver, setDriver] = useState<PathDriver | null>(null);
  const [Scene, setScene] = useState<typeof EclipseSceneComponent | null>(null);
  const updateHud = useHud(rootRef);
  const hudRef = useRef(updateHud);
  hudRef.current = updateHud;

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

  useEffect(() => {
    const root = rootRef.current;
    const sky = skyRef.current;

    if (!root || !sky) return;

    const created = createPathDriver({
      root,
      sky,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
      onUpdate: (state) => hudRef.current(state),
    });

    setDriver(created);

    return () => created.destroy();
  }, []);

  useReveal(rootRef);

  return (
    <main
      ref={rootRef}
      className={`lab-eclipse-5 is-${status}`}
      aria-label="Omnyo"
    >
      <div ref={skyRef} className="e5-sky" aria-hidden="true">
        <EclipsePoster posterRef={posterRef} />
        {Scene && driver ? (
          <Scene driver={driver} onStatus={setStatus} />
        ) : null}
      </div>

      <header className="e5-nav" data-solid="false">
        <a className="e5-brand" href="#top" aria-label="Omnyo, back to top">
          <FlatMark className="e5-brand-mark" />
          <span>Omnyo</span>
        </a>
        <p className="e5-nav-readout" aria-hidden="true">
          <span data-hud="phase">First contact</span>
          <i />
          <span data-hud="covered">0%</span>
        </p>
        <nav aria-label="Primary">
          <a className="e5-nav-link" href="#e5-ch-1">
            The path
          </a>
          <a className="e5-nav-link" href="#more">
            Features
          </a>
          <a className="e5-nav-link" href="#guides">
            Guides
          </a>
          <a className="e5-nav-download" href={MACOS_DOWNLOAD_URL}>
            Download
          </a>
        </nav>
      </header>

      <nav className="e5-rail" data-active="0" aria-label="Eclipse phases">
        <ol>
          {STOPS.map((stop) => (
            <li key={stop.href}>
              <a href={stop.href}>
                <span className="e5-rail-label">{stop.label}</span>
                <PhaseGlyph c={stop.c} />
              </a>
            </li>
          ))}
        </ol>
        <dl className="e5-rail-read" aria-hidden="true">
          <div>
            <dt>Covered</dt>
            <dd data-hud="covered">0%</dd>
          </div>
          <div>
            <dt>To totality</dt>
            <dd data-hud="clock">T−01:06:00</dd>
          </div>
          <div>
            <dt>Camera</dt>
            <dd data-hud="filter">Solar filter on</dd>
          </div>
        </dl>
      </nav>

      <section
        className="e5-hero"
        id="top"
        aria-labelledby="e5-title"
        data-c={STOPS[0].c}
        data-frame="hero"
      >
        <div className="e5-hero-copy">
          <p className="e5-eyebrow">
            <span>Omnyo</span> for macOS
          </p>
          <h1 id="e5-title">The unified interface for coding agents.</h1>
          <p className="e5-lede">
            Run Claude Code and Codex side by side on your own machines, each
            chat in its own thread. Free to use.
          </p>
          <div className="e5-actions">
            <DownloadButton>Download for macOS</DownloadButton>
            <a className="e5-ghost" href="#e5-ch-1">
              See how it works
            </a>
          </div>
          <p className="e5-meta">
            <span>Apple Silicon</span>
            <i />
            <span>macOS 13 or later</span>
            <i className="e5-meta-break" />
            <span>No Omnyo account needed</span>
          </p>
        </div>
        <div className="e5-hero-foot" aria-hidden="true">
          <span className="e5-hero-clock">
            <i />
            <span data-hud="clock">T−01:06:00</span>
            <em>to totality</em>
          </span>
          <span className="e5-scroll">Scroll to follow the eclipse</span>
        </div>
      </section>

      {CHAPTERS.map((chapter, index) => (
        <section
          key={chapter.numeral}
          className={`e5-chapter e5-chapter--${index + 1}`}
          id={`e5-ch-${index + 1}`}
          aria-labelledby={`e5-ch-title-${index + 1}`}
        >
          <div
            className="e5-open"
            data-c={STOPS[chapter.stop]?.c}
            data-frame="side"
          >
            <div className="e5-open-copy" data-reveal>
              <PhaseTag stop={chapter.stop} />
              <p className="e5-chapter-name">
                <span className="e5-numeral">{chapter.numeral}</span>
                {chapter.name}
              </p>
              <h2 id={`e5-ch-title-${index + 1}`}>{chapter.title}</h2>
              <p className="e5-open-body">{chapter.body}</p>
            </div>
          </div>
          <figure className="e5-frame" data-reveal>
            <div className="e5-frame-scene">{chapter.scene}</div>
            <figcaption className="e5-frame-caption" aria-hidden="true">
              <span>
                Fig. {chapter.numeral} · {chapter.name}
              </span>
              <span>{STOPS[chapter.stop]?.label}</span>
            </figcaption>
          </figure>
        </section>
      ))}

      <section className="e5-more" id="more" aria-labelledby="e5-more-title">
        <div className="e5-open" data-c={STOPS[5].c} data-frame="side">
          <div className="e5-open-copy" data-reveal>
            <PhaseTag stop={5} />
            <h2 id="e5-more-title">
              Four more things, <em>built in.</em>
            </h2>
            <p className="e5-open-body">
              Preview links for every branch, agents that run on a schedule, a
              real browser for your agent, and plugins for the rest.
            </p>
          </div>
        </div>
        <ul className="e5-more-grid" data-reveal>
          {MORE.map((item, index) => (
            <li key={item.title} className="e5-more-card">
              <span className="e5-more-index" aria-hidden="true">
                {pad2(index + 1)}
              </span>
              <div className="e5-more-visual" aria-hidden="true">
                {item.visual}
              </div>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
        <div className="e5-guides" id="guides" data-reveal>
          <div className="e5-guides-head">
            <h3>Coming from another tool?</h3>
            <p>
              Each guide walks you through moving your work into Omnyo, step by
              step.
            </p>
          </div>
          <div className="e5-guides-lists">
            <div>
              <p className="e5-guides-label">Switch from</p>
              <ul className="e5-chips">
                {SWITCH_GUIDES.map((guide) => (
                  <li key={guide.slug}>
                    <a href={`/guides/${guide.slug}`}>{guide.label}</a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="e5-guides-label">Guides</p>
              <ul className="e5-chips">
                {MORE_GUIDES.map((guide) => (
                  <li key={guide.slug}>
                    <a href={`/guides/${guide.slug}`}>{guide.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <div className="e5-end" data-c={STOPS[6].c} data-frame="center">
        <section
          className="e5-finale"
          id="totality"
          aria-labelledby="e5-finale-title"
        >
          <div className="e5-finale-copy" data-reveal>
            <PhaseTag stop={6} />
            <h2 id="e5-finale-title">
              Bring your coding agents <em>together.</em>
            </h2>
            <p>
              Free to use, for Macs with Apple Silicon running macOS 13 or
              later. No Omnyo account needed on your own machines.
            </p>
            <DownloadButton className="e5-download--large">
              Download Omnyo for macOS
            </DownloadButton>
          </div>
        </section>

        <footer className="e5-footer">
          <a className="e5-brand" href="#top" aria-label="Omnyo, back to top">
            <FlatMark className="e5-brand-mark" />
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
      </div>
    </main>
  );
}
