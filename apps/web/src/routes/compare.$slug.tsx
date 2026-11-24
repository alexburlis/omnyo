import { createFileRoute, notFound } from "@tanstack/react-router";

import { comparisonHead } from "../compare/comparison-head";
import { ComparisonPage } from "../compare/comparison-page";
import { getComparisonMeta, loadComparisonBody } from "../compare/comparisons";

export const Route = createFileRoute("/compare/$slug")({
  loader: async ({ params }) => {
    const meta = getComparisonMeta(params.slug);
    const body = meta ? await loadComparisonBody(params.slug) : undefined;

    if (!meta || !body) throw notFound();

    return { meta, body };
  },
  head: ({ loaderData }) =>
    loaderData
      ? comparisonHead(loaderData.meta, loaderData.body)
      : { meta: [{ title: "Omnyo" }] },
  component: ComparisonRoute,
});

function ComparisonRoute() {
  const { meta, body } = Route.useLoaderData();

  return <ComparisonPage meta={meta} body={body} />;
}
