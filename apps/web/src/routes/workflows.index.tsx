import { createFileRoute, notFound } from "@tanstack/react-router";

import { pageMeta, siteHeadLinks } from "../landing/page-head";
import { WorkflowGallery } from "../workflow-catalog/WorkflowGallery";
import { workflowGalleryPath } from "../workflow-catalog/catalog";
import { listPublishedWorkflows } from "../workflow-catalog/loaders";
import workflowCss from "../workflow-catalog/workflow-pages.css?url";

export const Route = createFileRoute("/workflows/")({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.category === "string" ? { category: search.category } : {},
  headers: () => ({ "cache-control": "no-store" }),
  loader: async () => {
    const listings = await listPublishedWorkflows();

    if (!listings.length) throw notFound();

    return listings;
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: pageMeta(
            "Explore Workflows · Omnyo",
            "Browse editable Omnyo workflows and see examples of what they produce.",
            workflowGalleryPath,
          ),
          links: siteHeadLinks(workflowCss),
        }
      : {},
  component: GalleryRoute,
});

function GalleryRoute() {
  const listings = Route.useLoaderData();
  const { category } = Route.useSearch();

  return <WorkflowGallery listings={listings} category={category} />;
}
