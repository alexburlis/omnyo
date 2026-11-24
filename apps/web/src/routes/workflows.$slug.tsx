import { createFileRoute, notFound } from "@tanstack/react-router";

import exploreCss from "../explore/explore.css?url";
import { getExploreRelated } from "../explore/loaders";
import { siteHeadLinks } from "../landing/page-head";
import { unfurlMeta } from "../landing/site";
import { WorkflowListing } from "../workflow-catalog/WorkflowListing";
import {
  workflowListingPath,
  workflowPreviewPath,
} from "../workflow-catalog/catalog";
import { getPublishedWorkflow } from "../workflow-catalog/loaders";
import workflowCss from "../workflow-catalog/workflow-pages.css?url";

export const Route = createFileRoute("/workflows/$slug")({
  headers: () => ({ "cache-control": "no-store" }),
  loader: async ({ params }) => {
    const [detail, related] = await Promise.all([
      getPublishedWorkflow({ data: params.slug }),
      getExploreRelated({ data: { kind: "workflow", slug: params.slug } }),
    ]);

    if (!detail) throw notFound();

    return { ...detail, related };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};

    const { listing } = loaderData;
    const title = `${listing.title} · Omnyo Workflows`;
    const path = workflowListingPath(listing.slug);

    return {
      meta: [
        { title },
        { name: "description", content: listing.description },
        ...unfurlMeta(title, listing.description, path, {
          ...listing.openGraph,
          path: workflowPreviewPath(listing.slug),
        }),
      ],
      links: siteHeadLinks(
        workflowCss,
        ...(loaderData.related.length ? [exploreCss] : []),
      ),
    };
  },
  component: ListingRoute,
});

function ListingRoute() {
  return <WorkflowListing {...Route.useLoaderData()} />;
}
