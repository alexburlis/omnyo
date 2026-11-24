import { getGuide } from "../guides/guides";
import { canonicalPath } from "../landing/content-links";
import { pluginManifestSummary } from "../plugin-guide/plugin-directory";
import { workflowCatalog } from "../workflow-catalog/entries.server";
import { exploreActivation } from "./activation.server";
import { createExploreCatalog, type ExploreOwners } from "./catalog.server";
import { promptSources } from "./prompts.server";
import { exploreRecords } from "./records.server";
import { exploreSkillSource } from "./skill-packs.server";

export const exploreOwners: ExploreOwners = {
  prompt: (slug) => promptSources.find((prompt) => prompt.slug === slug),
  workflow: (slug) => workflowCatalog.detail(slug),
  skill: exploreSkillSource,
  guide: (slug) => {
    const guide = getGuide(slug);

    return guide
      ? {
          title: guide.title,
          description: guide.description,
          path: canonicalPath(`/guides/${guide.slug}`),
        }
      : undefined;
  },
  plugin: pluginManifestSummary,
};

export const exploreCatalog = createExploreCatalog({
  activation: exploreActivation,
  records: exploreRecords,
  owners: exploreOwners,
});
