import { Fragment } from "react";

import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { explorePath, type ExploreItem, type ExploreLink } from "./catalog";
import {
  CopyStatus,
  RelatedLinks,
  canonicalItemUrl,
  itemByline,
  useCopyStatus,
} from "./ExploreParts";
import type { PromptSample } from "./prompts.server";

const PLACEHOLDER = /(\{\{[^{}\n]+\}\})/gu;

export function promptSegments(body: string) {
  return body
    .split(PLACEHOLDER)
    .map((text) => ({ text, placeholder: /^\{\{[^{}\n]+\}\}$/u.test(text) }))
    .filter(({ text }) => text.length > 0);
}

export function ExplorePromptPage({
  item,
  prompt,
  related,
}: {
  item: ExploreItem;
  prompt: { body: string; usage: string; sample: PromptSample };
  related: readonly ExploreLink[];
}) {
  const { status, copy } = useCopyStatus();
  const canonicalUrl = canonicalItemUrl(item);

  const placeholders = [
    ...new Set(
      promptSegments(prompt.body)
        .filter(({ placeholder }) => placeholder)
        .map(({ text }) => text),
    ),
  ];

  const textPath = item.cta.kind === "copy-prompt" ? item.cta.textPath : null;

  return (
    <>
      <SiteNav current="explore" path={item.path} />
      <div className="wrap ex-page">
        <main id="main-content">
          <a className="ex-back" href={explorePath}>
            ← Explore
          </a>
          <header className="ex-detail-header">
            <p className="ex-eyebrow">{itemByline(item)}</p>
            <h1>{item.title}</h1>
            <p className="ex-lead">{item.summary}</p>
            <div className="ex-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={() =>
                  copy({
                    text: prompt.body,
                    copied:
                      "Prompt copied. Replace the highlighted placeholders after you paste it.",
                    failed:
                      "Copying is blocked here. Select the prompt below and copy it.",
                  })
                }
              >
                Copy prompt
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() =>
                  copy({
                    text: canonicalUrl,
                    copied: "Link copied.",
                    failed: "Copy this address to share the prompt.",
                    fallbackUrl: canonicalUrl,
                  })
                }
              >
                Copy link
              </button>
            </div>
            <CopyStatus status={status} />
            <p className="ex-small">{prompt.usage}</p>
          </header>
          <section className="ex-section" aria-labelledby="ex-prompt-heading">
            <div className="ex-section-heading">
              <h2 id="ex-prompt-heading">The prompt</h2>
              {textPath ? <a href={textPath}>Plain text</a> : null}
            </div>
            <pre className="ex-prompt">
              <code>
                {promptSegments(prompt.body).map((segment, index) =>
                  segment.placeholder ? (
                    <mark key={index}>{segment.text}</mark>
                  ) : (
                    <Fragment key={index}>{segment.text}</Fragment>
                  ),
                )}
              </code>
            </pre>
            {placeholders.length ? (
              <div className="ex-placeholders">
                <h3>Fill in after you paste</h3>
                <ul>
                  {placeholders.map((placeholder) => (
                    <li key={placeholder}>
                      <mark>{placeholder}</mark>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
          <section
            className="ex-section ex-sample"
            aria-labelledby="ex-sample-heading"
          >
            <h2 id="ex-sample-heading">Example</h2>
            <p className="ex-small">{prompt.sample.label}</p>
            <dl>
              {prompt.sample.input.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="ex-sample-result">
              <h3>Findings</h3>
              <ul>
                {prompt.sample.findings.map((finding) => (
                  <li key={finding}>{finding}</li>
                ))}
              </ul>
              <h3>Revised update</h3>
              <p>{prompt.sample.revision}</p>
            </div>
          </section>
          <RelatedLinks links={related} />
        </main>
      </div>
      <SiteFooter current={item.path} />
    </>
  );
}
