import type { ExploreRecord } from "./catalog.server";

export const exploreRecords: readonly ExploreRecord[] = [
  {
    kind: "workflow",
    slug: "weekly-content-feed",
    state: "published",
    position: 0,
    tags: ["content", "weekly", "drafts"],
    related: [{ kind: "guide", slug: "run-an-agent-on-a-schedule" }],
  },
  {
    kind: "prompt",
    slug: "review-a-product-update",
    state: "published",
    position: 10,
    tags: ["writing", "review", "release notes"],
    related: [{ kind: "workflow", slug: "weekly-content-feed" }],
  },
  {
    kind: "skill",
    slug: "product-update-review",
    state: "published",
    position: 15,
    tags: ["release notes", "editing", "review"],
    related: [{ kind: "prompt", slug: "review-a-product-update" }],
  },
  {
    kind: "skill",
    slug: "customer-lab",
    state: "published",
    position: 16,
    tags: ["usability", "onboarding", "product testing", "buyer research"],
    related: [],
  },
  {
    kind: "plugin",
    slug: "browser-automation",
    state: "published",
    position: 20,
    tags: ["browser", "testing", "automation"],
    related: [{ kind: "guide", slug: "run-an-agent-on-a-schedule" }],
    marketplace: "omnyo-official",
    capabilities: [
      "Opens pages, clicks, fills out forms and checks results in Omnyo's in-app browser.",
      "Runs headless Chrome on your Mac and on connected macOS or Linux machines that have Chrome or Chromium installed.",
      "Shows a live preview of headless sessions in the chat.",
    ],
    availability: "Included with Omnyo for Mac and turned on by default.",
  },
  {
    kind: "guide",
    slug: "run-an-agent-on-a-schedule",
    state: "published",
    position: 30,
    tags: ["automations", "schedule"],
    related: [{ kind: "workflow", slug: "weekly-content-feed" }],
  },
];
