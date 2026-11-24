import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { BUNDLED_PLUGINS } from "../../../server/src/services/plugins/builtin-registry";
import { derivePluginId } from "../../../../packages/domain/src/plugin-id";
import { pluginManifestSummary } from "../plugin-guide/plugin-directory";
import { exploreRecords } from "./records.server";

const repoFile = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

it("binds every curated plugin to its included Omnyo Official identity", () => {
  const official = JSON.parse(
    repoFile("plugins/omnyo-official.json"),
  ) as Record<string, unknown>;

  const plugins = exploreRecords.filter((record) => record.kind === "plugin");

  expect(plugins.map(({ slug }) => slug)).toEqual(["browser-automation"]);

  for (const record of plugins) {
    const manifest = JSON.parse(
      repoFile(`plugins/${record.slug}/package.json`),
    ) as { name: string; author?: { name?: string } };

    const summary = pluginManifestSummary(record.slug);
    const bundled = BUNDLED_PLUGINS.find(({ name }) => name === record.slug);

    expect(record.marketplace).toBe("omnyo-official");
    expect(official).toHaveProperty(record.slug);
    expect(summary?.pluginId).toBe(derivePluginId(manifest.name));
    expect(summary?.pluginId).toBe(record.slug);
    expect(summary?.author.name).toBe(manifest.author?.name);
    expect(bundled).toMatchObject({
      pluginId: record.slug,
      autoInstall: true,
      defaultEnabled: true,
    });
  }
});
