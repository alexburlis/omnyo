import "./sections.css";

import { useEffect, useRef, type CSSProperties } from "react";

import { featureMetas } from "../../features/features";
import { meta as terminal } from "../../features/pages/terminal.meta";
import { FeatureVisual } from "../../features/visuals";
import { Demo as TerminalDemo } from "../../features/visuals/terminal.visual";
import { BENTO_ORDER, QUESTIONS, SPEED, SPEED_NOTE } from "./content";

const TILE_STAGGER_MS = 40;

const TILE_STAGGER_CAP = 5;

function useTileEntrance() {
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = grid.current;

    if (!element) return;

    const tiles = [...element.querySelectorAll<HTMLElement>(".tile")];

    const observer = new IntersectionObserver(
      (entries) => {
        const arrived = entries
          .filter(
            (entry) => entry.isIntersecting || entry.boundingClientRect.top < 0,
          )
          .map((entry) => entry.target)
          .filter((target) => target instanceof HTMLElement)
          .sort((a, b) => tiles.indexOf(a) - tiles.indexOf(b));

        arrived.forEach((tile, index) => {
          const delay = Math.min(index, TILE_STAGGER_CAP) * TILE_STAGGER_MS;
          tile.style.setProperty("--tile-delay", `${delay}ms`);
          tile.dataset.in = "";
          observer.unobserve(tile);
        });
      },
      { rootMargin: "0px 0px -6% 0px" },
    );

    for (const tile of tiles) observer.observe(tile);

    return () => observer.disconnect();
  }, []);

  return grid;
}

function Bento() {
  const metas = featureMetas();
  const grid = useTileEntrance();

  const tiles = BENTO_ORDER.map((slug) =>
    metas.find((meta) => meta.slug === slug),
  ).filter((meta) => meta !== undefined);

  return (
    <section
      className="band bento"
      data-flow
      data-progress="local"
      data-wipe="base"
      data-act="Everything else"
      id="features"
    >
      <header className="band-head">
        <p className="act-label">Also built in</p>
        <h2 className="h2">The rest of the work around your agents.</h2>
        <p className="body">
          Usage, automation, a browser, voice, GitHub and more, in the same
          window. Each one has its own page.
        </p>
      </header>
      <div ref={grid} className="bento-grid">
        <article className="terminal-spotlight">
          <div className="terminal-spotlight-copy">
            <p className="act-label">{terminal.name}</p>
            <h3>Run commands without leaving chat.</h3>
            <p>
              Type <code>!</code> before a command to run it in the chat’s
              workspace. Your conversation stays in view.
            </p>
            <a href={`/features/${terminal.slug}`}>
              Explore the terminal <span aria-hidden="true">→</span>
            </a>
          </div>
          <TerminalDemo />
        </article>
        {tiles.map((meta) => (
          <a
            className={`tile tile--${meta.tile ?? "regular"}`}
            href={`/features/${meta.slug}`}
            key={meta.slug}
          >
            <span className="tile-visual">
              <FeatureVisual id={meta.visual} />
            </span>
            <span className="tile-name">
              {meta.name}
              <span className="tile-arrow" aria-hidden="true">
                →
              </span>
            </span>
            <span className="tile-tagline">{meta.tagline}</span>
          </a>
        ))}
        <a className="tile tile--all" href="/features">
          <span className="tile-all-count">{metas.length}</span>
          <span className="tile-name">
            All features
            <span className="tile-arrow" aria-hidden="true">
              →
            </span>
          </span>
          <span className="tile-tagline">
            Inbox, remote control, chat import, dev servers and every other part
            of Omnyo, each on its own page.
          </span>
        </a>
      </div>
    </section>
  );
}

function Speed() {
  return (
    <section
      className="band speed"
      data-flow
      data-progress="local"
      data-act="Measured"
    >
      <header className="band-head">
        <p className="act-label">Measured</p>
        <h2 className="h2">It&apos;s fast. Very fast.</h2>
        <p className="body">
          We timed what you do all day. Archive, shelve and undo land in the
          same frame, so there is nothing to time.
        </p>
      </header>
      <ul className="speed-grid">
        {SPEED.map((entry, index) => (
          <li key={entry.caption} style={{ "--i": index } as CSSProperties}>
            <p className="speed-num">
              {entry.prefix ? (
                <span className="speed-prefix">{entry.prefix}</span>
              ) : null}
              {entry.value}
              <span className="speed-unit">{entry.unit}</span>
            </p>
            <p className="speed-cap">{entry.caption}</p>
          </li>
        ))}
      </ul>
      <p className="speed-note">
        {SPEED_NOTE} <a href="/features/performance">How we measured</a>
      </p>
    </section>
  );
}

function Questions() {
  return (
    <section
      className="band questions"
      data-flow
      data-progress="local"
      data-act="Questions"
    >
      <header className="band-head">
        <p className="act-label">Questions</p>
        <h2 className="h2">Before you download.</h2>
      </header>
      <div className="questions-list">
        {QUESTIONS.map((entry) => (
          <details key={entry.question}>
            <summary>{entry.question}</summary>
            <p>{entry.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export { Bento, Questions, Speed };
