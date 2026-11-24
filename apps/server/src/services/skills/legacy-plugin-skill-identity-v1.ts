import { legacyOwnedPluginIdsV1 } from "@omnyo/domain";

const legacyOwnedPluginSkillNamesV1 = [
  ["bb-guide", "bb-cli", "omnyo-cli"],
  ["bb-guide", "bb-plugin-authoring", "omnyo-plugin-authoring"],
  ["bb-ai", "bb-cloud-ai", "omnyo-cloud-ai"],
  ["bb-account", "bb-account", "omnyo-account"],
  ["theme-preview", "bb-theme-authoring", "omnyo-theme-authoring"],
] as const;

export function legacyPluginSkillIdentityV1(
  pluginId: string,
  name: string,
  entryPath: string,
): { identitySeed: string; logicalPath: string } {
  const legacyId =
    legacyOwnedPluginIdsV1.find(([, current]) => current === pluginId)?.[0] ??
    pluginId;

  const legacyName =
    legacyOwnedPluginSkillNamesV1.find(
      ([owner, , current]) => owner === legacyId && current === name,
    )?.[1] ?? name;

  return {
    identitySeed: `bb-plugin:${legacyId}`,
    logicalPath: `${legacyName}/${entryPath}`,
  };
}
