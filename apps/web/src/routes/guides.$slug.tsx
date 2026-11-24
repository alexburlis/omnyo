import { createFileRoute } from "@tanstack/react-router";

import exploreCss from "../explore/explore.css?url";
import { getExploreRelated } from "../explore/loaders";
import { GuidePage } from "../guides/guide-page";
import { getGuide } from "../guides/guides";

export const Route = createFileRoute("/guides/$slug")({
  staticData: { ownsCanonical: true },
  loader: async ({ params }) => {
    const [data, related] = await Promise.all([
      import("../guides/guide-page").then((page) =>
        page.guideRouteData(params.slug),
      ),
      getExploreRelated({ data: { kind: "guide", slug: params.slug } }),
    ]);

    return { ...data, related };
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          ...loaderData.head,
          links: [
            ...loaderData.head.links,
            ...(loaderData.related.length
              ? [{ rel: "stylesheet", href: exploreCss }]
              : []),
          ],
        }
      : { meta: [{ title: "Omnyo" }] },
  component: GuidesRoute,
});

function GuidesRoute() {
  const { slug, related } = Route.useLoaderData();
  const guide = getGuide(slug);

  if (!guide) {
    throw new Error(`Guide ${slug} is not registered`);
  }

  return <GuidePage guide={guide} related={related} />;
}
