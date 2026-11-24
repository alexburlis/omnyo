import { createFileRoute } from "@tanstack/react-router";

import exploreCss from "../explore/explore.css?url";
import { PublicSkillsPage } from "../explore/PublicSkillsPage";
import { browsePublicSkills } from "../explore/public-skill-loaders";
import {
  publicSkillsPath,
  validatePublicSkillsSearch,
} from "../explore/public-skills";
import { pageMeta, siteHeadLinks } from "../landing/page-head";

export const Route = createFileRoute("/explore/skills/")({
  validateSearch: validatePublicSkillsSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => browsePublicSkills({ data: deps }),
  head: () => ({
    meta: pageMeta(
      "Skills · Omnyo Explore",
      "Search Omnyo’s source-linked skill catalog by category or publisher.",
      publicSkillsPath,
    ),
    links: siteHeadLinks(exploreCss),
  }),
  component: SkillsRoute,
});

function SkillsRoute() {
  return (
    <PublicSkillsPage {...Route.useLoaderData()} search={Route.useSearch()} />
  );
}
