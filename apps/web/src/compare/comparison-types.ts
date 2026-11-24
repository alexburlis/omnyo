import type {
  FeatureGuideLink,
  FeaturePoint,
  FeatureQuestion,
  FeatureSection,
} from "../features/feature-types";

export interface ComparisonSide {
  name: string;
  maker: string;
}

export interface ComparisonMeta {
  slug: string;
  name: string;
  left: ComparisonSide;
  right: ComparisonSide;
  tagline: string;
  seoTitle: string;
  seoDescription: string;
  keyword: string;
  checkedOn: string;
}

export interface ComparisonRow {
  label: string;
  left: string;
  right: string;
}

export interface ComparisonTable {
  heading: string;
  rows: readonly ComparisonRow[];
}

export interface ComparisonPick {
  heading: string;
  items: readonly string[];
}

export interface ComparisonSource {
  label: string;
  url: string;
}

export interface ComparisonTogether {
  heading: string;
  lede: string;
  visual: string;
  sections: readonly FeatureSection[];
}

export interface ComparisonBody {
  headline: string;
  lede: string;
  points: readonly FeaturePoint[];
  tablesHeading: string;
  tablesLede: string;
  tables: readonly ComparisonTable[];
  sections: readonly FeatureSection[];
  picksHeading: string;
  picks: readonly ComparisonPick[];
  together: ComparisonTogether;
  faq: readonly FeatureQuestion[];
  sources: readonly ComparisonSource[];
  relatedFeatures: readonly string[];
  relatedGuides: readonly FeatureGuideLink[];
}
