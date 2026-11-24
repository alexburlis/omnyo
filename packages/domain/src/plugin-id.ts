import { z } from "zod";
import { importLegacyOwnedPluginIdV1 } from "./legacy-plugin-id-v1.js";

export const pluginIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

function importLegacyPluginPackageNameV1(packageName: string): string {
  return importLegacyOwnedPluginIdV1(packageName.slice("bb-plugin-".length));
}

export function derivePluginId(packageName: string): string {
  const base = packageName.includes("/")
    ? (packageName.split("/").at(-1) ?? packageName)
    : packageName;

  const canonicalBase = base.startsWith("bb-plugin-")
    ? importLegacyPluginPackageNameV1(base)
    : base.replace(/^omnyo-plugin-/, "");

  const id = canonicalBase
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");

  if (id.length === 0) {
    throw new Error(
      `cannot derive a plugin id from package name "${packageName}"`,
    );
  }

  return id;
}
