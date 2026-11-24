import { Link } from "@tanstack/react-router";

import { GetArrow } from "../landing/download";
import { SiteFooter, SiteNav } from "../landing/site-chrome";
import {
  workflowCompatibilityLine,
  workflowGalleryPath,
  type WorkflowListingSummary,
} from "./catalog";
import { WeekArt } from "./WorkflowWeek";

export function WorkflowGallery({
  listings,
  category,
}: {
  listings: readonly WorkflowListingSummary[];
  category?: string;
}) {
  const categories = [...new Set(listings.map((listing) => listing.category))];

  const visible = category
    ? listings.filter((listing) => listing.category === category)
    : listings;

  return (
    <div className="wf-page">
      <SiteNav current="workflows" path={workflowGalleryPath} />
      <main id="main-content" className="wf-main">
        <header className="wf-intro">
          <h1>Official workflows</h1>
          <p className="wf-lead">
            Explore an example, see how it works, then take an editable workflow
            into Omnyo.
          </p>
        </header>
        {categories.length > 1 ? (
          <nav className="wf-filters" aria-label="Workflow categories">
            <a
              href={workflowGalleryPath}
              aria-current={!category ? "page" : undefined}
            >
              All workflows
            </a>
            {categories.map((item) => (
              <a
                key={item}
                href={`${workflowGalleryPath}?category=${encodeURIComponent(item)}`}
                aria-current={category === item ? "page" : undefined}
              >
                {item}
              </a>
            ))}
          </nav>
        ) : null}
        <section
          className={
            visible.length === 1
              ? "wf-gallery wf-gallery--single"
              : "wf-gallery"
          }
          aria-label="Workflows"
        >
          {visible.map((listing) => (
            <Link
              className="wf-card"
              to="/workflows/$slug"
              params={{ slug: listing.slug }}
              key={listing.slug}
              aria-labelledby={`wf-card-${listing.slug}`}
            >
              <div className="wf-card-body">
                <p className="wf-label">
                  {listing.category} · {listing.cadence}
                </p>
                <h2 id={`wf-card-${listing.slug}`}>{listing.title}</h2>
                <p className="wf-card-desc">{listing.description}</p>
                <p className="wf-card-output">
                  <span className="wf-label">You get</span>
                  {listing.outputSummary}
                </p>
                <p className="wf-label">
                  {workflowCompatibilityLine(listing.compatibility)}
                </p>
                <span className="wf-card-cta">
                  See example and setup
                  <GetArrow kind="next" />
                </span>
              </div>
              <div className="wf-card-art">
                <WeekArt week={listing.week} />
              </div>
            </Link>
          ))}
          {visible.length === 0 ? (
            <div className="wf-empty">
              <h2>No workflows in this category</h2>
              <a href={workflowGalleryPath}>Explore all workflows</a>
            </div>
          ) : null}
        </section>
      </main>
      <SiteFooter current={workflowGalleryPath} />
    </div>
  );
}
