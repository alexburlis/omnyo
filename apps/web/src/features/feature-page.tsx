import GithubIcon from "@hugeicons/core-free-icons/GithubIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

import { DownloadButton, GetArrow } from "../landing/download";
import { GITHUB_URL } from "../landing/site";
import { FeatureClosing, FeatureShell } from "./feature-chrome";
import { FeatureFrame, FeatureThumb } from "./feature-frame";
import { INLINE } from "./feature-head";
import type {
  FeatureFact,
  FeatureGuideLink,
  FeatureMeta,
  FeaturePageBody,
  FeatureQuestion,
  FeatureSection,
  FeatureShowcase,
} from "./feature-types";
import { getFeatureMeta } from "./features";
import { FeatureVisual } from "./visuals";

export function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const start = match.index;

    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      match[3] === undefined ? (
        <a href={match[2]} key={`${start}-${match[2]}`}>
          {match[1]}
        </a>
      ) : (
        <code key={`${start}-code`}>{match[3]}</code>
      ),
    );
    last = start + match[0].length;
  }

  if (last < text.length) parts.push(text.slice(last));

  return parts;
}

type Render = (text: string) => ReactNode;

export function FeatureCard({ meta }: { meta: FeatureMeta }) {
  return (
    <a className="fx-card" href={`/features/${meta.slug}`}>
      <FeatureThumb id={meta.visual} />
      <span className="fx-card-text">
        <span className="fx-card-name">
          {meta.name}
          <GetArrow kind="next" />
        </span>
        <span className="fx-card-tagline">{meta.tagline}</span>
      </span>
    </a>
  );
}

export function FeatureSections({
  sections,
  render = inline,
}: {
  sections: readonly FeatureSection[];
  render?: Render;
}) {
  return sections.map((section) => (
    <section
      className={`fx-section ${section.visual ? "has-visual" : ""}`}
      key={section.heading}
    >
      <div className="fx-section-copy">
        <h2>{section.heading}</h2>
        {section.paragraphs.map((paragraph) => (
          <p key={paragraph}>{render(paragraph)}</p>
        ))}
        {section.bullets.length > 0 ? (
          <ul>
            {section.bullets.map((bullet) => (
              <li key={bullet}>{render(bullet)}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {section.visual ? (
        <div className="fx-section-visual">
          <FeatureVisual id={section.visual} />
        </div>
      ) : null}
    </section>
  ));
}

function FeatureShowcases({
  sections,
}: {
  sections: readonly FeatureShowcase[];
}) {
  return (
    <div className="fx-shows">
      {sections.map((section, index) => (
        <section className="fx-show" key={section.heading}>
          <div className="fx-show-copy">
            <p className="fx-show-step" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </p>
            <h2>{section.heading}</h2>
            <p>{inline(section.body)}</p>
            {section.bullets.length > 0 ? (
              <ul>
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{inline(bullet)}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <FeatureFrame id={section.visual} />
        </section>
      ))}
    </div>
  );
}

function FeatureFacts({ facts }: { facts: readonly FeatureFact[] }) {
  return (
    <section className="fx-facts">
      <h2>Good to know</h2>
      <dl>
        {facts.map((fact) => (
          <div key={`${fact.label}-${fact.value}`}>
            <dt>{fact.label}</dt>
            <dd>{inline(fact.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function FeatureFaq({
  faq,
  render = inline,
}: {
  faq: readonly FeatureQuestion[];
  render?: Render;
}) {
  return (
    <section className="fx-faq">
      <h2>Questions</h2>
      {faq.map((entry) => (
        <details key={entry.question}>
          <summary>{entry.question}</summary>
          <p>{render(entry.answer)}</p>
        </details>
      ))}
    </section>
  );
}

export function FeatureRelated({
  features,
  guides,
}: {
  features: readonly string[];
  guides: readonly FeatureGuideLink[];
}) {
  const related = features
    .map((slug) => getFeatureMeta(slug))
    .filter((entry) => entry !== undefined);

  if (related.length === 0 && guides.length === 0) return null;

  return (
    <section className="fx-related">
      <h2>Related</h2>
      {related.length > 0 ? (
        <div className="fx-cards">
          {related.map((entry) => (
            <FeatureCard meta={entry} key={entry.slug} />
          ))}
        </div>
      ) : null}
      {guides.length > 0 ? (
        <p className="fx-guides">
          <span>Guides</span>
          {guides.map((guide) => (
            <a href={`/guides/${guide.slug}`} key={guide.slug}>
              {guide.label}
            </a>
          ))}
        </p>
      ) : null}
    </section>
  );
}

function GitHubLink() {
  return (
    <a className="fx-gh" href={GITHUB_URL}>
      <HugeiconsIcon icon={GithubIcon} aria-hidden />
      <span>Releases</span>
    </a>
  );
}

export function FeaturePage({
  meta,
  body,
}: {
  meta: FeatureMeta;
  body: FeaturePageBody;
}) {
  return (
    <FeatureShell current="features" path={`/features/${meta.slug}`}>
      <article className="fx-page">
        <header className="fx-top">
          <div className="fx-top-copy">
            <p className="fx-crumbs">
              <a href="/features">Features</a>
              <span aria-hidden="true">/</span>
              <span>{meta.name}</span>
            </p>
            <h1>{body.headline}</h1>
            <p className="fx-lede">{inline(body.lede)}</p>
            <div className="fx-top-actions">
              <DownloadButton size="lg" />
              <GitHubLink />
            </div>
          </div>
          <FeatureFrame id={meta.visual} className="fx-top-frame" interactive />
        </header>
        <FeatureShowcases sections={body.sections} />
        <div
          className={`fx-details ${body.goodToKnow.length > 0 ? "" : "is-single"}`}
        >
          {body.goodToKnow.length > 0 ? (
            <FeatureFacts facts={body.goodToKnow} />
          ) : null}
          <FeatureFaq faq={body.faq} />
        </div>
        <FeatureRelated
          features={body.relatedFeatures}
          guides={body.relatedGuides}
        />
      </article>
      <FeatureClosing />
    </FeatureShell>
  );
}
