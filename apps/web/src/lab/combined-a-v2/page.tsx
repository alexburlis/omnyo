import "../combined-a/styles.css";
import "./styles.css";

import {
  type CSSProperties,
  type ReactNode,
  startTransition,
  useEffect,
  useRef,
  useState,
} from "react";

import { DownloadButton, DownloadPanel } from "../../landing/download";
import { GitHubButton } from "../../landing/github";
import { REPO_URL, type PublicMacDownload } from "../../landing/site";
import { SiteNav } from "../../landing/site-chrome";
import { AppMock, PhoneMock } from "../app-mock/app-mock";
import { PLATFORM_LINE } from "../open-5/content";
import { KineticShell, Mark, Terminal, at } from "../open-5/page";
import { type BeatStepper, startBeatStepper } from "./beat-stepper";
import { BEATS, STORY_LINES, WINDOWS } from "./content";
import { Devices } from "./devices";
import { Bento, Questions, Speed } from "./sections";
import { Switch } from "./switch";
import { Yours } from "./yours";

const order = (index: number) => ({ "--i": index }) as CSSProperties;

const step = (index: number) => String(index + 1).padStart(2, "0");

const stateOf = (index: number, active: number) =>
  index === active ? "is-current" : index < active ? "is-past" : "";

type LandingPageProps = { macDownload?: PublicMacDownload | null };

function Hero({ macDownload }: LandingPageProps) {
  return (
    <section className="hero" data-progress="local" data-scene="hero" id="top">
      <div className="hero-copy">
        <p className="eyebrow hero-in" style={order(0)}>
          <span className="eyebrow-dot" />
          Free to use
        </p>
        <h1 className="hero-title">
          <span className="line">
            <span className="hero-in" style={order(1)}>
              More agents.
            </span>
          </span>
          <span className="line">
            <span className="hero-in" style={order(2)}>
              Less juggling<span className="accent-dot">.</span>
            </span>
          </span>
        </h1>
        <p className="hero-sub hero-in" style={order(3)}>
          Omnyo is a free app for running Claude Code and Codex side by side, on
          your own subscriptions. See which agent needs you, check its work and
          keep it moving from anywhere.
        </p>
        <div className="hero-actions hero-in" style={order(4)}>
          <DownloadButton macDownload={macDownload} />
          <GitHubButton href={REPO_URL} label="Star on GitHub" short="GitHub" />
        </div>
        <p className="hero-meta hero-in" style={order(5)}>
          {macDownload && (
            <span className="hero-download-version">
              Version {macDownload.version} for macOS
            </span>
          )}
          <span>{PLATFORM_LINE}</span>
        </p>
      </div>
      <div className="hero-stage" aria-hidden="true">
        <div className="hero-mark" data-anchor="hero-mark">
          <svg className="hero-orbit" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="49.6" />
            <circle cx="50" cy="50" r="38" className="hero-orbit-faint" />
          </svg>
          <Mark className="static-mark" />
          <span className="tag tag--a">codex · reviewing</span>
          <span className="tag tag--b">preview · localhost:5174</span>
          <span className="tag tag--c">claude · needs you</span>
        </div>
      </div>
      <div className="hero-scroll" aria-hidden="true">
        <span>Scroll</span>
        <span className="hero-scroll-line" />
      </div>
    </section>
  );
}

function Word({ index, children }: { index: number; children: ReactNode }) {
  return (
    <span className="story-word">
      <span style={order(index)}>{children}</span>
    </span>
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
      <span
        className="veil-disc veil-disc--hero"
        data-disc="hero"
        aria-hidden="true"
      />
      <div className="veil-pin" aria-hidden="true">
        <span className="veil-disc veil-disc--story" data-disc="story" />
      </div>
      <div className="pin story-pin">
        <p className="act-label story-label story-label--a">Before Omnyo</p>
        <p className="act-label story-label story-label--b">With Omnyo</p>
        <div className="win-layer" data-win-layer aria-hidden="true">
          {WINDOWS.map((entry, index) => (
            <Terminal entry={entry} index={index} key={entry.title} />
          ))}
        </div>
        <h2 className="story-lines">
          {STORY_LINES.map((line) => (
            <span className="story-line" data-line key={line}>
              <span>{line}</span>
            </span>
          ))}
        </h2>
        <div className="story-mark" data-anchor="story-mark" aria-hidden="true">
          <svg className="story-orbit" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="49.6" />
            <circle cx="50" cy="50" r="38" className="story-orbit-faint" />
          </svg>
          <Mark className="static-mark" />
        </div>
        <div className="story-gathered">
          <h2 className="story-title">
            <span className="story-title-line">
              <Word index={0}>One</Word> <Word index={1}>window.</Word>
            </span>
            <span className="story-title-line">
              <Word index={3}>Every</Word> <Word index={4}>agent</Word>{" "}
              <Word index={5}>in</Word>{" "}
              <Word index={6}>
                sight<span className="story-dot">.</span>
              </Word>
            </span>
          </h2>
          <p className="story-sub">
            Claude Code, Codex and every branch preview, side by side in one
            app. Here is what that fixes.
          </p>
        </div>
      </div>
    </section>
  );
}

function Product() {
  const [active, setActive] = useState(0);
  const beat = BEATS[active] ?? BEATS[0];
  const sectionRef = useRef<HTMLElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const stepperRef = useRef<BeatStepper | null>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const pin = pinRef.current;

    if (!section || !pin) return;

    const stepper = startBeatStepper({
      section,
      pin,
      count: BEATS.length,
      onBeat: (index) => startTransition(() => setActive(index)),
    });

    stepperRef.current = stepper;

    return () => {
      stepper.stop();
      stepperRef.current = null;
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="kinetic-workspace"
      data-progress="local"
      data-scene="app"
      aria-label="What Omnyo fixes"
    >
      <span
        className="veil-disc veil-disc--app"
        data-disc="app"
        aria-hidden="true"
      />
      <div ref={pinRef} className="pin kinetic-workspace-pin">
        <div className="kinetic-stars" aria-hidden="true" />
        <div className="kinetic-copy">
          <div className="kinetic-words">
            {BEATS.map((entry, index) => (
              <div
                key={entry.view}
                className={`kinetic-word ${stateOf(index, active)}`}
              >
                <p className="kinetic-problem">
                  <span className="kinetic-problem-index" aria-hidden="true">
                    {step(index)}
                  </span>
                  <span className="kinetic-problem-text">
                    <span className="kinetic-sr">Problem: </span>
                    <span className="kinetic-problem-strike">
                      {entry.problem}
                    </span>
                  </span>
                </p>
                <h2>
                  <span>{entry.title}</span>
                </h2>
                <p className="kinetic-word-detail">{entry.detail}</p>
              </div>
            ))}
          </div>
        </div>
        <div className={`kinetic-product is-${beat.view}`}>
          <div className="kinetic-product-light" aria-hidden="true" />
          <div className="kinetic-product-frame" data-anchor="product-frame">
            <AppMock view={beat.view} />
          </div>
          <div
            className={`kinetic-phone ${beat.view === "anywhere" ? "is-in" : ""}`}
          >
            <PhoneMock />
          </div>
        </div>
        <ol
          className="kinetic-rail"
          aria-label="What Omnyo fixes"
          style={{ "--beat": active } as CSSProperties}
        >
          {BEATS.map((entry, index) => (
            <li key={entry.view} className={stateOf(index, active)}>
              <button
                type="button"
                className="kinetic-rail-button"
                aria-current={index === active ? "step" : undefined}
                aria-label={`${step(index)} ${entry.label}`}
                onClick={() => stepperRef.current?.goTo(index)}
              >
                <span className="kinetic-rail-dot" aria-hidden="true" />
                <span className="kinetic-rail-time">{step(index)}</span>
                <span className="kinetic-rail-label">{entry.label}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Cta({ macDownload }: LandingPageProps) {
  return (
    <section className="cta" data-scene="cta" id="download">
      <div className="pin cta-pin">
        <div className="cta-mark" data-anchor="cta-mark" aria-hidden="true">
          <Mark className="static-mark" />
        </div>
        <div className="cta-copy">
          <h2 className="cta-title k" style={at(-0.3, 0.25)}>
            Free. Open Source.
          </h2>
          <p className="cta-sub k" style={at(-0.25, 0.25)}>
            Every agent, branch and preview in one window, on any device.
          </p>
          <div className="cta-actions k" style={at(-0.2, 0.25)}>
            <DownloadPanel macDownload={macDownload} />
          </div>
          <div className="cta-source k" style={at(-0.15, 0.25)}>
            <GitHubButton label="View releases on GitHub" />
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Page({ macDownload }: LandingPageProps) {
  return (
    <KineticShell
      className="lab-combined-kinetic lab-combined-a-v2"
      header={<SiteNav path="/" macDownload={macDownload} />}
      productStage
      productMorph
      themed
    >
      <Hero macDownload={macDownload} />
      <Story />
      <Product />
      <Bento />
      <Speed />
      <Devices />
      <Yours />
      <Switch />
      <Questions />
      <Cta macDownload={macDownload} />
    </KineticShell>
  );
}
