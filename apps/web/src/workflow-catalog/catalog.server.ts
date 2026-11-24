import { webcrypto } from "node:crypto";

import {
  workflowGalleryPath,
  workflowListingPath,
  type PublicWorkflowListing,
  type WorkflowListingSummary,
  type WorkflowReleaseSummary,
} from "./catalog";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const SHA256 = /^[a-f0-9]{64}$/u;

type WorkflowRelease = {
  summary: WorkflowReleaseSummary;
} & (
  | { state: "current" | "superseded"; canonical: string }
  | { state: "withdrawn" }
);

export interface CatalogEntry {
  state: "draft" | "published";
  position: number;
  listing: PublicWorkflowListing;
  releases: readonly WorkflowRelease[];
  previewPng: string;
}

function undiscoverable(status: number) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

export function createWorkflowCatalog(entries: readonly CatalogEntry[]) {
  const slugs = new Set<string>();
  const published = new Map<string, CatalogEntry>();

  const ordered = [...entries].sort(
    (left, right) =>
      left.position - right.position ||
      left.listing.title.localeCompare(right.listing.title, "en") ||
      left.listing.slug.localeCompare(right.listing.slug, "en"),
  );

  for (const entry of ordered) {
    const { slug } = entry.listing;

    if (!SLUG.test(slug) || slugs.has(slug))
      throw new Error(`Invalid or duplicate workflow catalog slug: ${slug}`);

    slugs.add(slug);

    const revisions = new Set<number>();
    const digests = new Set<string>();

    for (const { summary } of entry.releases) {
      const { revision, sha256 } = summary;

      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        revisions.has(revision) ||
        !SHA256.test(sha256) ||
        digests.has(sha256)
      )
        throw new Error(`Invalid or duplicate workflow release: ${slug}`);

      revisions.add(revision);
      digests.add(sha256);
    }

    if (entry.releases.filter(({ state }) => state === "current").length !== 1)
      throw new Error(`Expected one current workflow release: ${slug}`);

    if (entry.state === "published") published.set(slug, entry);
  }

  const listings: WorkflowListingSummary[] = [...published.values()].map(
    ({ listing }) => ({
      slug: listing.slug,
      title: listing.title,
      description: listing.description,
      category: listing.category,
      cadence: listing.cadence,
      outputSummary: listing.outputSummary,
      compatibility: listing.compatibility,
      week: { company: listing.preview.company, days: listing.preview.days },
    }),
  );

  const find = (slug: string) =>
    SLUG.test(slug) ? published.get(slug) : undefined;

  return {
    listings,
    sitemapPaths: listings.length
      ? [
          workflowGalleryPath,
          ...listings.map(({ slug }) => workflowListingPath(slug)),
        ]
      : [],
    detail(slug: string) {
      const entry = find(slug);
      const release = entry?.releases.find(({ state }) => state === "current");

      return entry && release
        ? { listing: entry.listing, release: release.summary }
        : undefined;
    },
    async attachment(slug: string, sha256: string) {
      const release = SHA256.test(sha256)
        ? find(slug)?.releases.find(({ summary }) => summary.sha256 === sha256)
        : undefined;

      if (!release) return undiscoverable(404);

      if (release.state === "withdrawn") return undiscoverable(410);

      const bytes = new TextEncoder().encode(release.canonical);
      const digest = await webcrypto.subtle.digest("SHA-256", bytes);

      if (Buffer.from(digest).toString("hex") !== sha256)
        return undiscoverable(500);

      return new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${slug}.omnyoworkflow"`,
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex",
          "cache-control": "no-store",
        },
      });
    },
    previewImage(slug: string) {
      const entry = find(slug);

      if (!entry) return undiscoverable(404);

      return new Response(
        Uint8Array.from(Buffer.from(entry.previewPng, "base64")),
        {
          headers: {
            "content-type": "image/png",
            "x-content-type-options": "nosniff",
            "x-robots-tag": "noindex",
            "cache-control": "no-store",
          },
        },
      );
    },
  };
}
