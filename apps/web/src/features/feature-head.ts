import { pageMeta } from "../landing/page-head";
import type {
  FeatureMeta,
  FeaturePageBody,
  FeatureQuestion,
} from "./feature-types";

export const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;

const plain = (text: string) =>
  text.replace(
    INLINE,
    (_match, label?: string, _href?: string, code?: string) =>
      label ?? code ?? "",
  );

export function faqJsonLd(faq: readonly FeatureQuestion[]) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: plain(entry.answer) },
    })),
  }).replace(/</g, "\\u003c");
}

export function featureHead(meta: FeatureMeta, body: FeaturePageBody) {
  return {
    meta: pageMeta(
      meta.seoTitle,
      meta.seoDescription,
      `/features/${meta.slug}`,
    ),
    scripts: [{ type: "application/ld+json", children: faqJsonLd(body.faq) }],
  };
}
