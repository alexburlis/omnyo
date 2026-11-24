import { useEffect, useState, type ReactNode } from "react";
import { resultCountBucket, sendSiteUsage } from "../analytics/usage";

import { EXPLORE_QUERY_MAX_LENGTH, explorePath } from "./catalog";
import {
  filterMarketplaceItems,
  marketplaceHref,
  marketplaceKinds,
  marketplaceLabels,
  type MarketplaceItem,
  type MarketplaceSearch,
} from "./marketplace";
import {
  facetCounts,
  installSteps,
  isOmnyoEdition,
  marketplaceActions,
  marketplaceItemKey,
  marketplaceLicenses,
  marketplaceSingular,
  orderMarketplaceItems,
  revisionLabel,
  type MarketplaceFilterKey,
} from "./marketplace-view";
import {
  Highlight,
  ListingBadge,
  ListingIcon,
  onPlainClick,
} from "./MarketplaceParts";
import { SearchGlyph } from "./MarketplaceStorefront";
import {
  PUBLIC_SKILLS_PAGE_SIZE,
  publicSkillCategories,
} from "./public-skills";

const sourceLabels = { omnyo: "Omnyo editions", github: "Source-linked" };

const PUBLISHERS_SHOWN = 7;

function FacetLink({
  label,
  count,
  current,
  search,
  onChange,
  className = "mk-facet",
}: {
  label: ReactNode;
  count: number;
  current: boolean;
  search: MarketplaceSearch;
  onChange: (search: MarketplaceSearch) => void;
  className?: string;
}) {
  const disabled = count === 0 && !current;

  return (
    <a
      className={className}
      href={marketplaceHref(search)}
      aria-current={current ? "true" : undefined}
      aria-disabled={disabled ? true : undefined}
      tabIndex={disabled ? -1 : undefined}
      onClick={onPlainClick(() => {
        if (!disabled) onChange(search);
      })}
    >
      <span>{label}</span>
      <small>{count}</small>
    </a>
  );
}

function toggled(
  filters: MarketplaceSearch,
  key: MarketplaceFilterKey,
  value: string,
): MarketplaceSearch {
  return {
    ...filters,
    [key]: filters[key] === value ? undefined : value,
    page: undefined,
  };
}

export function MarketplaceDirectory({
  items,
  filters,
  onChange,
  selected,
  onSelect,
  sheetOpen,
  onCloseSheet,
}: {
  items: readonly MarketplaceItem[];
  filters: MarketplaceSearch;
  onChange: (search: MarketplaceSearch) => void;
  selected: MarketplaceItem | undefined;
  onSelect: (item: MarketplaceItem) => void;
  sheetOpen: boolean;
  onCloseSheet: () => void;
}) {
  const [sort, setSort] = useState<"featured" | "az">("featured");
  const [shown, setShown] = useState(PUBLIC_SKILLS_PAGE_SIZE);
  const [publisherQuery, setPublisherQuery] = useState("");
  const [allPublishers, setAllPublishers] = useState(false);

  const change = (next: MarketplaceSearch) => {
    setShown(PUBLIC_SKILLS_PAGE_SIZE);
    onChange(next);
  };

  const matches = orderMarketplaceItems(
    filterMarketplaceItems(items, filters),
    sort,
  );

  useEffect(() => {
    sendSiteUsage({
      name: "marketplace_results",
      count: resultCountBucket(matches.length),
    });
  }, [filters, matches.length]);

  const page = Math.min(
    filters.page ?? 1,
    Math.max(1, Math.ceil(matches.length / PUBLIC_SKILLS_PAGE_SIZE)),
  );

  const start = (page - 1) * PUBLIC_SKILLS_PAGE_SIZE;
  const visible = matches.slice(start, start + shown);
  const remaining = matches.length - start - visible.length;

  const kinds = facetCounts(
    items,
    filters,
    "type",
    marketplaceKinds,
    (item) => item.kind,
  );

  const categories = facetCounts(
    items,
    filters,
    "category",
    publicSkillCategories,
    (item) => item.category,
  );

  const sources = facetCounts(
    items,
    filters,
    "source",
    ["omnyo", "github"] as const,
    (item) => (item.kind === "skill" ? item.source : undefined),
  );

  const licenses = facetCounts(
    items,
    filters,
    "license",
    marketplaceLicenses,
    (item) => (item.kind === "skill" ? item.license : undefined),
  );

  const publishers = facetCounts(
    items,
    filters,
    "publisher",
    [...new Set(items.map((item) => item.publisher))],
    (item) => item.publisher,
  )
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"))
    .filter(([name]) =>
      name.toLowerCase().includes(publisherQuery.trim().toLowerCase()),
    );

  const shownPublishers =
    allPublishers || publisherQuery
      ? publishers
      : publishers.slice(0, PUBLISHERS_SHOWN);

  const active = (["category", "source", "publisher", "license"] as const)
    .filter((key) => filters[key])
    .map((key) => ({
      key,
      label:
        key === "source" && filters.source
          ? sourceLabels[filters.source]
          : String(filters[key]),
    }));

  const query = filters.q ?? "";

  return (
    <section
      className="mk-section mk-directory"
      id="directory"
      aria-labelledby="mk-directory"
    >
      <header className="mk-section-head">
        <span className="mk-kicker">Directory</span>
        <h2 id="mk-directory">Everything in the Marketplace</h2>
        <p>
          Filter, then open any listing for its source, license and install
          steps.
        </p>
      </header>
      <div className="mk-toolbar">
        <form
          className="mk-filterbar"
          role="search"
          action={explorePath}
          method="get"
          onSubmit={(event) => event.preventDefault()}
        >
          <label>
            <span className="mk-visually-hidden">Filter listings</span>
            <SearchGlyph />
            <input
              name="q"
              type="search"
              maxLength={EXPLORE_QUERY_MAX_LENGTH}
              placeholder={`Filter ${items.length} listings`}
              value={query}
              onChange={(event) =>
                change({
                  ...filters,
                  q: event.currentTarget.value || undefined,
                  page: undefined,
                })
              }
            />
          </label>
          {(
            ["type", "category", "publisher", "source", "license"] as const
          ).map((key) =>
            filters[key] ? (
              <input key={key} type="hidden" name={key} value={filters[key]} />
            ) : null,
          )}
        </form>
        <nav className="mk-types" aria-label="Listing types">
          <FacetLink
            className="mk-type"
            label="All"
            count={kinds.reduce((sum, [, count]) => sum + count, 0)}
            current={!filters.type}
            search={{ ...filters, type: undefined, page: undefined }}
            onChange={change}
          />
          {kinds.map(([kind, count]) => (
            <FacetLink
              key={kind}
              className="mk-type"
              label={marketplaceLabels[kind]}
              count={count}
              current={filters.type === kind}
              search={toggled(filters, "type", kind)}
              onChange={change}
            />
          ))}
        </nav>
        <label className="mk-sort">
          <span className="mk-visually-hidden">Sort</span>
          <select
            value={sort}
            onChange={(event) =>
              setSort(event.currentTarget.value === "az" ? "az" : "featured")
            }
          >
            <option value="featured">Omnyo first</option>
            <option value="az">A–Z</option>
          </select>
        </label>
      </div>
      <div className="mk-directory-grid">
        <aside className="mk-rail" aria-label="Filters">
          <div className="mk-facets">
            <h3 className="mk-kicker">Category</h3>
            {categories.map(([category, count]) => (
              <FacetLink
                key={category}
                label={category}
                count={count}
                current={filters.category === category}
                search={toggled(filters, "category", category)}
                onChange={change}
              />
            ))}
          </div>
          <div className="mk-facets">
            <h3 className="mk-kicker">Source</h3>
            {sources.map(([source, count]) => (
              <FacetLink
                key={source}
                label={sourceLabels[source]}
                count={count}
                current={filters.source === source}
                search={toggled(filters, "source", source)}
                onChange={change}
              />
            ))}
          </div>
          <div className="mk-facets">
            <h3 className="mk-kicker">Publisher</h3>
            <input
              className="mk-facet-search"
              type="search"
              placeholder="Find a publisher"
              aria-label="Find a publisher"
              value={publisherQuery}
              onChange={(event) => setPublisherQuery(event.currentTarget.value)}
            />
            {shownPublishers.map(([publisher, count]) => (
              <FacetLink
                key={publisher}
                label={publisher}
                count={count}
                current={filters.publisher === publisher}
                search={toggled(filters, "publisher", publisher)}
                onChange={change}
              />
            ))}
            {allPublishers ||
            publisherQuery ||
            publishers.length <= PUBLISHERS_SHOWN ? null : (
              <button
                className="mk-more"
                type="button"
                onClick={() => setAllPublishers(true)}
              >
                All {publishers.length} publishers
              </button>
            )}
          </div>
          <div className="mk-facets">
            <h3 className="mk-kicker">License</h3>
            {licenses.map(([license, count]) => (
              <FacetLink
                key={license}
                label={license}
                count={count}
                current={filters.license === license}
                search={toggled(filters, "license", license)}
                onChange={change}
              />
            ))}
          </div>
        </aside>
        <div className="mk-results">
          <div className="mk-results-meta">
            <p role="status">
              <b>{matches.length.toLocaleString("en-US")}</b>{" "}
              {matches.length === 1 ? "listing" : "listings"}
              {query ? ` for “${query}”` : ""}
            </p>
            {active.length || query || filters.type ? (
              <span className="mk-active">
                {active.map(({ key, label }) => (
                  <a
                    key={key}
                    href={marketplaceHref({
                      ...filters,
                      [key]: undefined,
                      page: undefined,
                    })}
                    onClick={onPlainClick(() =>
                      change({ ...filters, [key]: undefined, page: undefined }),
                    )}
                  >
                    {label} <span aria-hidden="true">×</span>
                    <span className="mk-visually-hidden">Remove filter</span>
                  </a>
                ))}
                <a href={explorePath} onClick={onPlainClick(() => change({}))}>
                  Clear all
                </a>
              </span>
            ) : null}
          </div>
          {visible.length ? (
            <ul className="mk-rows">
              {visible.map((item) => (
                <li key={marketplaceItemKey(item)}>
                  <a
                    className="mk-row"
                    href={item.detailPath}
                    aria-current={selected === item ? "true" : undefined}
                    onClick={onPlainClick(() => onSelect(item))}
                  >
                    <ListingIcon item={item} />
                    <span className="mk-row-main">
                      <span className="mk-row-title">
                        <span>
                          <Highlight text={item.title} query={query} />
                        </span>
                        <ListingBadge item={item} />
                      </span>
                      <span className="mk-row-sub">
                        {item.summary ??
                          (item.kind === "skill"
                            ? `Screened source · ${item.license} · ${revisionLabel(item)}`
                            : "")}
                      </span>
                    </span>
                    <span className="mk-row-publisher">
                      {item.publisher}
                      <small>{item.category}</small>
                    </span>
                    <span className="mk-row-go" aria-hidden="true">
                      →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mk-empty" data-explore-empty="">
              <h3>No listings match</h3>
              <p>Try a shorter search or clear a filter.</p>
              <a
                className="btn btn-ghost"
                href={explorePath}
                onClick={onPlainClick(() => change({}))}
              >
                Clear filters
              </a>
            </div>
          )}
          <nav className="mk-pager" aria-label="Marketplace pages">
            {page > 1 ? (
              <a
                className="btn btn-ghost"
                href={marketplaceHref({ ...filters, page: page - 1 })}
              >
                Previous
              </a>
            ) : null}
            {remaining > 0 ? (
              <a
                className="btn btn-ghost"
                href={marketplaceHref({ ...filters, page: page + 1 })}
                onClick={onPlainClick(() =>
                  setShown((count) => count + PUBLIC_SKILLS_PAGE_SIZE),
                )}
              >
                Show {Math.min(PUBLIC_SKILLS_PAGE_SIZE, remaining)} more of{" "}
                {remaining}
              </a>
            ) : null}
          </nav>
        </div>
        {selected ? (
          <ListingDetail
            item={selected}
            open={sheetOpen}
            onClose={onCloseSheet}
          />
        ) : null}
      </div>
    </section>
  );
}

function ListingDetail({
  item,
  open,
  onClose,
}: {
  item: MarketplaceItem;
  open: boolean;
  onClose: () => void;
}) {
  const [primary, secondary] = marketplaceActions(item);

  const kindLabel =
    item.kind === "skill"
      ? isOmnyoEdition(item)
        ? "Omnyo edition"
        : "Source-linked skill"
      : marketplaceSingular[item.kind];

  return (
    <aside
      className="mk-detail"
      data-open={open ? "" : undefined}
      aria-label={`${item.title} details`}
    >
      <div className="mk-detail-top">
        <span className="mk-tile-kind">
          <ListingIcon item={item} /> {kindLabel}
        </span>
        <span className="mk-detail-tools">
          <span className="mk-badge">{item.category}</span>
          <button className="mk-close" type="button" onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="mk-visually-hidden">Close details</span>
          </button>
        </span>
      </div>
      <h3>{item.title}</h3>
      <p className="mk-detail-summary">
        {item.summary ??
          `Screened from github.com/${item.publisher} at the pinned revision below. The publisher’s own README describes it in full.`}
      </p>
      <dl className="mk-facts">
        <dt>Publisher</dt>
        <dd className="mk-mono">{item.publisher}</dd>
        {item.kind === "skill" ? (
          <>
            <dt>License</dt>
            <dd>{item.license}</dd>
          </>
        ) : null}
        <dt>
          {item.kind === "connector"
            ? "Plugin"
            : item.kind === "workflow"
              ? "Release"
              : "Revision"}
        </dt>
        <dd className="mk-mono">{revisionLabel(item)}</dd>
        {item.kind !== "skill" ? (
          <>
            <dt>Needs</dt>
            <dd>{item.requirements}</dd>
          </>
        ) : null}
      </dl>
      <ol className="mk-steps">
        {installSteps(item).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="mk-cli">
        <span>
          omnyo explore marketplace --query "{item.title.toLowerCase()}"
        </span>
      </p>
      <div className="mk-detail-actions">
        {primary ? (
          <a
            className={
              item.kind === "skill" ? "btn btn-primary" : "btn mk-btn-brand"
            }
            href={primary.href}
            onClick={() =>
              sendSiteUsage({ name: "install_intent", kind: item.kind })
            }
          >
            {primary.label}
          </a>
        ) : null}
        {secondary ? (
          <a
            className="btn btn-ghost"
            href={secondary.href}
            download={secondary.download}
            rel={secondary.external ? "noreferrer" : undefined}
          >
            {secondary.label}
          </a>
        ) : null}
      </div>
      <a className="mk-detail-page" href={item.detailPath}>
        Open the full listing <span aria-hidden="true">→</span>
      </a>
    </aside>
  );
}
