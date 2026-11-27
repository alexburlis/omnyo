import "./feature-index.css";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { GetArrow } from "../landing/download";
import { FeatureClosing, FeatureShell } from "./feature-chrome";
import type { FeatureMeta } from "./feature-types";
import { featureGroups, featureMetas, getFeatureMeta } from "./features";
import { FeatureVisual } from "./visuals";

const HERO_SLUGS = ["usage-tracking", "inbox", "parallel-agents"] as const;

const DARK_CHAPTER = "from-anywhere";

const tileSpans = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    if (count % 3 === 1) return index === count - 1 ? 6 : 2;

    if (count % 3 === 2) return index >= count - 2 ? 3 : 2;

    return 2;
  });

const chapterNumber = (index: number) => String(index + 1).padStart(2, "0");

const cssVars = (vars: Record<string, string | number>) =>
  vars as CSSProperties;

function useIndexMotion(root: RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const element = root.current;

    if (!element) return;

    const chapters = [...element.querySelectorAll<HTMLElement>(".fx-chapter")];
    const progressBar = element.querySelector<HTMLElement>(".fx-rail-progress");
    const inBand = new Set<string>();

    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }

        setActive(
          chapters.find((chapter) => inBand.has(chapter.id))?.id ?? null,
        );
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );

    for (const chapter of chapters) spy.observe(chapter);

    let frame = 0;
    let start = 0;
    let distance = 1;

    const measure = () => {
      frame = 0;
      const progress = (window.scrollY - start) / distance;

      if (progressBar) {
        progressBar.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
      }
    };

    const updateBounds = () => {
      const first = chapters[0];
      const last = chapters.at(-1);

      if (!first || !last) return;

      start = first.offsetTop - window.innerHeight * 0.5;
      const end = last.offsetTop + last.offsetHeight - window.innerHeight;
      distance = Math.max(1, end - start);

      onScroll();
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    updateBounds();
    const resize = new ResizeObserver(updateBounds);
    resize.observe(element);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateBounds);

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let reveal: IntersectionObserver | null = null;

    if (!reduced) {
      const items = [
        ...element.querySelectorAll<HTMLElement>("[data-reveal-item]"),
      ];

      const observer = new IntersectionObserver(
        (entries) => {
          const arrived = entries
            .filter((entry) => entry.isIntersecting)
            .map((entry) => entry.target)
            .filter((target) => target instanceof HTMLElement)
            .sort((a, b) => items.indexOf(a) - items.indexOf(b));

          arrived.forEach((item, index) => {
            item.style.setProperty("--fx-delay", `${index * 70}ms`);
            item.dataset.in = "";
            observer.unobserve(item);
          });
        },
        { rootMargin: "0px 0px -8% 0px" },
      );

      element.dataset.reveal = "";

      for (const item of items) observer.observe(item);
      reveal = observer;
    }

    return () => {
      spy.disconnect();
      reveal?.disconnect();
      resize.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateBounds);

      if (frame) cancelAnimationFrame(frame);
      delete element.dataset.reveal;
    };
  }, [root]);

  useEffect(() => {
    const rail = root.current?.querySelector<HTMLElement>(".fx-rail-inner");
    const link = rail?.querySelector<HTMLElement>("a[aria-current]");

    if (!rail || !link) return;

    const left = link.offsetLeft - (rail.clientWidth - link.offsetWidth) / 2;

    rail.scrollTo({ left, behavior: "smooth" });
  }, [root, active]);

  return active;
}

function LeadFeature({ meta, flip }: { meta: FeatureMeta; flip: boolean }) {
  return (
    <a
      className={flip ? "fx-lead is-flipped" : "fx-lead"}
      href={`/features/${meta.slug}`}
      data-reveal-item
    >
      <span className="fx-lead-visual">
        <FeatureVisual id={meta.visual} />
      </span>
      <span className="fx-lead-copy">
        <span className="fx-lead-name">{meta.name}</span>
        <span className="fx-lead-tagline">{meta.tagline}</span>
        <span className="fx-lead-more">
          See how it works
          <GetArrow kind="next" />
        </span>
      </span>
    </a>
  );
}

function FeatureTile({ meta, row }: { meta: FeatureMeta; row: boolean }) {
  return (
    <a
      className={row ? "fx-tile is-row" : "fx-tile"}
      href={`/features/${meta.slug}`}
      data-reveal-item
    >
      <span className="fx-tile-visual">
        <FeatureVisual id={meta.visual} />
      </span>
      <span className="fx-tile-copy">
        <span className="fx-tile-name">
          {meta.name}
          <GetArrow kind="next" />
        </span>
        <span className="fx-tile-tagline">{meta.tagline}</span>
      </span>
    </a>
  );
}

function IndexHero({ total, chapters }: { total: number; chapters: number }) {
  const showcase = HERO_SLUGS.map((slug) => getFeatureMeta(slug)).filter(
    (meta) => meta !== undefined,
  );

  return (
    <header className="fx-ihero">
      <div className="fx-ihero-copy">
        <p className="fx-crumbs">
          <span>Features</span>
        </p>
        <h1>
          Everything Omnyo does, <em>in one window.</em>
        </h1>
        <p className="fx-lede">
          Omnyo runs Claude Code and Codex side by side on your own machines.
          Scroll through every part of the app, or open a feature for a closer
          look.
        </p>
        <dl className="fx-ihero-stats">
          <div>
            <dt>Features</dt>
            <dd>{total}</dd>
          </div>
          <div>
            <dt>Chapters</dt>
            <dd>{chapters}</dd>
          </div>
        </dl>
      </div>
      <div className="fx-ihero-stage" aria-hidden="true">
        {showcase.map((meta, index) => (
          <a
            className="fx-ihero-card"
            href={`/features/${meta.slug}`}
            style={cssVars({ "--fx-i": index })}
            tabIndex={-1}
            key={meta.slug}
          >
            <FeatureVisual id={meta.visual} />
          </a>
        ))}
      </div>
    </header>
  );
}

export function FeatureIndex() {
  const groups = featureGroups();
  const root = useRef<HTMLDivElement>(null);
  const active = useIndexMotion(root);

  return (
    <FeatureShell current="features" path="/features">
      <div className="fx-index" ref={root}>
        <IndexHero total={featureMetas().length} chapters={groups.length} />
        <nav className="fx-rail" aria-label="Feature chapters">
          <div className="fx-rail-inner">
            {groups.map((entry, index) => (
              <a
                href={`#${entry.id}`}
                key={entry.id}
                aria-current={active === entry.id ? "true" : undefined}
              >
                <span className="fx-rail-num">{chapterNumber(index)}</span>
                {entry.group}
              </a>
            ))}
          </div>
          <span className="fx-rail-progress" aria-hidden="true" />
        </nav>
        {groups.map((entry, index) => {
          const [lead, ...rest] = entry.features;
          const spans = tileSpans(rest.length);

          return (
            <section
              className="fx-chapter"
              data-tone={entry.id === DARK_CHAPTER ? "dark" : undefined}
              id={entry.id}
              aria-labelledby={`${entry.id}-title`}
              key={entry.id}
            >
              <div className="fx-chapter-inner">
                <header className="fx-chapter-head" data-reveal-item>
                  <span className="fx-chapter-num" aria-hidden="true">
                    {chapterNumber(index)}
                  </span>
                  <div className="fx-chapter-title">
                    <h2 id={`${entry.id}-title`}>{entry.group}</h2>
                    <p>{entry.note}</p>
                  </div>
                  <span className="fx-chapter-count">
                    {entry.features.length} features
                  </span>
                </header>
                {lead ? (
                  <LeadFeature meta={lead} flip={index % 2 === 1} />
                ) : null}
                {rest.length > 0 ? (
                  <ul className="fx-bento">
                    {rest.map((feature, position) => {
                      const span = spans[position] ?? 2;

                      return (
                        <li
                          className={span === 6 ? "is-row" : undefined}
                          key={feature.slug}
                          style={cssVars({ "--fx-span": span })}
                        >
                          <FeatureTile meta={feature} row={span === 6} />
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      <FeatureClosing />
    </FeatureShell>
  );
}
