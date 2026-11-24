import { comparisonPaths } from "../compare/comparisons.js";
import { featurePaths } from "../features/features.js";
import { exploreCatalog } from "../explore/entries.server.js";
import { marketplaceConnectors } from "../explore/marketplace.server.js";
import { publicSkills } from "../explore/public-skill-catalog.server.js";
import { publicSkillsPath } from "../explore/public-skills.js";
import { contentPaths } from "../landing/content-links.js";
import { workflowCatalog } from "../workflow-catalog/entries.server.js";

export const sitemapPaths = () => [
  ...featurePaths(),
  ...comparisonPaths(),
  ...contentPaths(),
  ...workflowCatalog.sitemapPaths,
  ...exploreCatalog.sitemapPaths,
  ...marketplaceConnectors.map(({ detailPath }) => detailPath),
  publicSkillsPath,
  ...publicSkills
    .filter((skill) => skill.source === "omnyo")
    .map((skill) => skill.detailPath),
];

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

export function sitemapXml(
  origin: string,
  contentPaths: readonly string[],
): string {
  const paths = [
    "/",
    "/plugin-guide",
    "/privacy",
    "/cookies",
    "/terms",
    "/imprint",
    "/abuse",
    ...contentPaths,
  ];

  const urls = paths
    .map((path) => `  <url><loc>${escapeXml(`${origin}${path}`)}</loc></url>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
