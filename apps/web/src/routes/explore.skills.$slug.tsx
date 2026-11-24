import { createFileRoute, notFound } from "@tanstack/react-router";

import { ExploreSkillPage } from "../explore/ExploreSkillPage";
import exploreCss from "../explore/explore.css?url";
import { getExploreSkill } from "../explore/loaders";
import { pageMeta, siteHeadLinks } from "../landing/page-head";

export const Route = createFileRoute("/explore/skills/$slug")({
  headers: () => ({ "cache-control": "no-store" }),
  loader: async ({ params }) => {
    const detail = await getExploreSkill({ data: params.slug });

    if (!detail) throw notFound();

    return detail;
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: pageMeta(
            `${loaderData.item.title} · Omnyo Skill Pack`,
            loaderData.item.summary,
            loaderData.item.path,
          ),
          links: siteHeadLinks(exploreCss),
        }
      : {},
  component: SkillRoute,
});

function SkillRoute() {
  return <ExploreSkillPage {...Route.useLoaderData()} />;
}
