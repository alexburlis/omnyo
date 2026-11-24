import { describe, expect, it } from "vitest";
import { buildPluginSettingsEntries } from "./plugin-settings-entries";

describe("buildPluginSettingsEntries", () => {
  it("only includes enabled plugins with declared or custom settings", () => {
    const installedPlugins = [
      {
        enabled: true,
        hasSettings: false,
        icon: null,
        id: "workflows",
        name: null,
        shortName: null,
      },
      {
        enabled: false,
        hasSettings: false,
        icon: null,
        id: "disabled",
        name: "Disabled",
        shortName: null,
      },
      {
        enabled: true,
        hasSettings: true,
        icon: "linear-icon",
        id: "linear",
        name: "Linear",
        shortName: null,
      },
      {
        enabled: true,
        hasSettings: false,
        icon: null,
        id: "plain",
        name: "Plain",
        shortName: null,
      },
    ];

    const entries = buildPluginSettingsEntries({
      installedPlugins,
      settingsSections: [{ pluginId: "workflows" }],
    });

    expect(entries).toEqual([
      { icon: "linear-icon", id: "linear", label: "Linear" },
      { icon: null, id: "workflows", label: "workflows" },
    ]);
  });

  it("labels a plugin with its short name when it declares one", () => {
    const entries = buildPluginSettingsEntries({
      installedPlugins: [
        {
          enabled: true,
          hasSettings: true,
          icon: "Mic",
          id: "local-voice",
          name: "Dictation by Paraspeech",
          shortName: "Dictation",
        },
      ],
      settingsSections: [],
    });

    expect(entries).toEqual([
      { icon: "Mic", id: "local-voice", label: "Dictation" },
    ]);
  });
});
