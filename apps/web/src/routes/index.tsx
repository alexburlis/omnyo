import bricolageWoff2 from "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2?url";
import geistWoff2 from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import { createFileRoute } from "@tanstack/react-router";

import { QUESTIONS } from "../lab/combined-a-v2/content";
import LandingPage from "../lab/combined-a-v2/page";
import { getPublicMacDownload } from "../landing/mac-download";
import { pageMeta } from "../landing/page-head";
import { SITE_URL } from "../landing/site";

const PAGE_TITLE = "Omnyo: run Claude Code and Codex side by side";

const PAGE_DESCRIPTION =
  "Omnyo is a free app that runs Claude Code and Codex side by side on your own machines. See which agent needs you, check its work and steer it from your phone.";

const structuredData = () =>
  JSON.stringify([
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Omnyo",
      url: `${SITE_URL}/`,
      description: PAGE_DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Windows, iOS",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: QUESTIONS.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: { "@type": "Answer", text: entry.answer },
      })),
    },
  ]).replace(/</g, "\\u003c");

const fontPreload = (href: string) => ({
  rel: "preload",
  href,
  as: "font",
  type: "font/woff2",
  crossOrigin: "anonymous" as const,
});

export const Route = createFileRoute("/")({
  loader: () => getPublicMacDownload(),
  head: () => ({
    meta: pageMeta(PAGE_TITLE, PAGE_DESCRIPTION, "/"),
    links: [fontPreload(bricolageWoff2), fontPreload(geistWoff2)],
    scripts: [{ type: "application/ld+json", children: structuredData() }],
  }),
  component: LandingRoute,
});

function LandingRoute() {
  return <LandingPage macDownload={Route.useLoaderData()} />;
}
