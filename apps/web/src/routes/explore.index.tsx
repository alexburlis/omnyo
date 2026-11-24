import { createFileRoute, notFound } from "@tanstack/react-router";

import { explorePath } from "../explore/catalog";
import exploreCss from "../explore/explore.css?url";
import { ExploreIndex } from "../explore/ExploreIndex";
import { listExploreItems } from "../explore/loaders";
import {
  isAuxiliaryExploreKind,
  marketplaceHref,
  validateMarketplaceSearch,
} from "../explore/marketplace";
import marketplaceCss from "../explore/marketplace.css?url";
import { loadMarketplace } from "../explore/marketplace-loaders";
import { MarketplaceIndex } from "../explore/MarketplaceIndex";
import { pageMeta, siteHeadLinks } from "../landing/page-head";

export const Route = createFileRoute("/explore/")({
  validateSearch: validateMarketplaceSearch,
  loaderDeps: ({ search }) => ({
    auxiliary: isAuxiliaryExploreKind(search.type),
  }),
  headers: () => ({ "cache-control": "no-store" }),
  loader: async ({ deps: { auxiliary } }) => {
    if (auxiliary) {
      const items = await listExploreItems();

      if (!items.length) throw notFound();

      return { mode: "auxiliary", items } as const;
    }

    const items = await loadMarketplace();

    if (!items.length) throw notFound();

    return { mode: "marketplace", items } as const;
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: pageMeta(
            "Explore the Omnyo Marketplace",
            "Find curated skills, workflows, and connectors for Omnyo.",
            explorePath,
          ),
          links:
            loaderData.mode === "marketplace"
              ? siteHeadLinks(exploreCss, marketplaceCss)
              : siteHeadLinks(exploreCss),
        }
      : {},
  component: ExploreRoute,
});

function ExploreRoute() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();

  if (data.mode === "auxiliary")
    return (
      <ExploreIndex
        items={data.items}
        search={{
          q: search.q,
          type: isAuxiliaryExploreKind(search.type) ? search.type : undefined,
        }}
      />
    );

  return (
    <MarketplaceIndex
      key={marketplaceHref(search)}
      items={data.items}
      search={search}
    />
  );
}
