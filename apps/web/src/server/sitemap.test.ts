import { describe, expect, it } from "vitest";

import { sitemapPaths, sitemapXml } from "./sitemap.js";

const PAGE_FILES = Object.keys(
  import.meta.glob([
    "../features/pages/*.meta.ts",
    "../compare/pages/*.meta.ts",
  ]),
);

describe("sitemapXml", () => {
  it("lists the public pages and the given guide paths", () => {
    const xml = sitemapXml("https://example.test", ["/guides/a&b"]);

    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );

    for (const path of [
      "/",
      "/plugin-guide",
      "/privacy",
      "/cookies",
      "/terms",
      "/imprint",
      "/abuse",
      "/guides/a&amp;b",
    ]) {
      expect(xml).toContain(`<loc>https://example.test${path}</loc>`);
    }

    for (const dropped of [
      "/blog",
      "/changelog",
      "/compare",
      "/marketplace",
      "/dashboard",
      "/brand",
      "/uninstall",
    ]) {
      expect(xml).not.toContain(dropped);
    }
  });

  it("lists every feature and comparison page file once", () => {
    const xml = sitemapXml("https://example.test", sitemapPaths());

    expect(PAGE_FILES.length).toBeGreaterThan(0);

    for (const file of PAGE_FILES) {
      const [, area, , name] = file.split("/");
      const loc = `<loc>https://example.test/${area}/${name?.slice(0, -".meta.ts".length)}</loc>`;

      expect(xml.split(loc), file).toHaveLength(2);
    }
  });
});
