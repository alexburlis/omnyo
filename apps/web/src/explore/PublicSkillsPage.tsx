import { SiteFooter, SiteNav } from "../landing/site-chrome";
import {
  publicSkillCategories,
  publicSkillsHref,
  publicSkillsPath,
  type PublicSkill,
  type PublicSkillsSearch,
} from "./public-skills";

interface PublicSkillsPageProps {
  items: readonly PublicSkill[];
  publishers: readonly string[];
  page: number;
  lastPage: number;
  total: number;
  catalogTotal: number;
  search: PublicSkillsSearch;
}

export function PublicSkillsPage({
  items,
  publishers,
  page,
  lastPage,
  total,
  catalogTotal,
  search,
}: PublicSkillsPageProps) {
  return (
    <>
      <SiteNav current="explore" path={publicSkillsPath} />
      <div className="wrap ex-page">
        <main id="main-content">
          <header className="ex-intro">
            <a href="/explore" className="ex-eyebrow">
              Explore
            </a>
            <h1>Skills</h1>
            <p className="ex-lead">
              Browse {catalogTotal.toLocaleString("en-US")} skills curated by
              Omnyo. Find the instructions you need and go straight to the
              source.
            </p>
          </header>

          <form
            className="ex-skill-filters"
            role="search"
            method="get"
            action={publicSkillsPath}
          >
            <label>
              Search skills
              <input
                type="search"
                name="q"
                defaultValue={search.q ?? ""}
                maxLength={80}
                placeholder="Try React, writing, or data"
              />
            </label>
            <label>
              Category
              <select name="category" defaultValue={search.category ?? ""}>
                <option value="">All categories</option>
                {publicSkillCategories.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
            <label>
              Publisher
              <select name="publisher" defaultValue={search.publisher ?? ""}>
                <option value="">All publishers</option>
                {publishers.map((publisher) => (
                  <option key={publisher}>{publisher}</option>
                ))}
              </select>
            </label>
            <button className="btn btn-ghost" type="submit">
              Search
            </button>
          </form>

          <div className="ex-skill-count">
            <p className="ex-small" aria-live="polite">
              {total.toLocaleString("en-US")} {total === 1 ? "skill" : "skills"}
            </p>
            {search.q || search.publisher || search.category ? (
              <a className="ex-small" href={publicSkillsPath}>
                Clear filters
              </a>
            ) : null}
          </div>

          {items.length ? (
            <section className="ex-grid" aria-label="Skill results">
              {items.map((item) => (
                <a
                  className="ex-card ex-skill-card"
                  key={item.slug}
                  href={item.detailPath}
                >
                  <span className="ex-card-kind">{item.category}</span>
                  <h2>{item.title}</h2>
                  <span className="ex-small">
                    {item.publisher} · {item.license}
                  </span>
                  {item.summary ? <p>{item.summary}</p> : null}
                  <span className="ex-cta">
                    View skill <span aria-hidden="true">→</span>
                  </span>
                </a>
              ))}
            </section>
          ) : (
            <div className="ex-empty">
              <h2>No skills match</h2>
              <p>Try a shorter search or clear a filter.</p>
            </div>
          )}

          {lastPage > 1 ? (
            <nav className="ex-skill-pagination" aria-label="Skill pages">
              {page > 1 ? (
                <a
                  className="btn btn-ghost"
                  href={publicSkillsHref({ ...search, page: page - 1 })}
                >
                  Previous
                </a>
              ) : null}
              <span className="ex-small">
                Page {page} of {lastPage}
              </span>
              {page < lastPage ? (
                <a
                  className="btn btn-ghost"
                  href={publicSkillsHref({ ...search, page: page + 1 })}
                >
                  Next
                </a>
              ) : null}
            </nav>
          ) : null}
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
