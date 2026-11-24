import reviewAProductUpdate from "./prompts/review-a-product-update.txt?raw";

export interface PromptSample {
  label: string;
  input: readonly { label: string; value: string }[];
  findings: readonly string[];
  revision: string;
}

export interface PromptSource {
  slug: string;
  title: string;
  summary: string;
  usage: string;
  body: string;
  sample: PromptSample;
}

export const promptSources: readonly PromptSource[] = [
  {
    slug: "review-a-product-update",
    title: "Review a product update",
    summary:
      "Check a release note or announcement against the facts you supply, then get a clearer revision that claims nothing you cannot support.",
    usage:
      "Paste it into a new chat in Omnyo, or any coding agent, and replace each highlighted placeholder before you send it.",
    body: reviewAProductUpdate,
    sample: {
      label:
        "Fictional example: Mosslight Workshop announces calendar sync by email.",
      input: [
        { label: "Product", value: "Mosslight Planner" },
        { label: "Readers", value: "Existing Mosslight customers" },
        { label: "Channel", value: "Email" },
        {
          label: "Facts",
          value:
            "Google Calendar sync is now two-way. Sync runs every five minutes. Available on the Team plan. Outlook calendars are not included.",
        },
        {
          label: "Draft",
          value:
            "Big news! Mosslight Planner now syncs instantly with every calendar you use. Update today.",
        },
      ],
      findings: [
        "“syncs instantly” is not supported: the facts say sync runs every five minutes.",
        "“every calendar you use” is not supported: the facts cover Google Calendar only.",
        "Missing: two-way sync is available on the Team plan only.",
      ],
      revision:
        "Mosslight Planner now keeps your Google Calendar in sync both ways. Changes appear within about five minutes. Two-way sync is part of the Team plan. Outlook calendars are not included.",
    },
  },
];
