import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "See what's left on every account",
  lede: "Usage rings show each Claude and Codex account's allowance, and Account Pooler moves new chats to the next account when one runs low.",
  sections: [
    {
      heading: "Put your accounts in order",
      body: "Add Claude accounts with a claude.ai sign-in or an API key, and Codex accounts with a ChatGPT sign-in. Chats on every machine then use them one at a time, in the order you drag them into.",
      bullets: [
        "New chats move on at 98% by default",
        "Running chats keep their own account",
        "An API key is a metered fallback and never routes first",
      ],
      visual: "usage-tracking-order",
    },
    {
      heading: "Paused chats pick up after the reset",
      body: "When a chat hits a usage limit, a retry card waits above the composer with the time it will send. It goes just after the reset the provider reports, or you press Send now.",
      bullets: [
        "Overloads retry with growing delays, then every 15 minutes",
        "Credit and spend limits are never retried",
      ],
      visual: "usage-tracking-retry",
    },
  ],
  goodToKnow: [
    {
      label: "Credentials",
      value:
        "Stay on your Omnyo server. Each machine gets its own revocable token.",
    },
    {
      label: "Longest wait",
      value: "No limit by default. Cap automatic retries at 6 or 24 hours.",
    },
    {
      label: "Spending",
      value:
        "Omnyo never turns on extra usage, buys credits or changes limits.",
    },
    {
      label: "Bypass",
      value: "Any chat can use its machine's own login instead of the pool.",
    },
    {
      label: "Terms",
      value: "Each provider's own terms apply to every account you add.",
    },
  ],
  faq: [
    {
      question: "How do I check my Claude Code usage in Omnyo?",
      answer:
        "Add your Claude account to Account Pooler, then hover or click the Claude ring in the sidebar. Each account shows its plan, weekly usage, what is left and the next reset.",
    },
    {
      question: "Can I change when chats switch accounts?",
      answer:
        "Yes. The switch point defaults to 98% and can be changed under Advanced on the Account Pooler page.",
    },
    {
      question: "Does Omnyo show what my usage costs?",
      answer:
        "No. Readings show the allowance left, not per-request charges. Credit balances appear only when the provider reports them.",
    },
  ],
  relatedFeatures: ["stats", "claude-code-gui", "codex-gui"],
  relatedGuides: [],
};
