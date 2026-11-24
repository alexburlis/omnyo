import { createFileRoute } from "@tanstack/react-router";

import { sitemapPaths, sitemapXml } from "../server/sitemap.js";

declare const __SITE_ORIGIN__: string;

function serveSitemap(): Response {
  return new Response(sitemapXml(__SITE_ORIGIN__, sitemapPaths()), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export const Route = createFileRoute("/sitemap.xml")({
  server: { handlers: { GET: serveSitemap, HEAD: serveSitemap } },
});
