import { describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  defaultAppSettings,
  managedBranchPrefixSchema,
  MANAGED_BRANCH_PREFIX_MAX_LENGTH,
  newThreadPermissionMode,
} from "../src/app-settings.js";

describe("managedBranchPrefixSchema", () => {
  it("enables startup CLI updates for existing settings and preserves opting out", () => {
    const { autoUpdateProviderClisOnStartup: _setting, ...older } =
      defaultAppSettings;

    expect(appSettingsSchema.parse(older).autoUpdateProviderClisOnStartup).toBe(
      true,
    );
    expect(
      appSettingsSchema.parse({
        ...older,
        autoUpdateProviderClisOnStartup: false,
      }).autoUpdateProviderClisOnStartup,
    ).toBe(false);
  });
  it("accepts prefixes that start a valid branch name", () => {
    for (const prefix of ["omnyo/", "", "sawyer/wt-", "team/omnyo/", "wip_"]) {
      expect(managedBranchPrefixSchema.safeParse(prefix).success).toBe(true);
    }
  });

  it("rejects prefixes that cannot start a valid branch name", () => {
    for (const prefix of [
      " omnyo/",
      "omnyo //",
      "-omnyo/",
      "/omnyo/",
      "omnyo//",
      "omnyo../",
      "omnyo:",
      "omnyo~",
      "omnyo\\",
      "omnyo@{",
      ".omnyo/",
      "a".repeat(MANAGED_BRANCH_PREFIX_MAX_LENGTH + 1),
    ]) {
      expect(managedBranchPrefixSchema.safeParse(prefix).success).toBe(false);
    }
  });

  it("defaults to the omnyo namespace", () => {
    expect(defaultAppSettings.managedBranchPrefix).toBe("omnyo/");
    expect(appSettingsSchema.parse(defaultAppSettings)).toEqual(
      defaultAppSettings,
    );
  });
});

describe("new chat approval defaults", () => {
  it("keeps legacy settings at automatic approval without inventing model overrides", () => {
    const {
      defaultPermissionMode: _default,
      modelPermissionModes: _models,
      ...legacy
    } = defaultAppSettings;

    const parsed = appSettingsSchema.parse(legacy);

    expect(parsed.defaultPermissionMode).toBe("auto");
    expect(parsed.modelPermissionModes).toEqual({});
    expect(newThreadPermissionMode(undefined, "codex", "model-a")).toBe("auto");
  });

  it("resolves a model override within its provider and inherits after removal", () => {
    const settings = {
      defaultPermissionMode: "accept-edits" as const,
      modelPermissionModes: { codex: { "model-a": "full" as const } },
    };

    expect(newThreadPermissionMode(settings, "codex", "model-a")).toBe("full");
    expect(newThreadPermissionMode(settings, "claude-code", "model-a")).toBe(
      "accept-edits",
    );
    expect(newThreadPermissionMode(settings, "codex", null)).toBe(
      "accept-edits",
    );
    expect(
      newThreadPermissionMode(
        { ...settings, modelPermissionModes: {} },
        "codex",
        "model-a",
      ),
    ).toBe("accept-edits");
  });

  it("rejects unsupported approval values at the settings boundary", () => {
    expect(
      appSettingsSchema.safeParse({
        ...defaultAppSettings,
        defaultPermissionMode: "approve-everything",
      }).success,
    ).toBe(false);
    expect(
      appSettingsSchema.safeParse({
        ...defaultAppSettings,
        modelPermissionModes: { codex: { "model-a": "approve-everything" } },
      }).success,
    ).toBe(false);
  });
});
