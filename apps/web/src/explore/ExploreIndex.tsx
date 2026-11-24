import { SiteFooter, SiteNav } from "../landing/site-chrome";
import {
  EXPLORE_KINDS,
  EXPLORE_KIND_LABELS,
  EXPLORE_QUERY_MAX_LENGTH,
  explorePath,
  exploreKey,
  exploreSearchHref,
  filterExploreItems,
  type ExploreItem,
  type ExploreSearch,
} from "./catalog";
import { KindIcon, itemByline } from "./ExploreParts";
import { publicSkillsPath } from "./public-skills";

function ExploreCard({ item }: { item: ExploreItem }) {
  return (
    <a className="ex-card" href={item.path}>
      <span className="ex-card-kind">
        <KindIcon kind={item.kind} className="ex-kind-icon" />
        <span>{itemByline(item)}</span>
      </span>
      <h3>{item.title}</h3>
      <p>{item.summary}</p>
      <span className="ex-card-bottom">
        <span className="ex-tags">{item.tags.join(" · ")}</span>
        <span className="ex-cta">
          {item.cta.label} <span aria-hidden="true">→</span>
        </span>
      </span>
    </a>
  );
}

function FeaturedCard({ item }: { item: ExploreItem }) {
  return (
    <a className="ex-featured" href={item.path}>
      <span className="ex-featured-art">
        {item.preview ? (
          <img
            src={item.preview.path}
            alt={item.preview.alt}
            width={item.preview.width}
            height={item.preview.height}
            loading="lazy"
          />
        ) : (
          <KindIcon kind={item.kind} className="ex-featured-icon" />
        )}
      </span>
      <span className="ex-featured-body">
        <span className="ex-eyebrow">Featured · {itemByline(item)}</span>
        <h2>{item.title}</h2>
        <span className="ex-featured-summary">{item.summary}</span>
        <span className="ex-cta">
          {item.cta.label} <span aria-hidden="true">→</span>
        </span>
      </span>
    </a>
  );
}

export function ExploreIndex({
  items,
  search,
}: {
  items: readonly ExploreItem[];
  search: ExploreSearch;
}) {
  const filtered = search.type !== undefined || search.q !== undefined;

  const visible = filterExploreItems(items, {
    kind: search.type,
    query: search.q,
  });

  const featured = filtered ? undefined : visible[0];
  const grid = featured ? visible.slice(1) : visible;

  const kinds = EXPLORE_KINDS.filter((kind) =>
    items.some((item) => item.kind === kind),
  );

  return (
    <>
      <SiteNav current="explore" path={explorePath} />
      <div className="wrap ex-page">
        <main id="main-content">
          <header className="ex-intro">
            <p className="ex-eyebrow">Explore</p>
            <h1>Explore for Omnyo</h1>
            <p className="ex-lead">
              Browse skill packs, prompts, workflows, plugins and guides.
            </p>
          </header>
          {featured ? <FeaturedCard item={featured} /> : null}
          <div className="ex-controls">
            <nav className="ex-filters" aria-label="Item types">
              <a
                href={exploreSearchHref({ q: search.q })}
                aria-current={search.type === undefined ? "page" : undefined}
              >
                All
              </a>
              <a href={publicSkillsPath}>Skills</a>
              {kinds.map((kind) => (
                <a
                  key={kind}
                  href={exploreSearchHref({ type: kind, q: search.q })}
                  aria-current={search.type === kind ? "page" : undefined}
                >
                  {EXPLORE_KIND_LABELS[kind].many}
                </a>
              ))}
            </nav>
            <form
              className="ex-search"
              role="search"
              method="get"
              action={explorePath}
            >
              {search.type ? (
                <input type="hidden" name="type" value={search.type} />
              ) : null}
              <label className="ex-visually-hidden" htmlFor="ex-query">
                Search Explore
              </label>
              <input
                id="ex-query"
                name="q"
                type="search"
                defaultValue={search.q ?? ""}
                maxLength={EXPLORE_QUERY_MAX_LENGTH}
                placeholder="Search titles, summaries and tags"
              />
              <button className="btn btn-ghost" type="submit">
                Search
              </button>
            </form>
          </div>
          {grid.length ? (
            <section className="ex-grid" aria-labelledby="ex-grid-heading">
              <h2 id="ex-grid-heading" className="ex-visually-hidden">
                {featured ? "More to explore" : "Results"}
              </h2>
              {grid.map((item) => (
                <ExploreCard item={item} key={exploreKey(item)} />
              ))}
            </section>
          ) : null}
          {visible.length === 0 ? (
            <div className="ex-empty" data-explore-empty="">
              <h2>Nothing matches</h2>
              <p>Try another word, or look through everything in Explore.</p>
              <a className="btn btn-ghost" href={explorePath}>
                Clear filters
              </a>
            </div>
          ) : null}
        </main>
      </div>
      <SiteFooter current={explorePath} />
    </>
  );
}
