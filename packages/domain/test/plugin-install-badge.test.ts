import { describe, expect, it } from "vitest";
import { pluginInstallBadge } from "../src/plugin-install-badge.js";

describe("pluginInstallBadge", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  const recent = "2026-09-20T00:00:00Z";
  const old = "2026-08-01T00:00:00Z";

  const badge = (plugin: Partial<Parameters<typeof pluginInstallBadge>[0]>) =>
    pluginInstallBadge(
      { installed: false, installedByDefault: false, ...plugin },
      now,
    );

  it("labels installed plugins that ship by default as built in", () => {
    expect(
      badge({ installed: true, installedByDefault: true, publishedAt: old }),
    ).toEqual({ kind: "builtin" });
  });

  it("drops the built-in label once a default plugin is uninstalled", () => {
    expect(badge({ installedByDefault: true, publishedAt: old })).toBeNull();
    expect(badge({ installedByDefault: true, publishedAt: recent })).toEqual({
      kind: "new",
    });
  });

  it("labels recent plugins new until they age out", () => {
    expect(badge({ publishedAt: recent })).toEqual({ kind: "new" });
    expect(badge({ publishedAt: old })).toBeNull();
    expect(badge({})).toBeNull();
  });
});
