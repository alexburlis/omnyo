import type { ImportedFlow } from "../src/imported/contracts.js";

export const weeklyContentFeed = {
  kind: "graph",
  engine: "weekly-content-feed",
  targetCount: 7,
  maxCandidates: 14,
  writer: {
    prompt:
      "Write one original draft for the supplied fictional startup. Return only JSON: candidateId, canonicalTopic, title, body, sources. Use only supplied evidence. Distinguish hypotheses. Do not publish or request tools.",
  },
  reviewer: {
    prompt:
      "Independently review the supplied draft against the supplied evidence and editorial rules. Return only JSON: candidateId, draftDigest, outcome (accepted, rejected, revise), reason. Reject unsupported claims, repeated canonical topics, and incomplete drafts. Do not publish or request tools.",
  },
} satisfies ImportedFlow;

export const fictionalStartup = {
  name: "Mosslight Workshop",
  description: "A fictional planning notebook for neighborhood seed swaps.",
  evidence: [
    "Members can record seed names and planned swap dates.",
    "This fixture makes no claim about real customers, pricing or results.",
  ],
  weekStart: "2026-11-23",
};
