import {
  BUNDLED_MARKETPLACE_NAME,
  BUILTIN_PUBLISHER_LABEL,
} from "./marketplace-manifest.js";

export function marketplacePublisherLabel(args: {
  marketplaceName: string;
  displayName: string;
}): string {
  if (args.marketplaceName === BUNDLED_MARKETPLACE_NAME)
    return args.displayName;

  return args.displayName === BUILTIN_PUBLISHER_LABEL
    ? args.marketplaceName
    : args.displayName;
}

export function pluginPublisherLabel(args: {
  sourceKind: "path" | "builtin" | "npm" | "git";
  provenance: "builtin" | "direct" | "catalog";
  catalogMarketplaceName: string | null;
  labels: ReadonlyMap<string, string>;
}): string | null {
  if (args.sourceKind === "builtin" || args.provenance === "builtin") {
    return BUILTIN_PUBLISHER_LABEL;
  }

  if (args.provenance !== "catalog") return null;
  const name = args.catalogMarketplaceName;

  if (name === null) return null;

  return args.labels.get(name) ?? name;
}

export function pluginIsOfficial(args: {
  pluginId: string;
  sourceKind: "path" | "builtin" | "npm" | "git";
  provenance: "builtin" | "direct" | "catalog";
  catalogMarketplaceName: string | null;
  officialPluginIds: ReadonlySet<string>;
}): boolean {
  if (args.sourceKind === "builtin" || args.provenance === "builtin") {
    return true;
  }

  if (args.provenance === "catalog") {
    return args.catalogMarketplaceName === BUNDLED_MARKETPLACE_NAME;
  }

  return (
    args.sourceKind === "path" && args.officialPluginIds.has(args.pluginId)
  );
}
