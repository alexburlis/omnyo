import "./comparison.css";

import { Fragment, type ReactNode } from "react";

import { FeatureClosing, FeatureShell } from "../features/feature-chrome";
import {
  FeatureFaq,
  FeatureRelated,
  FeatureSections,
  inline,
} from "../features/feature-page";
import { FeatureVisual } from "../features/visuals";
import { DownloadButton } from "../landing/download";
import type {
  ComparisonBody,
  ComparisonMeta,
  ComparisonTable,
} from "./comparison-types";
import { CITATION } from "./comparison-head";
import { comparisonPath } from "./comparisons";

const CITATION_RUN = /(?:\[\^\d+\])+/g;

const CHECKED = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export const checkedLabel = (isoDate: string) =>
  CHECKED.format(new Date(`${isoDate}T00:00:00Z`));

export function cite(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;

  for (const run of text.matchAll(CITATION_RUN)) {
    const start = run.index;

    if (start > last) {
      parts.push(
        <Fragment key={`text-${last}`}>
          {inline(text.slice(last, start))}
        </Fragment>,
      );
    }

    parts.push(
      <sup className="vs-cite" key={`cite-${start}`}>
        {[...run[0].matchAll(CITATION)].map((match, index) => (
          <Fragment key={match.index}>
            {index > 0 ? ", " : null}
            <a href={`#source-${match[1]}`} aria-label={`Source ${match[1]}`}>
              {match[1]}
            </a>
          </Fragment>
        ))}
      </sup>,
    );
    last = start + run[0].length;
  }

  if (last < text.length) {
    parts.push(
      <Fragment key={`text-${last}`}>{inline(text.slice(last))}</Fragment>,
    );
  }

  return parts;
}

function SideTable({
  meta,
  table,
}: {
  meta: ComparisonMeta;
  table: ComparisonTable;
}) {
  return (
    <table className="vs-table">
      <caption>{table.heading}</caption>
      <thead>
        <tr>
          <td />
          {[meta.left, meta.right].map((side) => (
            <th scope="col" key={side.name}>
              {side.name} <small>{side.maker}</small>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td data-side={meta.left.name}>
              <span>{cite(row.left)}</span>
            </td>
            <td data-side={meta.right.name}>
              <span>{cite(row.right)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ComparisonPage({
  meta,
  body,
}: {
  meta: ComparisonMeta;
  body: ComparisonBody;
}) {
  return (
    <FeatureShell path={comparisonPath(meta.slug)}>
      <article className="fx-article">
        <header className="fx-hero">
          <p className="fx-crumbs">
            <span>Compare</span>
            <span aria-hidden="true">/</span>
            <span>{meta.name}</span>
          </p>
          <h1>{body.headline}</h1>
          <p className="fx-lede">{cite(body.lede)}</p>
          <p className="vs-checked">
            Every fact about {meta.left.name} and {meta.right.name} was checked
            on{" "}
            <time dateTime={meta.checkedOn}>
              {checkedLabel(meta.checkedOn)}
            </time>{" "}
            and carries the number of its source.{" "}
            <a href="#sources">See the sources</a>
          </p>
          <div className="fx-hero-actions">
            <a className="fx-link" href="#side-by-side">
              Compare side by side <span aria-hidden="true">↓</span>
            </a>
            <a className="fx-link" href="#together">
              Run both in Omnyo <span aria-hidden="true">↓</span>
            </a>
          </div>
        </header>
        <ul className="fx-points">
          {body.points.map((point) => (
            <li key={point.title}>
              <h2>{point.title}</h2>
              <p>{cite(point.body)}</p>
            </li>
          ))}
        </ul>
        <section className="vs-tables" id="side-by-side">
          <header className="vs-head">
            <h2>{body.tablesHeading}</h2>
            <p>{cite(body.tablesLede)}</p>
          </header>
          {body.tables.map((table) => (
            <SideTable meta={meta} table={table} key={table.heading} />
          ))}
        </section>
        <div className="fx-sections">
          <FeatureSections sections={body.sections} render={cite} />
        </div>
        <section className="vs-picks">
          <h2>{body.picksHeading}</h2>
          <ul>
            {body.picks.map((pick, index) => (
              <li key={pick.heading}>
                <h3>{pick.heading}</h3>
                <ul>
                  {pick.items.map((item) => (
                    <li key={item}>{cite(item)}</li>
                  ))}
                </ul>
                {index === body.picks.length - 1 ? (
                  <a className="vs-pick-link" href="#together">
                    See how in Omnyo <span aria-hidden="true">↓</span>
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="vs-together" id="together">
          <header className="vs-head">
            <h2>{body.together.heading}</h2>
            <p>{cite(body.together.lede)}</p>
            <DownloadButton size="lg" />
          </header>
          <div className="fx-stage">
            <FeatureVisual id={body.together.visual} />
          </div>
          <div className="fx-sections">
            <FeatureSections sections={body.together.sections} render={cite} />
          </div>
        </section>
        <FeatureFaq faq={body.faq} render={cite} />
        <section className="vs-sources" id="sources">
          <h2>Sources</h2>
          <p>
            Each number above points to one of these pages, read on{" "}
            {checkedLabel(meta.checkedOn)}. Both tools change often, so open the
            page before you rely on a price or a limit.
          </p>
          <ol>
            {body.sources.map((source, index) => (
              <li id={`source-${index + 1}`} key={source.url}>
                <a href={source.url}>{source.label}</a>
              </li>
            ))}
          </ol>
        </section>
        <FeatureRelated
          features={body.relatedFeatures}
          guides={body.relatedGuides}
        />
      </article>
      <FeatureClosing />
    </FeatureShell>
  );
}
