import { SITE_URL } from "../landing/site";
import type { WorkflowPreview } from "./weekly-content-feed-preview";

export const workflowGalleryPath = "/workflows";

export const workflowListingPath = (slug: string) =>
  `${workflowGalleryPath}/${slug}`;

export const canonicalWorkflowListingUrl = (slug: string) =>
  `${SITE_URL}${workflowListingPath(slug)}`;

export const workflowAttachmentPath = (slug: string, sha256: string) =>
  `${workflowListingPath(slug)}/file/${sha256}`;

export const workflowPreviewPath = (slug: string) =>
  `${workflowListingPath(slug)}/preview.png`;

interface WorkflowListingFields {
  slug: string;
  title: string;
  description: string;
  category: string;
  cadence: string;
  outputSummary: string;
  compatibility: { platform: string; minimumVersion?: string };
}

export interface WorkflowListingSummary extends WorkflowListingFields {
  week: Pick<WorkflowPreview, "company" | "days">;
}

export interface PublicWorkflowListing extends WorkflowListingFields {
  credit?: string;
  installerPath: string;
  preview: WorkflowPreview;
  openGraph: { width: number; height: number; alt: string };
}

export interface WorkflowReleaseSummary {
  revision: number;
  sha256: string;
  candidateBudget: { target: number; limit: number };
  schedule: { cron: string; tz: string };
  capabilities: readonly string[];
  inputs: readonly { id: string; label: string; type: string }[];
}

export function workflowCompatibilityLine({
  platform,
  minimumVersion,
}: WorkflowListingFields["compatibility"]) {
  return minimumVersion
    ? `${platform} · Omnyo ${minimumVersion} or later`
    : `${platform} beta with workflow-file import`;
}
