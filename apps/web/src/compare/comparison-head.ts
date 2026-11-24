import { faqJsonLd } from "../features/feature-head";
import { pageMeta } from "../landing/page-head";
import type { ComparisonBody, ComparisonMeta } from "./comparison-types";
import { comparisonPath } from "./comparisons";

export const CITATION = /\[\^(\d+)\]/g;

export const uncited = (text: string) => text.replace(CITATION, "");

export function comparisonHead(meta: ComparisonMeta, body: ComparisonBody) {
  return {
    meta: pageMeta(
      meta.seoTitle,
      meta.seoDescription,
      comparisonPath(meta.slug),
    ),
    scripts: [
      {
        type: "application/ld+json",
        children: faqJsonLd(
          body.faq.map((entry) => ({
            question: entry.question,
            answer: uncited(entry.answer),
          })),
        ),
      },
    ],
  };
}
