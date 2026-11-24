import { createFileRoute, notFound } from "@tanstack/react-router";
import { type ComponentType, useEffect, useState } from "react";

import { LAB_DESIGNS } from "../lab/designs";
import { requireLabPreview } from "../lab/lab-access";

export const Route = createFileRoute("/lab/$design")({
  beforeLoad: requireLabPreview,
  loader: ({ params }) => {
    const design = LAB_DESIGNS.find((entry) => entry.slug === params.design);

    if (!design) throw notFound();

    return { slug: design.slug, title: design.title };
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.title ?? "Lab"} · Omnyo landing lab` },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LabDesignRoute,
});

function LabDesignRoute() {
  const { slug } = Route.useLoaderData();
  const [Page, setPage] = useState<ComponentType | null>(null);

  useEffect(() => {
    const design = LAB_DESIGNS.find((entry) => entry.slug === slug);

    if (!design) return;
    let cancelled = false;

    void design.load().then((module) => {
      if (!cancelled) setPage(() => module.default);
    });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  return Page ? <Page /> : <div style={{ minHeight: "100vh" }} />;
}
