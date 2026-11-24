import { createFileRoute, notFound } from "@tanstack/react-router";

import { ExplorePluginPage } from "../explore/ExplorePluginPage";
import exploreCss from "../explore/explore.css?url";
import { getExplorePlugin } from "../explore/loaders";
import marketplaceCss from "../explore/marketplace.css?url";
import { loadMarketplaceDetail } from "../explore/marketplace-loaders";
import { MarketplaceDetailPage } from "../explore/MarketplaceDetailPage";
import { pageMeta, siteHeadLinks } from "../landing/page-head";

export const Route = createFileRoute("/explore/plugins/$slug")({
  headers: () => ({ "cache-control": "no-store" }),
  loader: async ({ params }) => {
    const [connector, detail] = await Promise.all([
      loadMarketplaceDetail({ data: { kind: "connector", slug: params.slug } }),
      getExplorePlugin({ data: params.slug }),
    ]);

    if (connector) return { kind: "connector", connector } as const;

    if (!detail) throw notFound();

    return { kind: "plugin", detail } as const;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};

    if (loaderData.kind === "connector") {
      const { title, summary, detailPath } = loaderData.connector.item;

      return {
        meta: pageMeta(`${title} · Omnyo Connector`, summary ?? "", detailPath),
        links: siteHeadLinks(exploreCss, marketplaceCss),
      };
    }

    const { title, summary, path } = loaderData.detail.item;

    return {
      meta: pageMeta(`${title} · Omnyo Plugin`, summary ?? "", path),
      links: siteHeadLinks(exploreCss),
    };
  },
  component: PluginRoute,
});

function PluginRoute() {
  const data = Route.useLoaderData();

  return data.kind === "connector" ? (
    <MarketplaceDetailPage {...data.connector} />
  ) : (
    <ExplorePluginPage {...data.detail} />
  );
}
