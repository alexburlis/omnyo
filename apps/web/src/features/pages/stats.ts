import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "See how hard your agents are working",
  lede: "Stats counts running agents, tokens and model speed across every chat and machine, and keeps the numbers in SQLite on your own server.",
  sections: [
    {
      heading: "Split the work by model or machine",
      body: "Group every number by model, provider, machine, project, chat, thinking effort or role. Work distribution shows where the output goes, and clicking a group filters the whole page.",
      bullets: [
        "Output, input, cache and reasoning tokens per group",
        "Turns, agent time and tokens per second",
        "Export any breakdown as CSV or JSON",
      ],
      visual: "stats-fabric",
    },
    {
      heading: "Compare model speed",
      body: "The Model speed tab lists each model with its median and pooled tokens per second, measured turns, output and a trend. Recorded tool and interaction waits are taken out of the turn time first.",
      bullets: [
        "An estimate from recorded turns, not a decoder reading",
        "Split by thinking effort and mode",
      ],
      visual: "stats-speed",
    },
  ],
  goodToKnow: [
    {
      label: "Data",
      value:
        "SQLite on your Omnyo server. Prompt, reply and tool content is discarded.",
    },
    {
      label: "History",
      value:
        "Lifetime totals and daily summaries stay, even after you delete the chat.",
    },
    {
      label: "Detail kept",
      value: "Minute buckets and speed samples for 30 days.",
    },
    {
      label: "Counts",
      value:
        "Tokens, not money. Plan limits live in [usage and accounts](/features/usage-tracking).",
    },
    {
      label: "Pooled accounts",
      value: "Tokens per Account Pooler account show as Unknown.",
    },
    {
      label: "CLI",
      value: "`omnyo stats summary`, `report`, `health` and `refresh`.",
    },
  ],
  faq: [
    {
      question: "Does Stats show what my Claude Code usage costs?",
      answer:
        "No. Stats records tokens, not prices. To see how much of your plan is left, open [usage and accounts](/features/usage-tracking).",
    },
    {
      question: "Does it count Codex as well as Claude Code?",
      answer:
        "Yes. It records every chat on every machine, and you can group by provider or model to compare them.",
    },
    {
      question: "Can it show usage from before I installed it?",
      answer:
        "No. Stats counts from the moment it is installed and cannot rebuild earlier usage or chats deleted before then.",
    },
  ],
  relatedFeatures: ["usage-tracking", "parallel-agents", "performance"],
  relatedGuides: [],
};
