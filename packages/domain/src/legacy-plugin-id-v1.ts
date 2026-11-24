export const legacyOwnedPluginIdsV1 = [
  ["bb--account-usage", "omnyo--account-usage"],
  ["bb-account", "omnyo-account"],
  ["bb-ai", "omnyo-ai"],
  ["bb-guide", "omnyo-guide"],
  ["bb--composer-predictions", "omnyo--composer-predictions"],
  ["bb--git", "omnyo--git"],
  ["bb--prompt-library", "omnyo--prompt-library"],
  ["bb--provider-acp-next", "omnyo--provider-acp-next"],
  ["bb--provider-usage", "omnyo--provider-usage"],
  ["bb--storage-retention", "omnyo--storage-retention"],
] as const;

export function importLegacyOwnedPluginIdV1(id: string): string {
  return legacyOwnedPluginIdsV1.find(([oldId]) => id === oldId)?.[1] ?? id;
}

export function importLegacyPluginSnapshotIdV1(
  id: string,
  expectedId: string,
): string {
  if (id === expectedId || importLegacyOwnedPluginIdV1(id) === expectedId)
    return expectedId;
  throw new Error(
    `Plugin snapshot identity "${id}" does not match "${expectedId}"`,
  );
}

export function importLegacyBuiltinNameV1(name: string | null): string | null {
  if (name === "bb-account") return "omnyo-account";

  if (name === "bb-ai") return "omnyo-ai";

  if (name === "bb-guide") return "omnyo-guide";

  return name;
}

export function importLegacyNavigationKeyV1(key: string): string {
  for (const name of [
    "new-thread",
    "search-threads",
    "extensions",
    "skills",
    "automations",
  ])
    if (key === `__bb__/${name}`) return `__core__/${name}`;

  for (const [oldId, id] of legacyOwnedPluginIdsV1) {
    if (key.startsWith(`${oldId}/`))
      return `${id}/` + key.slice(oldId.length + 1);

    if (key.startsWith(`plugin:${oldId}/`))
      return `plugin:${id}/` + key.slice(`plugin:${oldId}/`.length);
  }

  return key;
}
