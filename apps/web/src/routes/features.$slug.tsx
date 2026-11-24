import { createFileRoute, notFound } from "@tanstack/react-router";

import { featureHead } from "../features/feature-head";
import { FeaturePage } from "../features/feature-page";
import { getFeatureMeta, loadFeatureBody } from "../features/features";

export const Route = createFileRoute("/features/$slug")({
  loader: async ({ params }) => {
    const meta = getFeatureMeta(params.slug);
    const body = meta ? await loadFeatureBody(params.slug) : undefined;

    if (!meta || !body) throw notFound();

    return { meta, body };
  },
  head: ({ loaderData }) =>
    loaderData
      ? featureHead(loaderData.meta, loaderData.body)
      : { meta: [{ title: "Omnyo" }] },
  component: FeatureRoute,
});

function FeatureRoute() {
  const { meta, body } = Route.useLoaderData();

  return <FeaturePage meta={meta} body={body} />;
}
