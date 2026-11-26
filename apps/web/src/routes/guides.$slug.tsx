import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense, use } from "react";

import exploreCss from "../explore/explore.css?url";
import { getExploreRelated } from "../explore/loaders";
import { GuidePage, guideHead } from "../guides/guide-page";
import type { Guide } from "../guides/guide-types";

const guideModules = import.meta.glob<Guide>("../guides/pages/*.tsx", {
  import: "guide",
});

const pendingGuides = new Map<string, Promise<Guide>>();

function loadGuide(slug: string) {
  const load = guideModules[`../guides/pages/${slug}.tsx`];

  if (!load) throw notFound();

  let pending = pendingGuides.get(slug);

  if (!pending) {
    pending = load();
    pendingGuides.set(slug, pending);
    void pending.catch(() => pendingGuides.delete(slug));
  }

  return pending;
}

export const Route = createFileRoute("/guides/$slug")({
  staticData: { ownsCanonical: true },
  loader: async ({ params }) => {
    const [guide, related] = await Promise.all([
      loadGuide(params.slug),
      getExploreRelated({ data: { kind: "guide", slug: params.slug } }),
    ]);

    return { slug: guide.slug, head: guideHead(guide), related };
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
  return (
    <Suspense>
      <GuideBody />
    </Suspense>
  );
}

function GuideBody() {
  const { slug, related } = Route.useLoaderData();

  return <GuidePage guide={use(loadGuide(slug))} related={related} />;
}
