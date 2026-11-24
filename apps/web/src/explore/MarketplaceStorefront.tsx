import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { MACOS_DOWNLOAD_URL } from "../landing/site";
import { EXPLORE_QUERY_MAX_LENGTH, explorePath } from "./catalog";
import {
  filterMarketplaceItems,
  marketplaceHref,
  type MarketplaceItem,
  type MarketplaceSearch,
} from "./marketplace";
import {
  catalogWallRows,
  isOmnyoEdition,
  listingInitials,
  marketplaceItemKey,
  marketplaceSingular,
  orderMarketplaceItems,
  revisionLabel,
  workflowPreview,
} from "./marketplace-view";
import { KindIcon } from "./ExploreParts";
import {
  ConnectorIcon,
  Highlight,
  ListingIcon,
  onPlainClick,
} from "./MarketplaceParts";
import { publicSkillCategories } from "./public-skills";

const suggestions = [
  "code review",
  "terraform",
  "SEO",
  "email",
  "PDF",
  "postgres",
];

const hitLimits = { workflow: 2, connector: 2, skill: 5 } as const;

export function MarketplaceHero({
  items,
  onApply,
  onPick,
}: {
  items: readonly MarketplaceItem[];
  onApply: (query: string) => void;
  onPick: (item: MarketplaceItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const matches = query.trim()
    ? orderMarketplaceItems(
        filterMarketplaceItems(items, { q: query }),
        "featured",
      )
    : [];

  const groups = (["workflow", "connector", "skill"] as const)
    .map((kind) => ({
      kind,
      hits: matches
        .filter((item) => item.kind === kind)
        .slice(0, hitLimits[kind]),
    }))
    .filter(({ hits }) => hits.length);

  const options = groups.flatMap(({ hits }) => hits);
  const expanded = open && query.trim().length > 0;

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const target = event.target;

      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)))
      )
        return;

      event.preventDefault();
      input.current?.focus();
    }

    document.addEventListener("keydown", focusSearch);

    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const picked = options[active];

    setOpen(false);

    if (picked) onPick(picked);
    else onApply(query.trim());
  }

  function pick(item: MarketplaceItem) {
    setOpen(false);
    onPick(item);
  }

  return (
    <section className="mk-hero" aria-labelledby="mk-title">
      <p className="mk-pill">
        <em>{items.length}</em> listings, each pinned to the source revision
        Omnyo checked
      </p>
      <h1 id="mk-title">
        Give every agent a <span>new skill.</span>
      </h1>
      <p className="mk-lead">
        Find skills, workflows, and connectors for the work you do in Omnyo.
      </p>
      <form
        className="mk-search"
        role="search"
        action={explorePath}
        method="get"
        onSubmit={submit}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setOpen(false);
        }}
      >
        <label className="mk-searchbar">
          <span className="mk-visually-hidden">Search the Marketplace</span>
          <SearchGlyph />
          <input
            ref={input}
            name="q"
            type="search"
            autoComplete="off"
            maxLength={EXPLORE_QUERY_MAX_LENGTH}
            placeholder={`Search ${items.length} listings`}
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              expanded && active >= 0 ? `${listId}-${active}` : undefined
            }
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActive(-1);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);

              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setOpen(true);
                const step = event.key === "ArrowDown" ? 1 : -1;

                setActive((current) =>
                  options.length
                    ? (current + step + options.length) % options.length
                    : -1,
                );
              }
            }}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <div className="mk-hits" hidden={!expanded}>
          <div id={listId} role="listbox" aria-label="Suggestions">
            {groups.map(({ kind, hits }) => (
              <div
                key={kind}
                role="group"
                aria-labelledby={`${listId}-${kind}`}
              >
                <div className="mk-hits-group" id={`${listId}-${kind}`}>
                  {marketplaceSingular[kind]}s
                </div>
                {hits.map((item) => {
                  const index = options.indexOf(item);

                  return (
                    <div
                      key={marketplaceItemKey(item)}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === active}
                      className="mk-hit"
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(item)}
                    >
                      <ListingIcon item={item} />
                      <span>
                        <b>
                          <Highlight text={item.title} query={query} />
                        </b>
                        <small>
                          {item.publisher} · {item.category}
                        </small>
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {options.length ? null : (
            <p className="mk-hits-empty">No matches yet. Try a shorter word.</p>
          )}
          <button className="mk-hits-all" type="submit">
            <span>
              See all <b>{matches.length}</b> results in the directory
            </span>
            <span aria-hidden="true">↵</span>
          </button>
        </div>
      </form>
      <p className="mk-try">
        <span>Try</span>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              setQuery(suggestion);
              setActive(-1);
              setOpen(true);
              input.current?.focus();
            }}
          >
            {suggestion}
          </button>
        ))}
      </p>
    </section>
  );
}

export function SearchGlyph() {
  return (
    <svg
      className="mk-search-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function CatalogWall({
  items,
  onPick,
}: {
  items: readonly MarketplaceItem[];
  onPick: (item: MarketplaceItem) => void;
}) {
  const rows = catalogWallRows(items, 26);

  return (
    <div className="mk-wall" role="region" aria-label="From the catalog">
      {rows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className={
            rowIndex === 1 ? "mk-wall-row mk-wall-reverse" : "mk-wall-row"
          }
        >
          {[0, 1].map((copy) =>
            row.map((item) => (
              <a
                key={`${copy}-${marketplaceItemKey(item)}`}
                className={
                  item.kind === "skill"
                    ? isOmnyoEdition(item)
                      ? "mk-chip mk-chip-omnyo"
                      : "mk-chip"
                    : "mk-chip mk-chip-feature"
                }
                href={item.detailPath}
                aria-hidden={copy === 1 ? true : undefined}
                tabIndex={copy === 1 ? -1 : undefined}
                onClick={onPlainClick(() => onPick(item))}
              >
                <span className="mk-chip-mark" aria-hidden="true">
                  {item.kind === "skill" ? (
                    listingInitials(item.title)
                  ) : item.kind === "connector" ? (
                    <ConnectorIcon pluginId={item.pluginId} />
                  ) : (
                    <KindIcon kind="workflow" />
                  )}
                </span>
                {item.title}
                <small>
                  {item.kind === "skill"
                    ? item.publisher.split("/")[0]
                    : marketplaceSingular[item.kind]}
                </small>
              </a>
            )),
          )}
        </div>
      ))}
    </div>
  );
}

export function MarketplaceStats({
  items,
}: {
  items: readonly MarketplaceItem[];
}) {
  const skills = items.filter((item) => item.kind === "skill");

  const stats = [
    [skills.length, "skills"],
    [new Set(items.map((item) => item.publisher)).size, "publishers"],
    [skills.filter(isOmnyoEdition).length, "Omnyo editions"],
    [items.length - skills.length, "workflows and connectors"],
    [
      skills.filter((item) => item.kind === "skill" && item.license === "MIT")
        .length,
      "MIT-licensed skills",
    ],
  ] as const;

  return (
    <dl className="mk-stats">
      {stats.map(([value, label]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FeaturedBento({
  items,
  onFilter,
}: {
  items: readonly MarketplaceItem[];
  onFilter: (search: MarketplaceSearch) => void;
}) {
  const workflow = items.find((item) => item.kind === "workflow");
  const connectors = items.filter((item) => item.kind === "connector");
  const editions = items.filter(isOmnyoEdition);
  const preview = workflow ? workflowPreview(workflow) : null;

  const provenance = [
    editions[0],
    ...items
      .filter((item) => item.kind === "skill" && !isOmnyoEdition(item))
      .filter(
        (item, index, all) =>
          all.findIndex(({ publisher }) => publisher === item.publisher) ===
          index,
      )
      .slice(0, 2),
  ].filter((item): item is MarketplaceItem => item !== undefined);

  return (
    <section className="mk-section" aria-labelledby="mk-featured">
      <header className="mk-section-head">
        <span className="mk-kicker">Featured</span>
        <h2 id="mk-featured">Start with the ready-made</h2>
        <p>
          Omnyo’s own workflow, connectors and editions. Each one shows you what
          it does before anything runs.
        </p>
      </header>
      <div className="mk-bento">
        {workflow ? (
          <a className="mk-tile mk-tile-workflow" href={workflow.detailPath}>
            {preview ? (
              <img
                src={preview.src}
                alt={preview.alt}
                width={preview.width}
                height={preview.height}
                loading="lazy"
              />
            ) : null}
            <span className="mk-tile-body">
              <span className="mk-tile-kind">
                <ListingIcon item={workflow} /> Workflow · {workflow.publisher}
              </span>
              <span className="mk-tile-title">{workflow.title}</span>
              <span className="mk-tile-text">{workflow.summary}</span>
              <span className="mk-tile-foot">
                <span className="mk-tile-meta">
                  {workflow.kind === "workflow" ? workflow.requirements : null}
                </span>
                <span className="btn mk-btn-brand">Get workflow</span>
              </span>
            </span>
          </a>
        ) : null}
        <a
          className="mk-tile mk-tile-editions"
          href={marketplaceHref({ source: "omnyo" })}
          onClick={onPlainClick(() => onFilter({ source: "omnyo" }))}
        >
          <span className="mk-tile-kind">Omnyo editions</span>
          <span className="mk-tile-title">
            {editions.length} skills, written and tested by Omnyo
          </span>
          <span className="mk-fan" aria-hidden="true">
            {editions.slice(0, 3).map((item) => (
              <span key={item.slug}>
                <i>{item.category}</i>
                <b>{item.title}</b>
                {item.summary}
              </span>
            ))}
          </span>
          <span className="mk-tile-text">
            Versioned, MIT-licensed and hosted here, so you download exactly
            what Omnyo tested.
          </span>
          <span className="btn mk-btn-paper">Browse editions</span>
        </a>
        <div className="mk-connectors">
          {connectors.map((item) => (
            <a
              key={item.slug}
              className="mk-tile mk-tile-connector"
              href={item.detailPath}
            >
              <span className="mk-glyph" aria-hidden="true">
                {item.kind === "connector" ? (
                  <ConnectorIcon pluginId={item.pluginId} />
                ) : null}
              </span>
              <span className="mk-tile-kind">Connector · Omnyo plugin</span>
              <span className="mk-tile-title">{item.title}</span>
              <span className="mk-tile-text">{item.summary}</span>
              <span className="btn btn-sm">Find in Omnyo</span>
            </a>
          ))}
        </div>
        <div className="mk-tile mk-tile-provenance">
          <div>
            <span className="mk-kicker">Provenance</span>
            <h3>You install what Omnyo read.</h3>
            <p className="mk-tile-text">
              Omnyo screens each skill’s source and pins the exact revision.
              Editions are versioned files hosted here; everything else links to
              the exact GitHub file that was screened.
            </p>
          </div>
          <ol>
            {provenance.map((item) => (
              <li key={item.slug}>
                <a href={item.detailPath}>
                  <span>
                    {item.title}
                    <small>{item.publisher}</small>
                  </span>
                  {item.kind === "skill" ? (
                    <span className="mk-tag">{item.license}</span>
                  ) : null}
                  <span className="mk-pin">{revisionLabel(item)}</span>
                </a>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

export function CategoryCards({
  items,
  current,
  onFilter,
}: {
  items: readonly MarketplaceItem[];
  current: string | undefined;
  onFilter: (search: MarketplaceSearch) => void;
}) {
  const counts = publicSkillCategories.map((category) => ({
    category,
    listings: orderMarketplaceItems(
      items.filter((item) => item.category === category),
      "featured",
    ),
  }));

  const max = Math.max(1, ...counts.map(({ listings }) => listings.length));

  return (
    <section className="mk-section" aria-labelledby="mk-categories">
      <header className="mk-section-head">
        <span className="mk-kicker">Browse by work</span>
        <h2 id="mk-categories">Nine kinds of work</h2>
      </header>
      <ul className="mk-categories">
        {counts.map(({ category, listings }) => (
          <li key={category}>
            <a
              href={marketplaceHref({ category })}
              aria-current={current === category ? "true" : undefined}
              onClick={onPlainClick(() =>
                onFilter({
                  category: current === category ? undefined : category,
                }),
              )}
            >
              <span className="mk-category-top">
                <b>{category}</b>
                <span>{listings.length}</span>
              </span>
              <span className="mk-meter" aria-hidden="true">
                <i style={{ width: `${(listings.length / max) * 100}%` }} />
              </span>
              <small>
                {listings
                  .slice(0, 2)
                  .map(({ title }) => title)
                  .join(" · ")}
              </small>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MarketplaceBand() {
  return (
    <section className="mk-band" aria-labelledby="mk-band-title">
      <div>
        <h2 id="mk-band-title">The same Marketplace, inside Omnyo.</h2>
        <p>
          Nothing installs, imports or connects until you have reviewed it in
          Omnyo and confirmed.
        </p>
        <a
          className="btn mk-btn-brand"
          href={MACOS_DOWNLOAD_URL}
          onClick={() => sendSiteUsage({ name: "download_click", os: "mac" })}
        >
          Download for Mac
        </a>
      </div>
      <ol>
        <li>
          <i>01</i>Find it here or in Omnyo’s Skill Library
        </li>
        <li>
          <i>02</i>Open it in Omnyo with one click
        </li>
        <li>
          <i>03</i>Review the exact files before anything installs
        </li>
      </ol>
    </section>
  );
}

import { sendSiteUsage } from "../analytics/usage";
