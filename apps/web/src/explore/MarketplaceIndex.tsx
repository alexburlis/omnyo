import { useRef, useState } from "react";
import { sendSiteUsage } from "../analytics/usage";

import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { explorePath } from "./catalog";
import {
  isAuxiliaryExploreKind,
  type MarketplaceItem,
  type MarketplaceSearch,
} from "./marketplace";
import { isOmnyoEdition, marketplaceItemKey } from "./marketplace-view";
import { MarketplaceDirectory } from "./MarketplaceDirectory";
import {
  CatalogWall,
  CategoryCards,
  FeaturedBento,
  MarketplaceBand,
  MarketplaceHero,
  MarketplaceStats,
} from "./MarketplaceStorefront";

export function MarketplaceIndex({
  items,
  search,
}: {
  items: readonly MarketplaceItem[];
  search: MarketplaceSearch;
}) {
  const [filters, setFilters] = useState<MarketplaceSearch>(() =>
    isAuxiliaryExploreKind(search.type)
      ? { ...search, type: undefined }
      : search,
  );

  const [selectedKey, setSelectedKey] = useState(() => {
    const first = items.find(isOmnyoEdition) ?? items[0];

    return first ? marketplaceItemKey(first) : undefined;
  });

  const [sheetOpen, setSheetOpen] = useState(false);
  const directory = useRef<HTMLDivElement>(null);

  const selected = items.find(
    (item) => marketplaceItemKey(item) === selectedKey,
  );

  function showDirectory() {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    directory.current?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
  }

  function applyFilters(next: MarketplaceSearch, scroll = true) {
    setFilters(next);

    if (scroll) showDirectory();
  }

  function pick(item: MarketplaceItem, scroll = true) {
    sendSiteUsage({ name: "listing_open", kind: item.kind });
    setSelectedKey(marketplaceItemKey(item));
    setSheetOpen(true);

    if (scroll) showDirectory();
  }

  return (
    <>
      <SiteNav current="explore" path={explorePath} />
      <main id="main-content" className="mk">
        <MarketplaceHero
          items={items}
          onApply={(q) => applyFilters({ q: q || undefined })}
          onPick={(item) => pick(item)}
        />
        <CatalogWall items={items} onPick={(item) => pick(item)} />
        <div className="mk-body">
          <MarketplaceStats items={items} />
          <FeaturedBento
            items={items}
            onFilter={(next) => applyFilters(next)}
          />
          <CategoryCards
            items={items}
            current={filters.category}
            onFilter={(next) =>
              applyFilters({ ...filters, ...next, page: undefined })
            }
          />
          <div ref={directory} className="mk-anchor">
            <MarketplaceDirectory
              items={items}
              filters={filters}
              onChange={(next) => applyFilters(next, false)}
              selected={selected}
              onSelect={(item) => pick(item, false)}
              sheetOpen={sheetOpen}
              onCloseSheet={() => setSheetOpen(false)}
            />
          </div>
          <nav className="mk-resources" aria-label="More Explore resources">
            <span>Also in Explore</span>
            <a href="/explore?type=prompt">Prompts</a>
            <a href="/explore?type=guide">Guides</a>
            <a href="/explore?type=plugin">Plugins</a>
          </nav>
        </div>
        <MarketplaceBand />
      </main>
      <SiteFooter current={explorePath} />
    </>
  );
}
