import { createWorkflowCatalog, type CatalogEntry } from "./catalog.server";
import { weeklyContentFeedPreview } from "./weekly-content-feed-preview";
import previewImage from "./weekly-content-feed-preview.png?inline";
import weeklyContentFeed from "./weekly-content-feed.omnyoworkflow?raw";
import weeklyRelease from "./weekly-content-feed.release.json";

export const workflowEntries: readonly CatalogEntry[] = [
  {
    state: "published",
    position: 0,
    listing: {
      slug: "weekly-content-feed",
      title: "Weekly Content Feed",
      description:
        "Turn your product notes into a week of reviewed drafts. Guide topic selection with keywords you’ve already saved in OpenSEO.",
      category: "Content",
      cadence: "Weekly",
      outputSummary:
        "Seven reviewed Markdown drafts and a seven-day delivery calendar",
      compatibility: {
        platform: "Apple silicon Mac",
        minimumVersion: "1.0.143",
      },
      installerPath: "/downloads/Omnyo-Weekly-Content-Feed-Setup.zip",
      preview: weeklyContentFeedPreview,
      openGraph: {
        width: 1200,
        height: 630,
        alt: "Weekly Content Feed example: seven draft topics and a review pass for fictional Mosslight Workshop.",
      },
    },
    releases: [
      {
        state: "current",
        summary: weeklyRelease,
        canonical: weeklyContentFeed,
      },
    ],
    previewPng: previewImage.slice("data:image/png;base64,".length),
  },
];

export const workflowCatalog = createWorkflowCatalog(workflowEntries);
