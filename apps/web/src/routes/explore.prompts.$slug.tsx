import { createFileRoute, notFound } from "@tanstack/react-router";

import { ExplorePromptPage } from "../explore/ExplorePromptPage";
import exploreCss from "../explore/explore.css?url";
import { getExplorePrompt } from "../explore/loaders";
import { pageMeta, siteHeadLinks } from "../landing/page-head";

export const Route = createFileRoute("/explore/prompts/$slug")({
  headers: () => ({ "cache-control": "no-store" }),
  loader: async ({ params }) => {
    const detail = await getExplorePrompt({ data: params.slug });

    if (!detail) throw notFound();

    return detail;
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: pageMeta(
            `${loaderData.item.title} · Omnyo Prompt`,
            loaderData.item.summary,
            loaderData.item.path,
          ),
          links: siteHeadLinks(exploreCss),
        }
      : {},
  component: PromptRoute,
});

function PromptRoute() {
  return <ExplorePromptPage {...Route.useLoaderData()} />;
}
