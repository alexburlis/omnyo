import { useEffect, type ReactNode } from "react";
import { sendSiteUsage } from "../analytics/usage";

import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { MACOS_DOWNLOAD_URL } from "../landing/site";
import { explorePath, exploreSkillPath } from "./catalog";
import {
  marketplaceHref,
  type MarketplaceConnector,
  type MarketplaceItem,
} from "./marketplace";
import type { MarketplaceDetail } from "./marketplace-detail.server";
import {
  installSteps,
  marketplaceItemKey,
  marketplaceSingular,
  revisionLabel,
} from "./marketplace-view";
import { ConnectorIcon, ListingBadge, ListingIcon } from "./MarketplaceParts";
import { MarketplaceBand } from "./MarketplaceStorefront";
import { publicSkillLicensePath, type PublicSkill } from "./public-skills";

export const OPEN_IN_OMNYO_REQUIREMENT =
  "Opens the skill review in Omnyo for Mac. Needs the next Omnyo for Mac update.";

const typeHref = {
  skill: marketplaceHref({ type: "skill" }),
  workflow: marketplaceHref({ type: "workflow" }),
  connector: marketplaceHref({ type: "connector" }),
};

function Crumbs({ item }: { item: MarketplaceItem }) {
  return (
    <nav className="mk-crumbs" aria-label="Breadcrumb">
      <a href={explorePath}>Marketplace</a>
      <span aria-hidden="true">/</span>
      <a href={typeHref[item.kind]}>{marketplaceSingular[item.kind]}s</a>
      <span aria-hidden="true">/</span>
      <a href={marketplaceHref({ category: item.category })}>{item.category}</a>
    </nav>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="mk-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function InstallSection({
  item,
  id,
  note,
}: {
  item: MarketplaceItem;
  id: string;
  note?: string;
}) {
  return (
    <section className="mk-section" id={id} aria-labelledby={`${id}-title`}>
      <header className="mk-section-head">
        <span className="mk-kicker">Install</span>
        <h2 id={`${id}-title`}>
          {item.kind === "connector"
            ? `Connect ${item.title} in Omnyo`
            : "Three steps, with a review first"}
        </h2>
        {note ? <p>{note}</p> : null}
      </header>
      <ol className="mk-steps-row">
        {installSteps(item).map((step, index) => (
          <li key={step}>
            <i>{String(index + 1).padStart(2, "0")}</i>
            {step}
          </li>
        ))}
      </ol>
      <p className="mk-cli mk-cli-wide">
        omnyo explore marketplace --query "{item.title.toLowerCase()}"
      </p>
    </section>
  );
}

function Related({
  item,
  related,
}: {
  item: MarketplaceItem;
  related: MarketplaceItem[];
}) {
  if (!related.length) return null;

  return (
    <section className="mk-section" aria-labelledby="mk-related">
      <header className="mk-section-head mk-section-row">
        <div>
          <span className="mk-kicker">Related</span>
          <h2 id="mk-related">More in {item.category}</h2>
        </div>
        <a
          className="btn btn-sm"
          href={marketplaceHref({ category: item.category })}
        >
          See all
        </a>
      </header>
      <ul className="mk-related">
        {related.map((entry) => (
          <li key={marketplaceItemKey(entry)}>
            <a href={entry.detailPath}>
              <ListingIcon item={entry} />
              <span className="mk-related-main">
                <span className="mk-row-title">
                  <span>{entry.title}</span>
                  <ListingBadge item={entry} />
                </span>
                <small>
                  {entry.summary ??
                    (entry.kind === "skill"
                      ? `${entry.publisher} · ${entry.license}`
                      : entry.publisher)}
                </small>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SkillHero({ skill }: { skill: PublicSkill & { kind: "skill" } }) {
  const owned = skill.source === "omnyo";
  const source = owned ? new URL(skill.sourceUrl).pathname : skill.sourceUrl;

  const packPath =
    skill.packSlug === undefined ? undefined : exploreSkillPath(skill.packSlug);

  return (
    <header className="mk-detail-hero">
      <div className="mk-detail-main">
        <span className="mk-tile-kind">
          <ListingIcon item={skill} />
          {owned ? "Omnyo edition" : "Source-linked skill"}
        </span>
        <h1>{skill.title}</h1>
        <p className="mk-detail-lead">
          {skill.summary ??
            `A skill from ${skill.publisher}, screened by Omnyo at a pinned revision. Its own SKILL.md describes what it does.`}
        </p>
        <div className="mk-detail-cta">
          <a
            className="btn mk-btn-brand mk-btn-lg"
            href={
              packPath ??
              skill.setupUrl ??
              `omnyo://skills/source/${skill.slug}/${skill.sha256}`
            }
            onClick={() =>
              sendSiteUsage({ name: "install_intent", kind: "skill" })
            }
          >
            {packPath
              ? "Get the skill pack"
              : skill.setupUrl === undefined
                ? "Install in Omnyo"
                : "Setup instructions"}
          </a>
          {owned ? (
            <a className="btn mk-btn-lg" href={source} download="SKILL.md">
              {packPath ? "Download coordinator" : "Download SKILL.md"}
            </a>
          ) : (
            <a className="btn mk-btn-lg" href={source} rel="noreferrer">
              View source on GitHub
            </a>
          )}
        </div>
        <p className="mk-detail-note">
          {packPath
            ? "The pack includes the coordinator and all five testers."
            : skill.setupUrl === undefined
              ? OPEN_IN_OMNYO_REQUIREMENT
              : "Install the full pstack plugin to get its playbooks, skills, and agents."}
        </p>
      </div>
      <aside className="mk-facts-card" aria-label="Listing facts">
        <p className="mk-proof">
          <span aria-hidden="true">●</span>
          {owned ? "Written and tested by Omnyo" : "Source screened by Omnyo"}
        </p>
        <Facts
          rows={[
            [
              "Publisher",
              <a key="p" href={marketplaceHref({ publisher: skill.publisher })}>
                {skill.publisher}
              </a>,
            ],
            [
              "Category",
              <a key="c" href={marketplaceHref({ category: skill.category })}>
                {skill.category}
              </a>,
            ],
            [
              "License",
              owned ? (
                <a key="l" href={publicSkillLicensePath}>
                  {skill.license}
                </a>
              ) : (
                skill.license
              ),
            ],
            [
              owned ? "Version" : "Screened revision",
              <code key="r" title={skill.revision}>
                {revisionLabel(skill)}
              </code>,
            ],
            [
              "SKILL.md SHA-256",
              <code key="s" title={skill.sha256}>
                {skill.sha256.slice(0, 12)}…
              </code>,
            ],
          ]}
        />
      </aside>
    </header>
  );
}

function SkillFile({
  skill,
  preview,
}: {
  skill: PublicSkill & { kind: "skill" };
  preview: MarketplaceDetail["preview"];
}) {
  const owned = skill.source === "omnyo";
  const source = owned ? new URL(skill.sourceUrl).pathname : skill.sourceUrl;

  if (!preview)
    return (
      <section className="mk-file mk-file-linked" aria-label="Source">
        <div>
          <span className="mk-kicker">Source</span>
          <h2>Read it where it lives</h2>
          <p>
            Omnyo links to the exact SKILL.md it screened in{" "}
            <span className="mk-mono">{skill.publisher}</span>, pinned at{" "}
            <span className="mk-mono">{revisionLabel(skill)}</span>.
            {skill.setupUrl === undefined
              ? " The file you read is the file you install."
              : " Follow the setup instructions to get the full plugin."}
          </p>
        </div>
        <a className="btn" href={source} rel="noreferrer">
          Open SKILL.md on GitHub
        </a>
      </section>
    );

  return (
    <section className="mk-file" aria-label="SKILL.md preview">
      <header>
        <span className="mk-file-name">
          SKILL.md <small>v{skill.revision}</small>
        </span>
        <a href={source}>Open the full file</a>
      </header>
      <pre>
        <code>
          {preview.lines.map((line, index) => (
            <span
              key={index}
              className={/^#{1,3} /u.test(line) ? "mk-file-heading" : undefined}
            >
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
      {preview.truncated ? (
        <div className="mk-file-fade" aria-hidden="true" />
      ) : null}
    </section>
  );
}

function ConnectorHero({ item }: { item: MarketplaceConnector }) {
  return (
    <header className="mk-detail-hero">
      <div className="mk-detail-main">
        <span className="mk-detail-glyph" aria-hidden="true">
          <ConnectorIcon pluginId={item.pluginId} />
        </span>
        <span className="mk-tile-kind">Connector · Omnyo plugin</span>
        <h1>{item.title}</h1>
        <p className="mk-detail-lead">{item.summary}</p>
        <div className="mk-detail-cta">
          <a
            className="btn mk-btn-brand mk-btn-lg"
            href="#find-in-omnyo"
            onClick={() =>
              sendSiteUsage({ name: "install_intent", kind: "connector" })
            }
          >
            How to connect
          </a>
          <a
            className="btn mk-btn-lg"
            href={MACOS_DOWNLOAD_URL}
            onClick={() => sendSiteUsage({ name: "download_click", os: "mac" })}
          >
            Download Omnyo for Mac
          </a>
        </div>
        <p className="mk-detail-note">{item.availability}</p>
      </div>
      <aside className="mk-facts-card" aria-label="Listing facts">
        <p className="mk-proof">
          <span aria-hidden="true">●</span>
          Built and maintained by Omnyo
        </p>
        <Facts
          rows={[
            ["Service", item.service],
            ["Publisher", item.publisher],
            [
              "Category",
              <a key="c" href={marketplaceHref({ category: item.category })}>
                {item.category}
              </a>,
            ],
            ["Plugin", <code key="p">{item.pluginId}</code>],
          ]}
        />
      </aside>
    </header>
  );
}

export function MarketplaceDetailPage({
  item,
  related,
  preview,
  packResearch,
}: MarketplaceDetail) {
  useEffect(() => {
    sendSiteUsage({ name: "listing_open", kind: item.kind });
  }, [item.kind, item.slug]);

  return (
    <>
      <SiteNav current="explore" path={item.detailPath} />
      <main id="main-content" className="mk mk-page">
        <div className="mk-body">
          <Crumbs item={item} />
          {item.kind === "skill" ? (
            <>
              <SkillHero skill={item} />
              {packResearch ? (
                <section className="mk-section" aria-labelledby="mk-research">
                  <header className="mk-section-head">
                    <h2 id="mk-research">
                      Research behind the Buyer Offer Panel
                    </h2>
                    <p>{packResearch.description}</p>
                    <p>
                      <a href={packResearch.url}>{packResearch.title}</a>
                    </p>
                  </header>
                </section>
              ) : null}
              <SkillFile skill={item} preview={preview} />
              <InstallSection item={item} id="install" />
            </>
          ) : item.kind === "connector" ? (
            <>
              <ConnectorHero item={item} />
              <InstallSection
                item={item}
                id="find-in-omnyo"
                note={item.requirements}
              />
            </>
          ) : null}
          <Related item={item} related={related} />
        </div>
        <MarketplaceBand />
      </main>
      <SiteFooter current={item.detailPath} />
    </>
  );
}
