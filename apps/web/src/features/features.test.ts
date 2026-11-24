import { describe, expect, it } from "vitest";

import {
  guideSlugs as guides,
  internalLinks,
  isServed,
} from "../landing/internal-links";
import { TOPIC_GUIDES, SWITCH_GUIDES } from "../landing/site-links";
import type { FeatureMeta, FeaturePageBody } from "./feature-types";
import { featureMetas, loadFeatureBody } from "./features";

const META_FILES = import.meta.glob<{ meta: FeatureMeta }>(
  "./pages/*.meta.ts",
  { eager: true },
);

const VISUAL_FILES = Object.keys(import.meta.glob("./visuals/*.visual.tsx"));

const visuals = new Set(
  VISUAL_FILES.map((path) =>
    path.slice("./visuals/".length, -".visual.tsx".length),
  ),
);

const slugs = new Set(featureMetas().map((meta) => meta.slug));

const textsOf = (body: FeaturePageBody) => [
  body.lede,
  ...body.sections.flatMap((section) => [section.body, ...section.bullets]),
  ...body.goodToKnow.map((fact) => fact.value),
  ...body.faq.map((entry) => entry.answer),
];

describe("feature registry", () => {
  it("names every page file after its slug", () => {
    for (const [path, module] of Object.entries(META_FILES)) {
      expect(path).toBe(`./pages/${module.meta.slug}.meta.ts`);
    }
  });

  it("keeps search titles and descriptions inside their limits", () => {
    for (const meta of featureMetas()) {
      expect(meta.seoTitle.length, meta.slug).toBeLessThanOrEqual(60);
      expect(meta.seoDescription.length, meta.slug).toBeLessThanOrEqual(160);
      expect(meta.seoDescription.length, meta.slug).toBeGreaterThanOrEqual(110);
      expect(meta.tagline.length, meta.slug).toBeLessThanOrEqual(80);
    }
  });

  it("gives every page a body whose mock-ups and links exist", async () => {
    for (const meta of featureMetas()) {
      const body = await loadFeatureBody(meta.slug);

      expect(body, meta.slug).toBeDefined();

      if (!body) continue;

      expect(visuals.has(meta.visual), `${meta.slug} visual`).toBe(true);
      expect(body.sections.length, meta.slug).toBeGreaterThanOrEqual(2);
      expect(body.sections.length, meta.slug).toBeLessThanOrEqual(4);
      expect(body.faq.length, meta.slug).toBeGreaterThanOrEqual(3);
      expect(body.relatedFeatures, meta.slug).not.toContain(meta.slug);

      for (const section of body.sections) {
        expect(visuals.has(section.visual), `${meta.slug} section visual`).toBe(
          true,
        );
      }

      for (const fact of body.goodToKnow) {
        expect(fact.label.trim(), `${meta.slug} fact label`).not.toBe("");
      }

      for (const slug of body.relatedFeatures) {
        expect(slugs.has(slug), `${meta.slug} relates to ${slug}`).toBe(true);
      }

      for (const guide of body.relatedGuides) {
        expect(guides.has(guide.slug), `${meta.slug} guide ${guide.slug}`).toBe(
          true,
        );
      }

      for (const href of textsOf(body).flatMap(internalLinks)) {
        expect(isServed(href), `${meta.slug} links ${href}`).toBe(true);
      }
    }
  });

  it("links only guides that exist from the shared footer lists", () => {
    for (const guide of [...TOPIC_GUIDES, ...SWITCH_GUIDES]) {
      expect(guides.has(guide.slug), guide.slug).toBe(true);
    }
  });
});
