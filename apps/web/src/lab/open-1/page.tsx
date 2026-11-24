import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";

import { BB_URL, MACOS_DOWNLOAD_URL } from "../../landing/site";
import {
  BrowserSpecimen,
  FlowDrawing,
  Mark,
  Plate,
  PluginSpecimen,
  PreviewSpecimen,
  RemoteSpecimen,
  ReviewDrawing,
  ScheduleSpecimen,
  WorkspaceDrawing,
} from "./plates";

const PlateO = lazy(() => import("./plate-o"));

const CHAPTERS = [
  { id: "workspace", n: "01", label: "Workspace" },
  { id: "review", n: "02", label: "Review" },
  { id: "private", n: "03", label: "Private" },
  { id: "index", n: "04", label: "Index" },
  { id: "switch", n: "05", label: "Switch" },
] as const;

const INDEX = [
  {
    n: "4.1",
    title: "Work from anywhere",
    body: "Follow and steer your chats from another device. Omnyo Connect is optional and needs a free account.",
    href: "/guides/work-from-anywhere",
    specimen: <RemoteSpecimen />,
  },
  {
    n: "4.2",
    title: "A dev server for every branch",
    body: "Run a dev server for each branch and open it from a live preview link.",
    href: "/guides/remote-dev-servers",
    specimen: <PreviewSpecimen />,
  },
  {
    n: "4.3",
    title: "Agents on a schedule",
    body: "Run an agent on a schedule with automations, for example to triage new issues every weekday.",
    href: "/guides/run-an-agent-on-a-schedule",
    specimen: <ScheduleSpecimen />,
  },
  {
    n: "4.4",
    title: "A real browser",
    body: "Your agent clicks through a change in a real browser and shows you screenshots of what it saw.",
    href: "/guides/agent-browser",
    specimen: <BrowserSpecimen />,
  },
  {
    n: "4.5",
    title: "Plugins",
    body: "Extend Omnyo with plugins when your workflow needs something it does not do yet.",
    href: null,
    specimen: <PluginSpecimen />,
  },
] as const;

const SWITCH = [
  { name: "Claude Code", slug: "switch-from-claude-code" },
  { name: "Codex", slug: "switch-from-codex" },
  { name: "Conductor", slug: "switch-from-conductor" },
  { name: "Cursor", slug: "switch-from-cursor" },
  { name: "Superset", slug: "switch-from-superset" },
  { name: "T3 Code", slug: "switch-from-t3-code" },
  { name: "Vibe Kanban", slug: "switch-from-vibe-kanban" },
] as const;

function Arrow() {
  return (
    <svg className="o1-arrow" viewBox="0 0 20 12" aria-hidden="true">
      <path d="M0 6h18M13 1l5 5-5 5" fill="none" />
    </svg>
  );
}

function DownloadButton({ tone = "accent" }: { tone?: "accent" | "paper" }) {
  return (
    <a className={`o1-btn o1-btn--${tone}`} href={MACOS_DOWNLOAD_URL}>
      <span>Download for macOS</span>
      <Arrow />
    </a>
  );
}

function Opener({
  n,
  title,
  children,
}: {
  n: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="o1-opener">
      <div className="o1-bignum" data-reveal aria-hidden="true">
        {n}
      </div>
      <h2 className="o1-h2" data-reveal>
        {title}
      </h2>
      {children ? (
        <div className="o1-opener-text" data-reveal>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function RunningHead({
  n,
  label,
  link,
}: {
  n: string;
  label: string;
  link?: { href: string; text: string };
}) {
  return (
    <div className="o1-runhead" data-reveal>
      <span className="o1-runhead-n">{n}</span>
      <span>{label}</span>
      <span className="o1-runhead-fill" />
      {link ? (
        <a href={link.href}>
          {link.text}
          <Arrow />
        </a>
      ) : (
        <span>Omnyo</span>
      )}
    </div>
  );
}

export default function Page() {
  const rootRef = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));

    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const root = rootRef.current;

    if (!root) return;
    const targets = root.querySelectorAll<HTMLElement>("[data-reveal]");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    for (const target of targets) observer.observe(target);

    return () => observer.disconnect();
  }, []);

  return (
    <main
      ref={rootRef}
      className={ready ? "lab-open-1 is-ready" : "lab-open-1"}
    >
      <div className="o1-columns" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => (
          <span key={index} />
        ))}
      </div>

      <header className="o1-mast o1-wrap">
        <a className="o1-brand" href="#top" aria-label="Omnyo, back to top">
          <Mark className="o1-brand-mark" />
          <span>Omnyo</span>
        </a>
        <nav className="o1-nav" aria-label="Chapters">
          {CHAPTERS.map((chapter) => (
            <a key={chapter.id} href={`#${chapter.id}`}>
              <span>{chapter.n}</span>
              {chapter.label}
            </a>
          ))}
        </nav>
        <a className="o1-mast-cta" href={MACOS_DOWNLOAD_URL}>
          Download
          <Arrow />
        </a>
      </header>

      <div className="o1-ruler o1-wrap" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => (
          <span key={index}>{String(index + 1).padStart(2, "0")}</span>
        ))}
      </div>

      <section id="top" className="o1-hero o1-wrap">
        <div className="o1-hero-kicker">
          <span>A macOS app for coding agents</span>
          <span>Works with Claude Code and Codex</span>
        </div>
        <h1 className="o1-hero-title">
          <span className="o1-line">
            <span>The unified</span>
          </span>
          <span className="o1-line">
            <span>interface for</span>
          </span>
          <span className="o1-line">
            <span>
              <em>coding agents.</em>
            </span>
          </span>
        </h1>
        <figure className="o1-cover">
          <div className="o1-cover-plate">
            <div className="o1-cover-meta">
              <span>Plate I</span>
              <span>The Omnyo mark</span>
            </div>
            <div className="o1-cover-shadow" />
            <Suspense fallback={null}>
              <PlateO />
            </Suspense>
            <div className="o1-cover-foot">
              <span>Rendered live in your browser</span>
              <span>Fig. 01</span>
            </div>
          </div>
          <figcaption>
            <b>Plate I.</b> The Omnyo mark, cut in polished steel.
            <span className="o1-hover-only">
              {" "}
              It turns toward your pointer.
            </span>
          </figcaption>
        </figure>
        <p className="o1-hero-deck">
          Omnyo brings your coding agents together in one private workspace. Run
          Claude Code and Codex side by side, each chat in its own thread, on
          machines you own.
        </p>
        <div className="o1-hero-cta">
          <DownloadButton />
          <span className="o1-hero-note">Downloads Omnyo-macOS.zip</span>
        </div>
        <dl className="o1-specs">
          <div>
            <dt>Price</dt>
            <dd>Free</dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd>Open source</dd>
          </div>
          <div>
            <dt>Requires</dt>
            <dd>Apple Silicon, macOS 13+</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>Not needed</dd>
          </div>
        </dl>
      </section>

      <section id="workspace" className="o1-chapter o1-wrap">
        <RunningHead
          n="01"
          label="Workspace"
          link={{
            href: "/guides/claude-code-and-codex-together",
            text: "Guide: Claude Code and Codex together",
          }}
        />
        <Opener
          n="01"
          title={
            <>
              Claude Code and Codex, <em>side by side.</em>
            </>
          }
        >
          <p className="o1-lede">
            Start a chat with either agent and it gets its own thread.
          </p>
          <p>
            Run several at once and move between them from one sidebar, instead
            of a terminal tab for every agent and a note to remember which one
            was doing what.
          </p>
        </Opener>
        <Plate
          number="II"
          title="The workspace"
          note="Fictional project"
          className="o1-plate--wide"
          caption="Two agents working on two branches of one project, each in its own thread. The sidebar lists every chat, including a scheduled one."
        >
          <WorkspaceDrawing />
        </Plate>
      </section>

      <section id="review" className="o1-chapter o1-wrap">
        <RunningHead
          n="02"
          label="Review"
          link={{
            href: "/guides/orchestrate-coding-agents",
            text: "Guide: Orchestrate coding agents",
          }}
        />
        <Opener
          n="02"
          title={
            <>
              One agent builds.
              <br />
              <em>Another reviews.</em>
            </>
          }
        >
          <p className="o1-lede">
            Hand a task to one agent, then have a different agent review the
            result in its own thread.
          </p>
          <p>
            When the reviewer flags something, ask it why. You talk the review
            through with the reviewer, in plain language, before you decide what
            to change.
          </p>
        </Opener>
        <Plate
          number="III"
          title="Build, review, discuss"
          note="Fictional branch"
          className="o1-plate--wide"
          caption="Codex builds on a branch, Claude Code reviews the change in a separate thread, and you question the reviewer about its first note."
        >
          <ReviewDrawing />
        </Plate>
      </section>

      <section id="private" className="o1-chapter o1-wrap">
        <RunningHead n="03" label="Private" />
        <Opener
          n="03"
          title={
            <>
              Your machines.
              <br />
              Your server.
              <br />
              <em>Your provider.</em>
            </>
          }
        >
          <p className="o1-lede">
            Omnyo runs on your own machines. Nothing is hosted by us in between.
          </p>
        </Opener>
        <div className="o1-ch3-cols" data-reveal>
          <p>
            Prompts, code and files go to the Omnyo server you run, then to the
            AI provider you choose. You do not need an Omnyo account to use it
            on your own machines.
          </p>
          <p>
            Remote access is optional. Omnyo Connect, with a free account, lets
            you follow and steer chats from another device when you want to.
          </p>
        </div>
        <Plate
          number="IV"
          title="Where your work goes"
          note="Data path"
          className="o1-plate--wide o1-plate--flow"
          caption="The full path of a prompt. Omnyo runs no server of its own between your machine and your provider."
        >
          <FlowDrawing />
        </Plate>
      </section>

      <section id="index" className="o1-chapter o1-wrap">
        <RunningHead n="04" label="Index" />
        <Opener
          n="04"
          title={
            <>
              What else <em>it does.</em>
            </>
          }
        >
          <p>
            Remote access, a dev server per branch, scheduled agents, a real
            browser for your agent and plugins.
          </p>
        </Opener>
        <ol className="o1-index">
          {INDEX.map((item) => {
            const content = (
              <>
                <span className="o1-index-n">{item.n}</span>
                <span className="o1-index-title">{item.title}</span>
                <span className="o1-index-body">{item.body}</span>
                <span className="o1-index-spec">
                  <span className="o1-fig">
                    <span className="o1-fig-n">Fig. {item.n}</span>
                    {item.specimen}
                  </span>
                </span>
                <span className="o1-index-go">
                  {item.href ? (
                    <>
                      Read the guide
                      <Arrow />
                    </>
                  ) : null}
                </span>
              </>
            );

            return (
              <li key={item.n} data-reveal>
                {item.href ? (
                  <a className="o1-index-row" href={item.href}>
                    {content}
                  </a>
                ) : (
                  <div className="o1-index-row">{content}</div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section id="switch" className="o1-chapter o1-wrap">
        <RunningHead n="05" label="Switch" />
        <div className="o1-ch5">
          <div className="o1-ch5-head" data-reveal>
            <div className="o1-bignum" aria-hidden="true">
              05
            </div>
            <h2 className="o1-h2">
              Coming from <em>somewhere else?</em>
            </h2>
            <p>
              Pick the tool you use now and read the guide for moving to Omnyo.
            </p>
          </div>
          <ul className="o1-switch">
            {SWITCH.map((item, index) => (
              <li key={item.slug} data-reveal>
                <a href={`/guides/${item.slug}`}>
                  <span className="o1-switch-n">5.{String(index + 1)}</span>
                  <span className="o1-switch-from">Switch from</span>
                  <span className="o1-switch-name">{item.name}</span>
                  <Arrow />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="download" className="o1-close">
        <div className="o1-wrap o1-close-inner">
          <div className="o1-close-head" data-reveal>
            <span>06</span>
            <span>Download</span>
            <span className="o1-runhead-fill" />
            <span>Omnyo for macOS</span>
          </div>
          <h2 className="o1-close-title" data-reveal>
            Bring your agents <em>together.</em>
          </h2>
          <div className="o1-close-row" data-reveal>
            <p>
              Download Omnyo for your Mac. It is free, open source and runs on
              your own machines.
            </p>
            <DownloadButton tone="paper" />
          </div>
          <dl className="o1-close-specs" data-reveal>
            <div>
              <dt>Price</dt>
              <dd>Free</dd>
            </div>
            <div>
              <dt>Code</dt>
              <dd>Open source</dd>
            </div>
            <div>
              <dt>Requires</dt>
              <dd>Apple Silicon, macOS 13 or later</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>None on your own machines</dd>
            </div>
          </dl>
        </div>
      </section>

      <footer className="o1-foot o1-wrap">
        <div className="o1-foot-grid">
          <div className="o1-foot-brand">
            <Mark className="o1-brand-mark" />
            <p>The unified interface for coding agents.</p>
          </div>
          <div>
            <h3>Guides</h3>
            <a href="/guides/orchestrate-coding-agents">Orchestrate agents</a>
            <a href="/guides/claude-code-and-codex-together">
              Claude Code and Codex
            </a>
            <a href="/guides/work-from-anywhere">Work from anywhere</a>
            <a href="/guides/remote-dev-servers">Dev servers</a>
          </div>
          <div>
            <h3>Legal</h3>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
            <a href="/imprint">Imprint</a>
          </div>
          <div>
            <h3>Colophon</h3>
            <p>
              Built on{" "}
              <a className="o1-inline" href={BB_URL}>
                bb
              </a>{" "}
              (MIT License)
            </p>
            <p>Set in Instrument Serif, Inter Tight and Geist Mono.</p>
            <p>© 2026 Omnyo</p>
          </div>
        </div>
        <div className="o1-foot-word" aria-hidden="true">
          Omnyo
        </div>
      </footer>
    </main>
  );
}
