import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import "./chrome-extras.css";

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { comparisonMetas, comparisonPath } from "../../compare/comparisons";
import { getFeatureMeta } from "../../features/features";
import { DownloadButton, DownloadPanel } from "../../landing/download";
import { GitHubButton } from "../../landing/github";
import { BB_URL } from "../../landing/site";
import {
  SiteNavLinks,
  SiteNavMenu,
  useSiteFooterProductLinks,
} from "../../landing/site-chrome";
import { ThemeToggle } from "../../landing/theme-toggle";
import {
  PLATFORM_LINE,
  STORY_LINES,
  SWITCH_GUIDES,
  THREADS,
  TOPIC_GUIDES,
  WINDOWS,
} from "./content";
import { startStory } from "./story";

export const at = (start: number, duration = 0.08) =>
  ({ "--a": start, "--d": duration }) as CSSProperties;

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="7 7 50 50"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M46.85 12.3a24.7 24.7 0 1 0 5.45 5.45L43.2 26.85a12.15 12.15 0 1 1-6.05-6.05Z"
        fill="currentColor"
      />
      <circle cx="49.5" cy="14.5" r="6.5" className="mark-dot" />
    </svg>
  );
}

export function GetButton({ size = "md" }: { size?: "md" | "lg" }) {
  return <DownloadButton size={size} />;
}

export interface TerminalWindow {
  title: string;
  lines: readonly string[];
  wait?: string;
}

const PROMPT = /^[›$] /;

const delay = (ms: number) => ({ "--at": `${ms}ms` }) as CSSProperties;

export function Terminal({
  entry,
  index,
}: {
  entry: TerminalWindow;
  index: number;
}) {
  const lines = entry.lines.filter(Boolean);
  const [first = "", ...rest] = lines;
  const command = PROMPT.test(first) ? first.slice(2) : null;
  const output = command === null ? lines : rest;
  const last = output.length - 1;
  const typeMs = command === null ? 0 : Math.min(command.length * 26, 900);

  const printAt = (line: number) =>
    (command === null ? 160 : typeMs + 280) + line * 170;

  return (
    <div
      className={`win win-${index} ${entry.wait ? "win--wait" : ""}`}
      data-win
    >
      <div className="win-bar">
        <span className="win-lights" />
        <span className="win-title">{entry.title}</span>
      </div>
      <div className="win-body">
        {command === null ? null : (
          <p
            className="win-line win-cmd"
            style={
              {
                "--chars": command.length,
                "--type": `${typeMs}ms`,
              } as CSSProperties
            }
          >
            <span className="win-prompt">{first.slice(0, 1)}</span>{" "}
            <span className="win-type">{command}</span>
          </p>
        )}
        {output.map((line, lineIndex) => (
          <p
            className={`win-line ${line.startsWith("✓") ? "win-ok" : ""}`}
            key={`${index}-${lineIndex}`}
            style={delay(printAt(lineIndex))}
          >
            {line}
            {command === null && !entry.wait && lineIndex === last ? (
              <span className="win-cursor win-cursor--inline" />
            ) : null}
          </p>
        ))}
        {entry.wait ? (
          <p
            className="win-line win-wait"
            style={delay(printAt(output.length))}
          >
            {entry.wait}
          </p>
        ) : command === null ? null : (
          <p
            className="win-line win-next"
            style={delay(printAt(output.length))}
          >
            <span className="win-prompt">{first.slice(0, 1)}</span>{" "}
            <span className="win-cursor" />
          </p>
        )}
      </div>
    </div>
  );
}

function Nav({ themed }: { themed: boolean }) {
  return (
    <header className="nav">
      <span className="nav-shade" data-nav-shade aria-hidden="true">
        <span className="veil-disc veil-disc--nav" data-nav-disc="hero" />
        <span className="veil-disc veil-disc--nav" data-nav-disc="story" />
        <span className="veil-disc veil-disc--nav" data-nav-disc="app" />
      </span>
      <a className="nav-brand" href="#top" aria-label="Omnyo, back to top">
        <span className="nav-logo">
          <Mark className="nav-mark" />
          <Mark className="nav-mark nav-mark-dot" />
        </span>
        <span className="nav-word">Omnyo</span>
      </a>
      <div className="nav-act" aria-hidden="true">
        <span className="nav-act-bar">
          <span data-nav-progress />
        </span>
        <span data-act-label>Omnyo</span>
      </div>
      <div className="nav-end">
        <SiteNavLinks path="/" />
        {themed ? <ThemeToggle /> : null}
        <a className="nav-dl" href="#download">
          Get Omnyo
        </a>
        <SiteNavMenu path="/" />
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero" data-progress="local" data-scene="hero" id="top">
      <div className="hero-copy">
        <p className="eyebrow hero-in" style={{ "--i": 0 } as CSSProperties}>
          <span className="eyebrow-dot" />
          Free to use
        </p>
        <h1 className="hero-title">
          <span className="line">
            <span className="hero-in" style={{ "--i": 1 } as CSSProperties}>
              All your
            </span>
          </span>
          <span className="line">
            <span className="hero-in" style={{ "--i": 2 } as CSSProperties}>
              coding agents.
            </span>
          </span>
          <span className="line">
            <span className="hero-in" style={{ "--i": 3 } as CSSProperties}>
              One place<span className="accent-dot">.</span>
            </span>
          </span>
        </h1>
        <p className="hero-sub hero-in" style={{ "--i": 4 } as CSSProperties}>
          Omnyo puts Claude Code and Codex side by side in one private
          workspace, running on your own machines.
        </p>
        <div
          className="hero-actions hero-in"
          style={{ "--i": 5 } as CSSProperties}
        >
          <GetButton />
          <a className="text-link" href="#story">
            See how it works
            <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="hero-meta hero-in" style={{ "--i": 6 } as CSSProperties}>
          {PLATFORM_LINE}
        </p>
      </div>
      <div className="hero-stage" aria-hidden="true">
        <div className="hero-mark" data-anchor="hero-mark">
          <svg className="hero-orbit" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="49.6" />
            <circle cx="50" cy="50" r="38" className="hero-orbit-faint" />
          </svg>
          <Mark className="static-mark" />
          <span className="tag tag--a">claude · harbor-api</span>
          <span className="tag tag--b">codex · lumen-web</span>
          <span className="tag tag--c">preview · feat/settings</span>
        </div>
      </div>
      <div className="hero-scroll" aria-hidden="true">
        <span>Scroll</span>
        <span className="hero-scroll-line" />
      </div>
    </section>
  );
}

function Story() {
  return (
    <section
      className="story"
      data-progress="local"
      data-scene="story"
      id="story"
    >
      <div className="pin story-pin">
        <p className="act-label story-label story-label--a">
          <span>01</span> Scattered
        </p>
        <p className="act-label story-label story-label--b">
          <span>02</span> Gathered
        </p>
        <div className="win-layer" data-win-layer aria-hidden="true">
          {WINDOWS.map((entry, index) => (
            <Terminal entry={entry} index={index} key={entry.title} />
          ))}
        </div>
        <h2 className="story-lines">
          {STORY_LINES.map((line) => (
            <span className="story-line" data-line key={line}>
              {line}
            </span>
          ))}
        </h2>
        <div className="story-mark" data-anchor="story-mark" aria-hidden="true">
          <Mark className="static-mark" />
        </div>
        <div className="story-gathered">
          <h2 className="story-title">
            <span className="k" style={at(0.6, 0.07)}>
              Omnyo brings them
            </span>
            <span className="k" style={at(0.64, 0.07)}>
              into one place.
            </span>
          </h2>
          <p className="story-sub k" style={at(0.69, 0.07)}>
            Every agent, every repository and every preview in one window, so
            you stop hunting for the terminal you need.
          </p>
        </div>
      </div>
    </section>
  );
}

function AppScene() {
  return (
    <section className="app" data-scene="app">
      <div className="pin app-pin">
        <div className="app-copy">
          <p className="act-label k" style={at(-0.55, 0.2)}>
            <span>03</span> Side by side
          </p>
          <h2 className="h2 k" style={at(-0.5, 0.22)}>
            Claude Code and Codex, side by side.
          </h2>
          <p className="body k" style={at(-0.4, 0.22)}>
            Each chat runs in its own thread, so you can keep several agents
            working at once and see what each one is doing at a glance.
          </p>
        </div>
        <div className="mock k" style={at(-0.5, 0.3)} aria-hidden="true">
          <div className="mock-side">
            <div className="mock-lights">
              <i />
              <i />
              <i />
            </div>
            <p className="mock-heading">Threads</p>
            {THREADS.map((thread, index) => (
              <div
                className={`mock-thread k ${index === 0 ? "is-active" : ""}`}
                style={at(-0.2 + index * 0.05, 0.08)}
                key={thread.title}
              >
                <span className={`mock-state mock-state--${thread.state}`} />
                <span className="mock-thread-title">{thread.title}</span>
                <span className="mock-thread-meta">
                  {thread.repo} · {thread.agent}
                </span>
              </div>
            ))}
          </div>
          <div className="mock-pane">
            <div className="mock-pane-head">
              <span className="pill pill--claude">Claude Code</span>
              <span className="mock-branch">fix/webhook-retries</span>
            </div>
            <div className="msg msg--you k" style={at(0.3, 0.05)}>
              Retries fire too fast after a 503. Add a backoff.
            </div>
            <div className="msg k" style={at(0.38, 0.05)}>
              Found it in <code>src/webhooks/retry.ts</code>. Retries use a
              fixed 200 ms delay.
            </div>
            <div className="msg msg--tool k" style={at(0.46, 0.05)}>
              <span>Edited retry.ts</span>
              <span className="add">+18</span>
              <span className="del">−4</span>
            </div>
            <div className="msg k" style={at(0.54, 0.05)}>
              The delay now doubles up to 30 s. Tests pass.
            </div>
            <div className="mock-composer">
              <span>Message Claude Code…</span>
              <span className="mock-send">↑</span>
            </div>
          </div>
          <div className="mock-pane">
            <div className="mock-pane-head">
              <span className="pill pill--codex">Codex</span>
              <span className="mock-branch">feat/settings-form</span>
            </div>
            <div className="msg msg--you k" style={at(0.34, 0.05)}>
              Move the settings page to the new form kit.
            </div>
            <div className="msg k" style={at(0.42, 0.05)}>
              Plan: extract the fields, swap the inputs, keep validation, update
              the tests.
            </div>
            <div className="msg msg--tool k" style={at(0.5, 0.05)}>
              <span>Edited 6 files</span>
              <span className="add">+142</span>
              <span className="del">−97</span>
            </div>
            <div className="msg k" style={at(0.58, 0.05)}>
              Done. The branch preview is running.
              <span className="msg-link">Open preview ↗</span>
            </div>
            <div className="mock-composer">
              <span>Message Codex…</span>
              <span className="mock-send">↑</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewScene() {
  return (
    <section className="review" data-scene="review">
      <div className="pin review-pin">
        <p className="act-label">
          <span>04</span> Build, then review
        </p>
        <div className="review-head">
          <h2
            className="review-title"
            aria-label="One agent builds. Another reviews. You talk it through."
          >
            <span className="review-slot" aria-hidden="true">
              <span>One agent builds.</span>
              <span>Another reviews.</span>
              <span>You talk it through.</span>
            </span>
          </h2>
          <p className="body review-body">
            Hand a finished task to a different agent. It reviews the work in
            its own thread, and you discuss what it found with the reviewer.
          </p>
        </div>
        <div className="flow" aria-hidden="true">
          <svg
            className="flow-lines"
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
          >
            <path d="M0 50 H1000" pathLength="1000" className="flow-base" />
            <path d="M0 50 H1000" pathLength="1000" className="flow-draw" />
          </svg>
          <div className="card card--a">
            <p className="card-kicker">
              <span className="pill pill--codex">Codex</span> builder
            </p>
            <p className="card-branch">feat/export-limits</p>
            <p className="card-line">✓ Per-user limit on /export</p>
            <p className="card-line">✓ 12 tests pass</p>
            <p className="card-foot">Sent for review →</p>
          </div>
          <div className="card card--b">
            <p className="card-kicker">
              <span className="pill pill--claude">Claude Code</span> reviewer
            </p>
            <p className="card-branch">Own thread</p>
            <p className="card-note">
              The limit is counted in memory, so each worker keeps its own
              count.
            </p>
            <p className="card-foot">1 finding</p>
          </div>
          <div className="card card--c">
            <p className="card-kicker">
              <span className="pill pill--you">You</span> with the reviewer
            </p>
            <div className="bubble bubble--you">
              Should the count be shared?
            </div>
            <div className="bubble">
              Yes. Two workers would allow twice the limit.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const MORE = [
  {
    title: "A preview for every branch",
    body: "Run a dev server for every branch and open it from a live preview link.",
    visual: "preview",
  },
  {
    title: "Agents on a schedule",
    body: "Run an agent on a schedule, such as triaging new issues every weekday morning.",
    visual: "schedule",
  },
  {
    title: "A real browser",
    body: "Your agent clicks through the change in a real browser and shows you screenshots.",
    visual: "browser",
  },
  {
    title: "From any device",
    body: "Optional remote access with a free account lets you follow and steer chats from your phone or any browser.",
    visual: "remote",
  },
  {
    title: "Plugins",
    body: "Extend Omnyo with plugins when your workflow needs something it does not do yet.",
    visual: "plugins",
  },
] as const;

function MoreVisual({ kind }: { kind: (typeof MORE)[number]["visual"] }) {
  if (kind === "preview") {
    return (
      <div className="viz viz-preview">
        {[
          ["main", "lumen-web"],
          ["feat/settings-form", "lumen-web"],
          ["fix/webhook-retries", "harbor-api"],
        ].map(([branch, repo]) => (
          <div className="viz-row" key={branch}>
            <span className="viz-live" />
            <span className="viz-branch">{branch}</span>
            <span className="viz-repo">{repo}</span>
            <span className="viz-open">Preview ↗</span>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "schedule") {
    return (
      <div className="viz viz-schedule">
        <p className="viz-time">08:00</p>
        <div className="viz-days">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
            (day, index) => (
              <span className={index < 5 ? "is-on" : ""} key={day}>
                {day}
              </span>
            ),
          )}
        </div>
        <p className="viz-caption">Triage new issues in harbor-api</p>
      </div>
    );
  }

  if (kind === "browser") {
    return (
      <div className="viz viz-browser">
        <div className="viz-browser-bar">
          <i />
          <i />
          <i />
          <span>localhost:5173/settings</span>
        </div>
        <div className="viz-browser-body">
          <span className="viz-field" />
          <span className="viz-field viz-field--short" />
          <span className="viz-button">Save</span>
          <span className="viz-cursor" />
        </div>
        <div className="viz-shots">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  if (kind === "remote") {
    return (
      <div className="viz viz-remote">
        <div className="viz-phone">
          <span className="viz-phone-notch" />
          <span className="viz-bubble">Tests pass. Ready to merge?</span>
          <span className="viz-bubble viz-bubble--you">
            Ship it after review
          </span>
          <span className="viz-input">Reply…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="viz viz-plugins">
      {Array.from({ length: 9 }, (_, index) => (
        <span className={index === 4 ? "is-add" : ""} key={index}>
          {index === 4 ? "+" : ""}
        </span>
      ))}
    </div>
  );
}

function MoreScene() {
  return (
    <section className="more" data-scene="more">
      <div className="pin more-pin">
        <div className="more-head">
          <p className="act-label">
            <span>05</span> Also in Omnyo
          </p>
          <h2 className="h2">The rest of the work, in the same window.</h2>
          <p className="more-count" aria-hidden="true">
            <span>01</span>
            <span className="more-count-bar" />
            <span>0{MORE.length}</span>
          </p>
        </div>
        <div className="more-track">
          {MORE.map((item, index) => (
            <article className="more-card" key={item.title}>
              <p className="more-index">0{index + 1}</p>
              <MoreVisual kind={item.visual} />
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function YoursScene() {
  return (
    <section className="yours" data-scene="yours">
      <div className="pin yours-pin">
        <p className="act-label">
          <span>06</span> Yours
        </p>
        <h2 className="yours-title">
          <span className="k" style={at(-0.45, 0.14)}>
            Your machines.
          </span>
          <span className="k" style={at(-0.3, 0.14)}>
            Your provider.
          </span>
          <span className="k" style={at(-0.12, 0.14)}>
            Nothing in between.
          </span>
        </h2>
        <div className="stream" data-anchor="stream" aria-hidden="true">
          <span className="node node--a">
            <b>Omnyo</b> on your devices
          </span>
          <span className="node node--b">
            <b>The Omnyo server</b> you run
          </span>
          <span className="node node--c">
            <b>The AI provider</b> you choose
          </span>
        </div>
        <p className="body yours-body k" style={at(0, 0.14)}>
          Prompts, code and files go to the Omnyo server you run, then to the AI
          provider you choose. We host nothing in between, and you do not need
          an Omnyo account to use it on your own machines.
        </p>
      </div>
    </section>
  );
}

function CtaScene() {
  return (
    <section className="cta" data-scene="cta" id="download">
      <div className="pin cta-pin">
        <div className="cta-mark" data-anchor="cta-mark" aria-hidden="true">
          <Mark className="static-mark" />
        </div>
        <div className="cta-copy">
          <p className="act-label k" style={at(-0.35, 0.25)}>
            <span>07</span> One place
          </p>
          <h2 className="cta-title k" style={at(-0.3, 0.25)}>
            Put every agent in one place.
          </h2>
          <div className="cta-actions k" style={at(-0.2, 0.25)}>
            <DownloadPanel />
          </div>
          <p className="cta-switch k" style={at(-0.1, 0.25)}>
            Coming from another tool? Read the guide for
            {SWITCH_GUIDES.map((guide, index) => (
              <span key={guide.slug}>
                {index === 0
                  ? " "
                  : index === SWITCH_GUIDES.length - 1
                    ? " or "
                    : ", "}
                <a href={`/guides/${guide.slug}`}>{guide.label}</a>
              </span>
            ))}
            .
          </p>
        </div>
      </div>
    </section>
  );
}

const FOOT_FEATURES = [
  "claude-code-gui",
  "codex-gui",
  "parallel-agents",
  "mobile-remote-control",
  "usage-tracking",
  "voice-coding",
  "open-source",
] as const;

function Footer() {
  const productLinks = useSiteFooterProductLinks();

  return (
    <footer className="foot" data-scene="footer">
      <div className="foot-top">
        <div className="foot-brand">
          <Mark className="foot-mark" />
          <p className="foot-tag">The unified interface for coding agents.</p>
          <div className="foot-get">
            <GetButton />
            <GitHubButton iconOnly />
          </div>
        </div>
        <nav className="foot-cols" aria-label="Footer">
          <div>
            <p className="foot-head">Product</p>
            {FOOT_FEATURES.map((slug) => getFeatureMeta(slug))
              .filter((meta) => meta !== undefined)
              .map((meta) => (
                <a href={`/features/${meta.slug}`} key={meta.slug}>
                  {meta.name}
                </a>
              ))}
            {productLinks.map(({ href, label }) => (
              <a href={href} key={href}>
                {label}
              </a>
            ))}
          </div>
          <div>
            <p className="foot-head">Guides</p>
            {comparisonMetas().map((comparison) => (
              <a href={comparisonPath(comparison.slug)} key={comparison.slug}>
                {comparison.name}
              </a>
            ))}
            {TOPIC_GUIDES.map((guide) => (
              <a href={`/guides/${guide.slug}`} key={guide.slug}>
                {guide.label}
              </a>
            ))}
          </div>
          <div>
            <p className="foot-head">Switch to Omnyo</p>
            {SWITCH_GUIDES.map((guide) => (
              <a href={`/guides/${guide.slug}`} key={guide.slug}>
                From {guide.label}
              </a>
            ))}
          </div>
          <div>
            <p className="foot-head">Legal</p>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
            <a href="/imprint">Imprint</a>
            <a href="/cookies">Cookies</a>
            <button type="button" data-cookie-settings>
              Cookie settings
            </button>
          </div>
        </nav>
      </div>
      <p className="foot-word" aria-hidden="true">
        omnyo
      </p>
      <div className="foot-bottom">
        <span>
          Built on <a href={BB_URL}>bb</a> (MIT License)
        </span>
        <span>© 2026 Omnyo</span>
      </div>
    </footer>
  );
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const watchReducedMotion = (notify: () => void) => {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", notify);

  return () => query.removeEventListener("change", notify);
};

const readReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;

export function KineticShell({
  children,
  header,
  labels,
  onProductProgress,
  productStage = false,
  productMorph = false,
  themed = false,
  className = "",
}: {
  children: ReactNode;
  header?: ReactNode;
  labels?: readonly string[];
  onProductProgress?: (progress: number) => void;
  productStage?: boolean;
  productMorph?: boolean;
  themed?: boolean;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  const reduced = useSyncExternalStore(
    watchReducedMotion,
    readReducedMotion,
    () => false,
  );

  useEffect(() => {
    const root = rootRef.current;

    if (!root) return;

    return startStory(root, reduced, {
      labels,
      onProductProgress,
      productStage,
      productMorph,
      themed,
    });
  }, [reduced, labels, onProductProgress, productStage, productMorph, themed]);

  return (
    <div
      ref={rootRef}
      className={`lab-open-5 ${className} ${reduced ? "is-reduced" : ""}`}
    >
      {reduced ? null : <div className="veil" data-veil aria-hidden="true" />}
      {reduced ? null : (
        <canvas className="particles" data-particles aria-hidden="true" />
      )}
      {header ?? <Nav themed={themed} />}
      <main>{children}</main>
      <Footer />
    </div>
  );
}

export default function Page() {
  return (
    <KineticShell>
      <Hero />
      <Story />
      <AppScene />
      <ReviewScene />
      <MoreScene />
      <YoursScene />
      <CtaScene />
    </KineticShell>
  );
}
