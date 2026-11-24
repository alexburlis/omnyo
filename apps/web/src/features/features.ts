import {
  FEATURE_GROUP_NOTES,
  FEATURE_GROUPS,
  type FeatureGroup,
  type FeatureMeta,
  type FeaturePageBody,
} from "./feature-types";

const META_MODULES = import.meta.glob<{ meta: FeatureMeta }>(
  "./pages/*.meta.ts",
  { eager: true },
);

const BODY_MODULES = import.meta.glob<{ page: FeaturePageBody }>([
  "./pages/*.ts",
  "!./pages/*.meta.ts",
]);

const METAS: readonly FeatureMeta[] = Object.values(META_MODULES)
  .map((module) => module.meta)
  .sort(
    (a, b) =>
      FEATURE_GROUPS.indexOf(a.group) - FEATURE_GROUPS.indexOf(b.group) ||
      a.order - b.order,
  );

const BY_SLUG = new Map(METAS.map((meta) => [meta.slug, meta]));

export const featureMetas = () => METAS;

export const getFeatureMeta = (slug: string) => BY_SLUG.get(slug);

export const featurePaths = () => [
  "/features",
  ...METAS.map((meta) => `/features/${meta.slug}`),
];

export const featureGroupId = (group: FeatureGroup) =>
  group.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export const featureGroups = (): readonly {
  group: FeatureGroup;
  id: string;
  note: string;
  features: readonly FeatureMeta[];
}[] =>
  FEATURE_GROUPS.map((group) => ({
    group,
    id: featureGroupId(group),
    note: FEATURE_GROUP_NOTES[group],
    features: METAS.filter((meta) => meta.group === group),
  })).filter((entry) => entry.features.length > 0);

export async function loadFeatureBody(slug: string) {
  const load = BODY_MODULES[`./pages/${slug}.ts`];

  if (!load) return undefined;

  return (await load()).page;
}
