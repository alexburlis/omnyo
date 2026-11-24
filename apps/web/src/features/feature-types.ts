export const FEATURE_GROUPS = [
  "Run agents",
  "Stay on top",
  "Automate",
  "From anywhere",
  "Tools",
  "Yours",
] as const;

export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export const FEATURE_GROUP_NOTES: Record<FeatureGroup, string> = {
  "Run agents": "Claude Code and Codex in one app, as many chats as you need.",
  "Stay on top": "See what each chat needs, and what it costs, at a glance.",
  Automate: "Schedules, loops and waits that keep your agents working.",
  "From anywhere": "Follow and steer your agents from any device.",
  Tools: "A terminal, browser, voice, shortcuts and GitHub beside your chats.",
  Yours: "Fast, private and yours to run.",
};

export interface FeatureMeta {
  slug: string;
  name: string;
  group: FeatureGroup;
  order: number;
  tagline: string;
  visual: string;
  seoTitle: string;
  seoDescription: string;
  keyword: string | null;
  tile: "wide" | "regular" | null;
}

export interface FeaturePoint {
  title: string;
  body: string;
}

export interface FeatureSection {
  heading: string;
  paragraphs: readonly string[];
  bullets: readonly string[];
  visual: string | null;
}

export interface FeatureShowcase {
  heading: string;
  body: string;
  bullets: readonly string[];
  visual: string;
}

export interface FeatureFact {
  label: string;
  value: string;
}

export interface FeatureQuestion {
  question: string;
  answer: string;
}

export interface FeatureGuideLink {
  slug: string;
  label: string;
}

export interface FeaturePageBody {
  headline: string;
  lede: string;
  sections: readonly FeatureShowcase[];
  goodToKnow: readonly FeatureFact[];
  faq: readonly FeatureQuestion[];
  relatedFeatures: readonly string[];
  relatedGuides: readonly FeatureGuideLink[];
}
