import { createServerFn } from "@tanstack/react-start";

import { workflowCatalog } from "../workflow-catalog/entries.server";
import { isExploreKind, type ExploreItemKey } from "./catalog";
import { exploreCatalog } from "./entries.server";

const slugInput = (input: string) => (typeof input === "string" ? input : "");

export const getSiteNavigation = createServerFn({ method: "GET" }).handler(
  () => ({
    workflows: workflowCatalog.listings.length > 0,
    explore: exploreCatalog.items.length > 0,
  }),
);

export const listExploreItems = createServerFn({ method: "GET" }).handler(
  () => exploreCatalog.items,
);

export const getExplorePrompt = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(({ data }) => exploreCatalog.promptDetail(data));

export const getExploreRelated = createServerFn({ method: "GET" })
  .validator((input: ExploreItemKey): ExploreItemKey | null =>
    isExploreKind(input?.kind) && typeof input.slug === "string"
      ? { kind: input.kind, slug: input.slug }
      : null,
  )
  .handler(({ data }) =>
    data ? exploreCatalog.relatedFor(data.kind, data.slug) : [],
  );

export const getExplorePlugin = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(({ data }) => exploreCatalog.pluginDetail(data));

export const getExploreSkill = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(({ data }) => exploreCatalog.skillDetail(data));
