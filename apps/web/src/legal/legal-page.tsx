import type { ReactNode } from "react";

import { SiteFooter, SiteNav } from "../landing/site-chrome";
import type { StorageGroup } from "./website-storage";

export interface LegalSection {
  id: string;
  title: string;
}

export function LegalPage({
  path,
  title,
  updated,
  updatedIso,
  lede,
  children,
}: {
  path: string;
  title: string;
  updated: string;
  updatedIso: string;
  lede: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <SiteNav path={path} />
      <div className="wrap">
        <article className="post article legal-doc">
          <div className="post-body">
            <time className="date-pill" dateTime={updatedIso}>
              Last updated {updated}
            </time>
            <h1>{title}</h1>
            <p className="lede">{lede}</p>
            {children}
          </div>
        </article>
      </div>
      <SiteFooter current={path} />
    </>
  );
}

export function LegalSummary({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="legal-summary" aria-labelledby="in-short">
      <h2 id="in-short">In short</h2>
      <ul>{children}</ul>
      {footer === undefined ? null : (
        <div className="legal-summary-footer">{footer}</div>
      )}
    </section>
  );
}

export function CookieSettingsButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      className="legal-settings-button"
      data-cookie-settings
    >
      {children}
    </button>
  );
}

export function LegalContents({
  sections,
}: {
  sections: readonly LegalSection[];
}) {
  return (
    <nav className="legal-toc" aria-labelledby="on-this-page">
      <p className="legal-toc-title" id="on-this-page">
        On this page
      </p>
      <ol>
        {sections.map((section) => (
          <li key={section.id}>
            <a href={`#${section.id}`}>{section.title}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function LegalHeading({ section }: { section: LegalSection }) {
  return <h2 id={section.id}>{section.title}</h2>;
}

export function CookieSettingsLink({
  children = "Cookie settings",
}: {
  children?: ReactNode;
}) {
  return (
    <button type="button" className="legal-inline-button" data-cookie-settings>
      {children}
    </button>
  );
}

export function StorageGroupList({ group }: { group: StorageGroup }) {
  const headingId = `storage-${group.id}`;

  return (
    <section className="legal-storage" aria-labelledby={headingId}>
      <h3 id={headingId}>{group.title}</h3>
      <p>{group.when}</p>
      {group.note === undefined ? null : (
        <p className="legal-storage-note">{group.note}</p>
      )}
      <ul className="legal-storage-list">
        {group.items.map((item) => (
          <li
            key={`${item.kind}:${item.names.join()}`}
            className="legal-storage-item"
          >
            <div className="legal-storage-head">
              <span className="legal-storage-names">
                {item.names.map((name) => (
                  <code key={name} className="legal-storage-name">
                    {name}
                  </code>
                ))}
              </span>
              <span className="legal-storage-kind">{item.kind}</span>
            </div>
            <p className="legal-storage-purpose">{item.purpose}</p>
            <dl className="legal-storage-meta">
              <div>
                <dt>Set by</dt>
                <dd>{item.provider}</dd>
              </div>
              <div>
                <dt>Site</dt>
                <dd>{item.site}</dd>
              </div>
              <div>
                <dt>Lasts</dt>
                <dd>{item.duration}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <p className="legal-storage-basis">
        <strong>Legal basis:</strong> {group.basis}
      </p>
    </section>
  );
}
