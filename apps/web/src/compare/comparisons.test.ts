import { Fragment, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { featureMetas } from "../features/features";
import { guideSlugs, internalLinks, isServed } from "../landing/internal-links";
import { comparisonHead } from "./comparison-head";
import { cite } from "./comparison-page";
import type { ComparisonBody, ComparisonMeta } from "./comparison-types";
import { comparisonMetas, loadComparisonBody } from "./comparisons";

const META_FILES = import.meta.glob<{ meta: ComparisonMeta }>(
  "./pages/*.meta.ts",
  { eager: true },
);

const VISUAL_FILES = Object.keys(
  import.meta.glob("../features/visuals/*.visual.tsx"),
);

const visuals = new Set(
  VISUAL_FILES.map((path) =>
    path.slice("../features/visuals/".length, -".visual.tsx".length),
  ),
);

const featureSlugs = new Set(featureMetas().map((meta) => meta.slug));

const CITATION = /\[\^(\d+)\]/g;

const sectionTexts = (body: ComparisonBody) =>
  [...body.sections, ...body.together.sections].flatMap((section) => [
    ...section.paragraphs,
    ...section.bullets,
  ]);

const textsOf = (body: ComparisonBody) => [
  body.lede,
  body.tablesLede,
  body.together.lede,
  ...body.points.map((point) => point.body),
  ...body.tables.flatMap((table) =>
    table.rows.flatMap((row) => [row.left, row.right]),
  ),
  ...sectionTexts(body),
  ...body.picks.flatMap((pick) => pick.items),
  ...body.faq.map((entry) => entry.answer),
];

async function pages() {
  const loaded = await Promise.all(
    comparisonMetas().map(async (meta) => ({
      meta,
      body: await loadComparisonBody(meta.slug),
    })),
  );

  return loaded.flatMap(({ meta, body }) => (body ? [{ meta, body }] : []));
}

describe("comparison registry", () => {
  it("names every page file after its slug and loads a body for each", async () => {
    for (const [path, module] of Object.entries(META_FILES)) {
      expect(path).toBe(`./pages/${module.meta.slug}.meta.ts`);
    }

    expect(await pages()).toHaveLength(comparisonMetas().length);
  });

  it("keeps search titles, descriptions and the checked date valid", () => {
    for (const meta of comparisonMetas()) {
      expect(meta.seoTitle.length, meta.slug).toBeLessThanOrEqual(60);
      expect(meta.seoDescription.length, meta.slug).toBeLessThanOrEqual(160);
      expect(meta.seoDescription.length, meta.slug).toBeGreaterThanOrEqual(110);
      expect(meta.checkedOn, meta.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(
        new Date(`${meta.checkedOn}T00:00:00Z`).toISOString().slice(0, 10),
        meta.slug,
      ).toBe(meta.checkedOn);
    }
  });

  it("cites only listed sources and cites every listed source", async () => {
    for (const { meta, body } of await pages()) {
      const cited = new Set(
        textsOf(body).flatMap((text) =>
          [...text.matchAll(CITATION)].map((match) => Number(match[1])),
        ),
      );

      for (const number of cited) {
        expect(
          body.sources[number - 1],
          `${meta.slug} cites source ${number}`,
        ).toBeDefined();
      }

      body.sources.forEach((source, index) => {
        expect(
          cited.has(index + 1),
          `${meta.slug} never cites ${source.url}`,
        ).toBe(true);
        expect(source.url, meta.slug).toMatch(/^https:\/\//u);
      });

      expect(new Set(body.sources.map((source) => source.url)).size).toBe(
        body.sources.length,
      );
    }
  });

  it("fills both sides of every row and backs each with a source", async () => {
    for (const { meta, body } of await pages()) {
      for (const row of body.tables.flatMap((table) => table.rows)) {
        for (const cell of [row.left, row.right]) {
          expect(cell.trim(), `${meta.slug} row ${row.label}`).not.toBe("");
          expect(cell, `${meta.slug} row ${row.label}`).toMatch(CITATION);
        }
      }
    }
  });

  it("links only pages, mock-ups and guides that exist", async () => {
    for (const { meta, body } of await pages()) {
      expect(body.points, meta.slug).toHaveLength(3);
      expect(body.picks, meta.slug).toHaveLength(3);
      expect(body.faq.length, meta.slug).toBeGreaterThanOrEqual(3);

      const sectionVisuals = [...body.sections, ...body.together.sections]
        .map((section) => section.visual)
        .filter((visual) => visual !== null);

      for (const visual of [body.together.visual, ...sectionVisuals]) {
        expect(visuals.has(visual), `${meta.slug} visual ${visual}`).toBe(true);
      }

      for (const slug of body.relatedFeatures) {
        expect(featureSlugs.has(slug), `${meta.slug} relates to ${slug}`).toBe(
          true,
        );
      }

      for (const guide of body.relatedGuides) {
        expect(guideSlugs.has(guide.slug), `${meta.slug} guide`).toBe(true);
      }

      for (const href of textsOf(body).flatMap(internalLinks)) {
        expect(isServed(href), `${meta.slug} links ${href}`).toBe(true);
      }
    }
  });

  it("keeps citation markers, link and code syntax out of the structured data", async () => {
    for (const { meta, body } of await pages()) {
      const [script] = comparisonHead(meta, body).scripts;

      expect(script?.children, meta.slug).not.toMatch(/\[\^|\]\(|`/u);
    }
  });

  it("joins neighbouring citations into one superscript with separators", () => {
    const html = renderToStaticMarkup(
      createElement(Fragment, null, cite("One.[^1][^12] Two.[^3]")),
    );

    expect(html).toBe(
      'One.<sup class="vs-cite"><a href="#source-1" aria-label="Source 1">1</a>, <a href="#source-12" aria-label="Source 12">12</a></sup> Two.<sup class="vs-cite"><a href="#source-3" aria-label="Source 3">3</a></sup>',
    );
  });
});
