import { createFileRoute, notFound } from "@tanstack/react-router";

import exploreCss from "../explore/explore.css?url";
import marketplaceCss from "../explore/marketplace.css?url";
import { loadMarketplaceDetail } from "../explore/marketplace-loaders";
import { MarketplaceDetailPage } from "../explore/MarketplaceDetailPage";
import { pageMeta, siteHeadLinks } from "../landing/page-head";

export const Route = createFileRoute("/explore/skills/source/$slug")({
  loader: async ({ params }) => {
    const detail = await loadMarketplaceDetail({
      data: { kind: "skill", slug: params.slug },
    });

    if (!detail) throw notFound();

    return detail;
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: pageMeta(
            `${loaderData.item.title} · Omnyo Marketplace`,
            loaderData.item.summary ??
              `${loaderData.item.title} by ${loaderData.item.publisher}. Install it in Omnyo or read the screened source.`,
            loaderData.item.detailPath,
          ),
          links: siteHeadLinks(exploreCss, marketplaceCss),
        }
      : {},
  component: SkillRoute,
});

function SkillRoute() {
  return <MarketplaceDetailPage {...Route.useLoaderData()} />;
}
