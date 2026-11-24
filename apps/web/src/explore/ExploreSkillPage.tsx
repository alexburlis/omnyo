import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { explorePath, exploreSkillFilePath } from "./catalog";
import type { ExploreSkillDetail } from "./catalog.server";
import { KindIcon, RelatedLinks, itemByline } from "./ExploreParts";

export function ExploreSkillPage({
  item,
  release,
  related,
}: ExploreSkillDetail) {
  const { slug } = item;
  const { sha256 } = release;
  const filePath = exploreSkillFilePath(slug, sha256);
  const openLink = `omnyo://skills/import/${slug}/${sha256}`;

  useEffect(() => {
    sendSiteUsage({ name: "listing_open", kind: "skill" });
  }, [slug]);

  return (
    <>
      <SiteNav current="explore" path={item.path} />
      <div className="wrap ex-page">
        <main id="main-content">
          <a className="ex-back" href={`${explorePath}?type=skill`}>
            ← Skills
          </a>
          <header className="ex-detail-header">
            <span className="ex-plugin-mark" aria-hidden="true">
              <KindIcon kind="skill" />
            </span>
            <p className="ex-eyebrow">{itemByline(item)}</p>
            <h1>{item.title}</h1>
            <p className="ex-lead">{item.summary}</p>
            <div className="ex-actions">
              <a
                className="btn btn-primary"
                href={openLink}
                onClick={() =>
                  sendSiteUsage({ name: "install_intent", kind: "skill" })
                }
              >
                Install in Omnyo
              </a>
              <a className="btn btn-ghost" href={filePath} download>
                Download pack
              </a>
            </div>
            <p className="ex-small ex-skill-hint">
              Review the pack in the Omnyo desktop app before installing.
            </p>
          </header>
          <section className="ex-section" aria-labelledby="ex-included-heading">
            <h2 id="ex-included-heading">What’s included</h2>
            <div className="ex-skill-included">
              <div>
                <h3>Skills</h3>
                <ul className="ex-list">
                  {release.skills.map((skill) => (
                    <li key={skill}>
                      <code>{skill}</code>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Saved prompts</h3>
                <ul className="ex-list">
                  {release.prompts.map((prompt) => (
                    <li key={prompt}>{prompt}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="ex-small ex-skill-hint">
              Version {release.version} · {release.license} license
            </p>
          </section>
          {release.research ? (
            <section
              className="ex-section"
              aria-labelledby="ex-research-heading"
            >
              <h2 id="ex-research-heading">
                Research behind the Buyer Offer Panel
              </h2>
              <p>{release.research.description}</p>
              <p>
                <a href={release.research.url}>{release.research.title}</a>
              </p>
            </section>
          ) : null}
          <section
            className="ex-section ex-handoff"
            aria-labelledby="ex-skill-install-heading"
          >
            <h2 id="ex-skill-install-heading">Install from a file</h2>
            <p>
              If the desktop link is unavailable, download the pack. In Omnyo’s
              Skills, choose Import and select the downloaded file to review it.
            </p>
          </section>
          <RelatedLinks links={related} />
        </main>
      </div>
      <SiteFooter current={item.path} />
    </>
  );
}

import { useEffect } from "react";
import { sendSiteUsage } from "../analytics/usage";
