import { useEffect, useMemo, useState } from "react";
import { UrlLink, useRpc, useSdk } from "@omnyo/plugin-sdk/app";
import type { z } from "zod";
import {
  filterMarketplace,
  marketplaceCategories,
  marketplaceOrigin,
  marketplaceRpc,
  workflowImportPath,
  type MarketplaceFilters,
  type MarketplaceItem,
} from "./marketplace-contract";

type Catalog = z.infer<(typeof marketplaceRpc)["marketplaceGet"]["output"]>;

type PluginState = { id: string; enabled: boolean; hasSettings: boolean };

type Load = { kind: "loading" } | { kind: "ready"; value: Catalog } | { kind: "error" };

function Item({
  item,
  reviewedId,
  plugin,
  review,
}: {
  item: MarketplaceItem;
  reviewedId: string | undefined;
  plugin: PluginState | undefined;
  review(slug: string, digest: string): void;
}) {
  const configure = item.kind === "connector" && plugin?.enabled && plugin.hasSettings;

  return (
    <article className="sd-marketplace-card">
      <p className="sd-marketplace-meta">
        {item.kind === "skill" ? "Skill" : item.kind === "workflow" ? "Workflow" : "Connector"} ·{" "}
        {item.category}
      </p>
      <h2>
        <UrlLink href={`${marketplaceOrigin}${item.detailPath}`}>{item.title}</UrlLink>
      </h2>
      {item.summary && <p>{item.summary}</p>}
      <p className="sd-marketplace-meta">{item.publisher}</p>
      {item.kind !== "skill" && <p>{item.requirements}</p>}
      {item.kind === "connector" && (
        <p className="sd-marketplace-meta">
          {item.availability}
          {plugin ? ` · ${plugin.enabled ? "Installed" : "Disabled"}` : ""}
        </p>
      )}
      <div className="sd-marketplace-actions">
        {item.kind === "skill" && item.setupUrl ? (
          <UrlLink className="sd-button sd-primary" href={item.setupUrl}>
            Setup instructions
          </UrlLink>
        ) : item.kind === "skill" ? (
          <button
            className="sd-button sd-primary"
            type="button"
            onClick={() => review(item.slug, item.sha256)}
          >
            {reviewedId ? "Review package" : "Review Markdown"}
          </button>
        ) : item.kind === "workflow" ? (
          <UrlLink className="sd-button sd-primary" href={workflowImportPath(item)}>
            Review workflow
          </UrlLink>
        ) : configure ? (
          <UrlLink className="sd-button sd-primary" href={`/settings/plugins/${item.pluginId}`}>
            Configure
          </UrlLink>
        ) : (
          <UrlLink className="sd-button" href={`${marketplaceOrigin}${item.detailPath}`}>
            View connector
          </UrlLink>
        )}
      </div>
    </article>
  );
}

export function MarketplacePage({
  initialQuery = "",
  review,
  openCurated,
}: {
  initialQuery?: string;
  review(slug: string, digest: string): void;
  openCurated(): void;
}) {
  const rpc = useRpc<typeof marketplaceRpc>();
  const sdk = useSdk();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [plugins, setPlugins] = useState<PluginState[]>([]);
  const [pluginError, setPluginError] = useState(false);
  const [visible, setVisible] = useState(36);

  const [filters, setFilters] = useState<MarketplaceFilters>({
    query: initialQuery,
    kind: "skill",
    category: "",
    publisher: "",
  });

  useEffect(() => {
    let active = true;
    setLoad({ kind: "loading" });

    const timeout = setTimeout(() => {
      if (active) {
        active = false;
        setLoad({ kind: "error" });
      }
    }, 15000);

    void rpc
      .call("marketplaceGet", {})
      .then(
        (value) => {
          if (active) setLoad({ kind: "ready", value });
        },
        () => {
          if (active) setLoad({ kind: "error" });
        },
      )
      .finally(() => clearTimeout(timeout));

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [rpc, reload]);

  useEffect(() => {
    if (filters.kind && filters.kind !== "connector") return;
    const request = new AbortController();
    setPluginError(false);
    setPlugins([]);

    void sdk.plugins.list({ signal: request.signal }).then(
      (value) => {
        if (!request.signal.aborted) setPlugins(value.plugins);
      },
      () => {
        if (!request.signal.aborted) {
          setPlugins([]);
          setPluginError(true);
        }
      },
    );

    return () => request.abort();
  }, [sdk, reload, filters.kind]);

  const items = load.kind === "ready" ? load.value.catalog.items : [];
  const matches = useMemo(() => filterMarketplace(items, filters), [items, filters]);
  const publishers = [...new Set(items.map((item) => item.publisher))].sort();

  function filter(key: keyof MarketplaceFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setVisible(36);
  }

  return (
    <section className="sd-full sd-marketplace" aria-label="Marketplace">
      <header className="sd-marketplace-heading">
        <h2 data-sd-heading tabIndex={-1}>
          Marketplace
        </h2>
        <div className="sd-actions">
          <UrlLink className="sd-button" href={`${marketplaceOrigin}/explore?type=skill`}>
            Open web marketplace
          </UrlLink>
          <button className="sd-button" type="button" onClick={openCurated}>
            Curated skills
          </button>
        </div>
      </header>
      <div className="sd-marketplace-filters">
        <label className="sd-marketplace-search">
          Search
          <input
            type="search"
            maxLength={80}
            value={filters.query}
            onChange={(event) => filter("query", event.target.value)}
            placeholder={filters.kind === "skill" ? "Find a skill" : "Search marketplace"}
          />
        </label>
        <label>
          Type
          <select value={filters.kind} onChange={(event) => filter("kind", event.target.value)}>
            <option value="">All types</option>
            <option value="skill">Skills</option>
            <option value="workflow">Workflows</option>
            <option value="connector">Connectors</option>
          </select>
        </label>
        <label>
          Category
          <select
            value={filters.category}
            onChange={(event) => filter("category", event.target.value)}
          >
            <option value="">All categories</option>
            {marketplaceCategories.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        </label>
        <label>
          Publisher
          <select
            value={filters.publisher}
            onChange={(event) => filter("publisher", event.target.value)}
          >
            <option value="">All publishers</option>
            {publishers.map((publisher) => (
              <option key={publisher}>{publisher}</option>
            ))}
          </select>
        </label>
      </div>
      {load.kind === "loading" ? (
        <p role="status">Loading marketplace…</p>
      ) : load.kind === "error" ? (
        <div role="alert">
          <p>The marketplace could not load.</p>
          <button
            className="sd-button"
            type="button"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <p className="sd-marketplace-meta" role="status">
            {matches.length} {matches.length === 1 ? "result" : "results"}
          </p>
          {pluginError && (!filters.kind || filters.kind === "connector") && (
            <p className="sd-marketplace-meta">
              Installed connector status is unavailable.{" "}
              <button
                className="sd-button"
                type="button"
                onClick={() => setReload((value) => value + 1)}
              >
                Retry
              </button>
            </p>
          )}
          {matches.length === 0 ? (
            <p>No matching items.</p>
          ) : (
            <div className="sd-marketplace-grid">
              {matches.slice(0, visible).map((item) => (
                <Item
                  key={item.detailPath}
                  item={item}
                  reviewedId={load.value.reviewedSkills[item.slug]}
                  plugin={
                    item.kind === "connector"
                      ? plugins.find((plugin) => plugin.id === item.pluginId)
                      : undefined
                  }
                  review={review}
                />
              ))}
            </div>
          )}
          {visible < matches.length && (
            <button
              type="button"
              className="sd-button"
              onClick={() => setVisible((current) => current + 36)}
            >
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
}
