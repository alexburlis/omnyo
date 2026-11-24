import "./styles.css";

import {
  type CSSProperties,
  type RefObject,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { DownloadPanel } from "../../landing/download";
import { AppMock, PhoneMock } from "../app-mock/app-mock";
import { pinnedStops, startGlide } from "../app-mock/glide";
import { PLATFORM_LINE, STORY_LINES, SWITCH_GUIDES } from "../open-5/content";
import { GetButton, KineticShell, Mark, Terminal, at } from "../open-5/page";
import { ACT_LABELS, BEATS, FACTS, WINDOWS, clockLabel } from "./content";

const order = (index: number) => ({ "--i": index }) as CSSProperties;

const railTime = (minute: number) =>
  minute >= 1440 ? clockLabel(minute) : clockLabel(minute).slice(4);

function Hero() {
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
              All your
            </span>
          </span>
          <span className="line">
            <span className="hero-in" style={order(2)}>
              coding agents.
            </span>
          </span>
          <span className="line">
            <span className="hero-in" style={order(3)}>
              One place<span className="accent-dot">.</span>
            </span>
          </span>
        </h1>
        <p className="hero-sub hero-in" style={order(4)}>
          Omnyo runs Claude Code and Codex side by side, on your own machines.
        </p>
        <div className="hero-actions hero-in" style={order(5)}>
          <GetButton />
          <a className="text-link" href="#story">
            See how it works
            <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="hero-meta hero-in" style={order(6)}>
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
          <span className="tag tag--a">claude · feat/csv-export</span>
          <span className="tag tag--b">codex · fix/date-parser</span>
          <span className="tag tag--c">preview · localhost:5174</span>
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
              Omnyo puts them
            </span>
            <span className="k" style={at(0.64, 0.07)}>
              in one window.
            </span>
          </h2>
          <p className="story-sub k" style={at(0.69, 0.07)}>
            Claude Code, Codex and every branch preview, side by side in one
            app. Here is how a Monday goes.
          </p>
        </div>
      </div>
    </section>
  );
}

function Product({
  active,
  clockRef,
}: {
  active: number;
  clockRef: RefObject<HTMLSpanElement | null>;
}) {
  const beat = BEATS[active] ?? BEATS[0];
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const section = sectionRef.current;

    if (!section) return;

    return startGlide(() =>
      pinnedStops(
        section,
        BEATS.length,
        (index) => (index + 0.5) / BEATS.length,
      ),
    );
  }, []);

  return (
    <section
      ref={sectionRef}
      className="kinetic-workspace"
      data-progress="local"
      data-scene="app"
      aria-label="A Monday in Omnyo"
    >
      <div className="pin kinetic-workspace-pin">
        <div className="kinetic-stars" aria-hidden="true" />
        <div className="kinetic-copy">
          <p className="kinetic-clock" aria-hidden="true">
            <span className="kinetic-clock-dot" />
            <span ref={clockRef}>{clockLabel(BEATS[0].minute)}</span>
          </p>
          <div className="kinetic-words">
            {BEATS.map((entry, index) => (
              <div
                key={entry.view}
                className={`kinetic-word ${index === active ? "is-current" : index < active ? "is-past" : ""}`}
              >
                <p className="kinetic-word-time">{clockLabel(entry.minute)}</p>
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
          <div className="kinetic-product-frame">
            <AppMock view={beat.view} />
          </div>
          <div
            className={`kinetic-phone ${beat.view === "anywhere" ? "is-in" : ""}`}
          >
            <PhoneMock />
          </div>
        </div>
        <ol className="kinetic-rail" aria-label="Monday in Omnyo">
          {BEATS.map((entry, index) => (
            <li
              key={entry.view}
              className={
                index === active
                  ? "is-current"
                  : index < active
                    ? "is-past"
                    : ""
              }
              aria-current={index === active ? "step" : undefined}
            >
              <span className="kinetic-rail-dot" />
              <span className="kinetic-rail-time">
                {railTime(entry.minute)}
              </span>
              <span className="kinetic-rail-label">{entry.label}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Yours() {
  return (
    <section className="yours" data-scene="yours">
      <div className="pin yours-pin">
        <p className="act-label">Yours</p>
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
        <div className="yours-foot">
          <p className="body yours-body k" style={at(0, 0.14)}>
            Prompts, code and files go to the Omnyo server you run, then to the
            AI provider you choose. We host nothing in between.
          </p>
          <ul className="yours-facts k" style={at(0.08, 0.14)}>
            {FACTS.map((fact) => (
              <li key={fact.title}>
                <strong>{fact.title}</strong>
                <span>{fact.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="cta" data-scene="cta" id="download">
      <div className="pin cta-pin">
        <div className="cta-mark" data-anchor="cta-mark" aria-hidden="true">
          <Mark className="static-mark" />
        </div>
        <div className="cta-copy">
          <h2 className="cta-title k" style={at(-0.3, 0.25)}>
            Close the other terminals.
          </h2>
          <p className="cta-sub k" style={at(-0.25, 0.25)}>
            Every agent, branch and preview in one window, on any device.
          </p>
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

export default function Page() {
  const [active, setActive] = useState(0);
  const last = useRef(0);
  const clockRef = useRef<HTMLSpanElement>(null);

  const update = useCallback((progress: number) => {
    const scaled = Math.min(Math.max(progress, 0), 1) * BEATS.length;
    const index = Math.min(BEATS.length - 1, Math.floor(scaled));
    const from = BEATS[index]?.minute ?? 0;
    const to = BEATS[index + 1]?.minute ?? from;
    const roll = Math.min(Math.max((scaled - index - 0.68) / 0.32, 0), 1);
    const eased = roll * roll * (3 - 2 * roll);
    const label = clockLabel(from + (to - from) * eased);
    const clock = clockRef.current;

    if (clock && clock.textContent !== label) clock.textContent = label;

    if (index === last.current) return;
    last.current = index;
    startTransition(() => setActive(index));
  }, []);

  return (
    <KineticShell
      className="lab-combined-kinetic"
      labels={ACT_LABELS}
      onProductProgress={update}
      productStage
    >
      <Hero />
      <Story />
      <Product active={active} clockRef={clockRef} />
      <Yours />
      <Cta />
    </KineticShell>
  );
}
