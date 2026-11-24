import { comparisonPaths } from "../compare/comparisons";
import { featurePaths } from "../features/features";

const GUIDE_FILES = Object.keys(import.meta.glob("../guides/pages/*.meta.ts"));

export const guideSlugs = new Set(
  GUIDE_FILES.map((path) =>
    path.slice("../guides/pages/".length, -".meta.ts".length),
  ),
);

const SERVED = new Set([
  "/",
  "/privacy",
  "/terms",
  "/imprint",
  "/plugin-guide",
  ...featurePaths(),
  ...comparisonPaths(),
  ...[...guideSlugs].map((slug) => `/guides/${slug}`),
]);

const INTERNAL_LINK = /\]\((\/[^)\s]*)\)/g;

export const internalLinks = (text: string) =>
  [...text.matchAll(INTERNAL_LINK)].map((match) => match[1] ?? "");

export const isServed = (href: string) => SERVED.has(href.split("#")[0] ?? "");
