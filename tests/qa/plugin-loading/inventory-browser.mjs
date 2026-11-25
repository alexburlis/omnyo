import { collectPluginAppRegistrations } from "../../../packages/plugin-sdk/src/internal/plugin-app-collector.ts";

export async function collect(ids) {
  return await Promise.all(
    ids.map(async (id, i) => {
      const module = await import(`/fixture/entry-${i}.js`);

      if (!module.default?.__omnyoPluginApp)
        throw new Error(`Invalid frontend: ${id}`);
      const registrations = collectPluginAppRegistrations(module.default);

      return {
        id,
        pages: registrations.navPanels.length,
        settings: registrations.settingsSections.length,
        fixedTabs: registrations.navPanels.reduce(
          (sum, panel) => sum + (panel.fixedTabs?.length ?? 0),
          0,
        ),
      };
    }),
  );
}
