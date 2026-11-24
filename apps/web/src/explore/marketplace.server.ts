import {
  workflowCompatibilityLine,
  workflowListingPath,
} from "../workflow-catalog/catalog";
import { workflowCatalog } from "../workflow-catalog/entries.server";
import { exploreActivation } from "./activation.server";
import { explorePluginPath } from "./catalog";
import type {
  MarketplaceConnector,
  MarketplaceItem,
  MarketplaceWorkflow,
} from "./marketplace";
import { publicSkills } from "./public-skill-catalog.server";

const connectorDefinitions = [
  {
    pluginId: "workspace-github",
    title: "GitHub",
    summary:
      "Browse and review GitHub issues and pull requests from your Omnyo projects.",
    category: "Product & teamwork",
    keywords: ["issues", "pull requests", "code review", "repositories"],
    service: "GitHub",
    requirements:
      "Use an existing GitHub CLI sign-in with access to your repositories. Find Workspace GitHub in Omnyo’s plugin settings.",
    availability: "Available through the Workspace GitHub plugin.",
  },
  {
    pluginId: "sentry",
    title: "Sentry",
    summary:
      "Review errors from your Sentry projects and start an investigation in Omnyo.",
    category: "Testing & security",
    keywords: ["errors", "monitoring", "triage", "incidents"],
    service: "Sentry",
    requirements:
      "In Sentry’s plugin settings, select your data region and enter an existing token with org:read, project:read, and event:read access. Then choose the projects you want to watch.",
    availability: "Available through the Sentry plugin.",
  },
] satisfies Omit<
  MarketplaceConnector,
  "kind" | "slug" | "publisher" | "detailPath"
>[];

export const marketplaceConnectors: readonly MarketplaceConnector[] =
  exploreActivation === "active"
    ? connectorDefinitions.map((connector) => ({
        ...connector,
        kind: "connector",
        slug: connector.pluginId,
        publisher: "Omnyo",
        detailPath: explorePluginPath(connector.pluginId),
      }))
    : [];

const workflows: MarketplaceWorkflow[] = workflowCatalog.listings.map(
  ({ slug }) => {
    const detail = workflowCatalog.detail(slug);

    if (!detail) throw new Error(`Missing Marketplace workflow: ${slug}`);
    const { listing, release } = detail;

    return {
      kind: "workflow",
      slug,
      title: listing.title,
      summary: listing.description,
      publisher: "Omnyo",
      category: "Agent workflows",
      keywords: [
        listing.category,
        listing.cadence,
        "review",
        ...release.capabilities,
      ],
      detailPath: workflowListingPath(slug),
      sha256: release.sha256,
      requirements: workflowCompatibilityLine(listing.compatibility),
    };
  },
);

export const marketplaceItems: readonly MarketplaceItem[] =
  exploreActivation === "active"
    ? [
        ...workflows,
        ...marketplaceConnectors,
        ...publicSkills.map((skill) => ({ ...skill, kind: "skill" as const })),
      ]
    : [];

const payload = JSON.stringify({ schemaVersion: 1, items: marketplaceItems });

const legacyPayload = JSON.stringify({
  schemaVersion: 1,
  items: marketplaceItems.filter(
    (item) => item.kind !== "skill" || item.setupUrl === undefined,
  ),
});

if (
  marketplaceItems.length > 1024 ||
  new TextEncoder().encode(payload).byteLength > 1024 * 1024 ||
  new Set(marketplaceItems.map(({ detailPath }) => detailPath)).size !==
    marketplaceItems.length
)
  throw new Error(
    "Invalid Marketplace catalog bounds or duplicate detail paths.",
  );

export function marketplaceResponse(includeProviderSetup = false) {
  if (exploreActivation === "inactive")
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
    });

  return new Response(includeProviderSetup ? payload : legacyPayload, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
