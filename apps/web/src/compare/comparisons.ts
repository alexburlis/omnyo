import type { ComparisonBody, ComparisonMeta } from "./comparison-types";

const META_MODULES = import.meta.glob<{ meta: ComparisonMeta }>(
  "./pages/*.meta.ts",
  { eager: true },
);

const BODY_MODULES = import.meta.glob<{ page: ComparisonBody }>([
  "./pages/*.ts",
  "!./pages/*.meta.ts",
]);

const METAS: readonly ComparisonMeta[] = Object.values(META_MODULES)
  .map((module) => module.meta)
  .sort((a, b) => a.name.localeCompare(b.name));

const BY_SLUG = new Map(METAS.map((meta) => [meta.slug, meta]));

export const comparisonMetas = () => METAS;

export const getComparisonMeta = (slug: string) => BY_SLUG.get(slug);

export const comparisonPath = (slug: string) => `/compare/${slug}`;

export const comparisonPaths = () =>
  METAS.map((meta) => comparisonPath(meta.slug));

export async function loadComparisonBody(slug: string) {
  const load = BODY_MODULES[`./pages/${slug}.ts`];

  if (!load) return undefined;

  return (await load()).page;
}
