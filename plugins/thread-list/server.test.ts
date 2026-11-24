import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { migrateFromUiPreferences } from "./server.js";
import {
  defaultPreferences,
  threadRowActionKeySchema,
} from "./shared/preferences.js";

const PLUGIN_ID = "thread-list";

function setup(
  options: {
    uiPreferences?: Record<string, { revision: number; value: unknown }>;
    uiPreferencesFail?: boolean;
  } = {},
) {
  return createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      system: {
        uiPreferences: {
          list: async () => {
            if (options.uiPreferencesFail) throw new Error("offline");

            return { preferences: options.uiPreferences ?? {} };
          },
        },
      },
    },
  });
}

it.each([
  { kind: "bare legacy", input: "pin", expected: "omnyo--core/pin" },
  {
    kind: "old core owner",
    input: "core/archive",
    expected: "omnyo--core/archive",
  },
  {
    kind: "canonical owner",
    input: "omnyo--core/rename",
    expected: "omnyo--core/rename",
  },
  { kind: "foreign owner", input: "foreign/pin", expected: "foreign/pin" },
  {
    kind: "foreign branded owner",
    input: "bb-personal/archive",
    expected: "bb-personal/archive",
  },
  {
    kind: "unknown core leaf",
    input: "core/futureAction",
    expected: "core/futureAction",
  },
  { kind: "list move owner", input: "move", expected: "thread-list/move" },
  {
    kind: "known copy-id owner",
    input: "core/copyId",
    expected: "omnyo--core/copyId",
  },
  {
    kind: "known shelve owner",
    input: "core/shelve",
    expected: "omnyo--core/shelve",
  },
  {
    kind: "unknown Unicode leaf",
    input: "core/保留%2F",
    expected: "core/保留%2F",
  },
])(
  "imports finite row-action keys for $kind without rewriting foreign or unknown leaves",
  ({ input, expected }) => {
    expect(threadRowActionKeySchema.parse(input)).toBe(expected);
    expect(threadRowActionKeySchema.parse(expected)).toBe(expected);
  },
);

describe("thread-list preferences rpc", () => {
  it("projects stored row-action identities without rewriting raw preferences", async () => {
    const { api, harness } = setup();
    const stored = ["core/archive", "foreign/保留%2f", "core/futureAction"];
    const before = [...stored];
    await api.storage.kv.set("preference:rowActions", stored);
    await plugin(api);
    const first = await harness.behavior.callRpc("listPreferences", null);
    expect(first).toMatchObject({
      preferences: {
        rowActions: [
          "omnyo--core/archive",
          "foreign/保留%2f",
          "core/futureAction",
        ],
      },
    });
    expect(await harness.behavior.callRpc("listPreferences", null)).toEqual(
      first,
    );
    expect(await api.storage.kv.get("preference:rowActions")).toEqual(before);
    expect(stored).toEqual(before);
  });

  it("lists defaults on a fresh install and round-trips a valid write", async () => {
    const { api, harness } = setup();
    await plugin(api);
    await expect(
      harness.behavior.callRpc("listPreferences", null),
    ).resolves.toEqual({
      preferences: defaultPreferences(),
    });
    await expect(
      harness.behavior.callRpc("listPreferences", null),
    ).resolves.toMatchObject({
      preferences: { showProviderIcons: true },
    });
    await harness.behavior.callRpc("setPreference", {
      key: "showProviderIcons",
      value: false,
    });
    await migrateFromUiPreferences(api);
    await expect(
      harness.behavior.callRpc("listPreferences", null),
    ).resolves.toMatchObject({
      preferences: { showProviderIcons: false },
    });

    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "organizationMode",
        value: "machine",
        origin: "window-a",
      }),
    ).resolves.toEqual({ key: "organizationMode", value: "machine" });
    await expect(
      api.storage.kv.get("preference:organizationMode"),
    ).resolves.toBe("machine");

    const listed = (await harness.behavior.callRpc(
      "listPreferences",
      null,
    )) as {
      preferences: { organizationMode: string };
    };

    expect(listed.preferences.organizationMode).toBe("machine");
    expect(harness.realtimeSignals).toEqual([
      {
        channel: "preferences",
        payload: { key: "showProviderIcons", value: false, origin: null },
      },
      {
        channel: "preferences",
        payload: {
          key: "organizationMode",
          value: "machine",
          origin: "window-a",
        },
      },
    ]);
  });

  it("rejects a value that fails the preference's schema and leaves storage alone", async () => {
    const { api, harness } = setup();
    await plugin(api);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "organizationMode",
        value: "sideways",
      }),
    ).rejects.toThrow(/Invalid value for organizationMode/);
    await expect(
      api.storage.kv.get("preference:organizationMode"),
    ).resolves.toBeUndefined();
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "hiddenGroups",
        value: ["project:a", "bogus"],
      }),
    ).rejects.toThrow(/Invalid value for hiddenGroups/);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "showProviderIcons",
        value: "false",
      }),
    ).rejects.toThrow(/Invalid value for showProviderIcons/);
  });

  it("dedupes hidden groups and resets to the default", async () => {
    const { api, harness } = setup();
    await plugin(api);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "hiddenGroups",
        value: ["threads", "project:a", "project:a", "machine:m"],
      }),
    ).resolves.toEqual({
      key: "hiddenGroups",
      value: ["threads", "project:a", "machine:m"],
    });
    await expect(
      harness.behavior.callRpc("resetPreference", { key: "hiddenGroups" }),
    ).resolves.toEqual({ key: "hiddenGroups", value: [] });
    await expect(
      api.storage.kv.get("preference:hiddenGroups"),
    ).resolves.toBeUndefined();
  });

  it("defaults row actions to archive, migrates bare ids, dedupes them, and rejects malformed or too many keys", async () => {
    const { api, harness } = setup();
    await plugin(api);

    const listed = (await harness.behavior.callRpc(
      "listPreferences",
      null,
    )) as {
      preferences: { rowActions: string[] };
    };

    expect(listed.preferences.rowActions).toEqual(["omnyo--core/archive"]);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["pin", "core/archive", "core/pin"],
      }),
    ).resolves.toEqual({
      key: "rowActions",
      value: ["omnyo--core/pin", "omnyo--core/archive"],
    });
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["move", "push-notifications/level"],
      }),
    ).resolves.toEqual({
      key: "rowActions",
      value: ["thread-list/move", "push-notifications/level"],
    });
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["archive", "delete"],
      }),
    ).rejects.toThrow(/Invalid value for rowActions/);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["archive", "pin", "read", "rename"],
      }),
    ).rejects.toThrow(/at most 3 row actions/);
  });

  it("migrates stored bare ids and core/<id> keys and drops unknown ones instead of resetting the rest", async () => {
    const { api, harness } = setup();
    await api.storage.kv.set("preference:rowActions", [
      "pin",
      "futureAction",
      "move",
      "core/rename",
    ]);
    await plugin(api);

    const listed = (await harness.behavior.callRpc(
      "listPreferences",
      null,
    )) as {
      preferences: { rowActions: string[] };
    };

    expect(listed.preferences.rowActions).toEqual([
      "omnyo--core/pin",
      "thread-list/move",
      "omnyo--core/rename",
    ]);
  });

  it("falls back to the default when a stored value no longer parses", async () => {
    const { api, harness } = setup();
    await api.storage.kv.set("preference:chronologicalSort", "by-vibes");
    await plugin(api);

    const listed = (await harness.behavior.callRpc(
      "listPreferences",
      null,
    )) as {
      preferences: { chronologicalSort: string };
    };

    expect(listed.preferences.chronologicalSort).toBe("updated");
  });
});

describe("migration from Omnyo's sidebar preferences", () => {
  it("copies non-default values once and never overwrites a value the plugin already has", async () => {
    const { api } = setup({
      uiPreferences: {
        "sidebar.organizationMode": { revision: 3, value: "machine" },
        "sidebar.sectionOrder": { revision: 1, value: ["proj_a"] },
        "sidebar.chronologicalSort": { revision: 0, value: "updated" },
        "sidebar.hiddenGroups": { revision: 2, value: ["not-a-group"] },
      },
    });

    await api.storage.kv.set("preference:sectionOrder", ["proj_mine"]);
    const first = await migrateFromUiPreferences(api);
    expect(first.migrated).toEqual(["organizationMode"]);
    await expect(
      api.storage.kv.get("preference:organizationMode"),
    ).resolves.toBe("machine");
    await expect(
      api.storage.kv.get("preference:sectionOrder"),
    ).resolves.toEqual(["proj_mine"]);
    await expect(
      api.storage.kv.get("preference:chronologicalSort"),
    ).resolves.toBeUndefined();
    await expect(
      api.storage.kv.get("preference:hiddenGroups"),
    ).resolves.toBeUndefined();

    await api.storage.kv.delete("preference:organizationMode");
    const second = await migrateFromUiPreferences(api);
    expect(second.migrated).toEqual([]);
    await expect(
      api.storage.kv.get("preference:organizationMode"),
    ).resolves.toBeUndefined();
  });

  it("skips the migration without marking it done when Omnyo cannot be read", async () => {
    const { api } = setup({ uiPreferencesFail: true });
    expect((await migrateFromUiPreferences(api)).migrated).toEqual([]);
    await expect(
      api.storage.kv.get("migration:ui-preferences:v1"),
    ).resolves.toBeUndefined();
  });
});

describe("omnyo thread-list prefs", () => {
  it("names the CLI after the plugin id", async () => {
    const builtIn = setup();
    await plugin(builtIn.api);
    expect(builtIn.harness.inspection.registrations.cli?.name).toBe(
      "thread-list",
    );

    const copy = createFakePluginHost({ pluginId: "my-sidebar" });
    await plugin(copy.api);
    expect(copy.harness.inspection.registrations.cli?.name).toBe("my-sidebar");
  });

  it("lists, gets, sets, and resets through the CLI", async () => {
    const { api, harness } = setup();
    await plugin(api);

    const listed = await harness.behavior.runCli(["prefs", "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(defaultPreferences());

    const set = await harness.behavior.runCli([
      "prefs",
      "set",
      "manualSectionOrder",
      '["threads","pinned","sections"]',
    ]);

    expect(set.exitCode).toBe(0);
    expect(set.stdout).toBe(
      'manualSectionOrder = ["threads","pinned","sections"]',
    );

    const bare = await harness.behavior.runCli([
      "prefs",
      "set",
      "organizationMode",
      "project",
    ]);

    expect(bare.exitCode).toBe(0);

    const got = await harness.behavior.runCli([
      "prefs",
      "get",
      "organizationMode",
    ]);

    expect(got.stdout).toBe('"project"');

    const iconsOn = await harness.behavior.runCli([
      "prefs",
      "set",
      "showProviderIcons",
      "true",
    ]);

    expect(iconsOn.exitCode).toBe(0);
    expect(iconsOn.stdout).toBe("showProviderIcons = true");
    await expect(
      api.storage.kv.get("preference:showProviderIcons"),
    ).resolves.toBe(true);

    const resetIcons = await harness.behavior.runCli([
      "prefs",
      "reset",
      "showProviderIcons",
      "--json",
    ]);

    expect(JSON.parse(resetIcons.stdout)).toEqual({
      key: "showProviderIcons",
      value: true,
    });

    const bad = await harness.behavior.runCli([
      "prefs",
      "set",
      "organizationMode",
      "nope",
    ]);

    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toMatch(/Invalid value for organizationMode/);

    const unknown = await harness.behavior.runCli(["prefs", "get", "colour"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toMatch(/Unknown preference: colour/);

    const reset = await harness.behavior.runCli([
      "prefs",
      "reset",
      "organizationMode",
      "--json",
    ]);

    expect(JSON.parse(reset.stdout)).toEqual({
      key: "organizationMode",
      value: "chronological",
    });
  });
});

it("validates lifecycle selection through CLI and RPC and broadcasts it", async () => {
  const { api, harness } = setup();
  await plugin(api);
  expect(
    (
      await harness.behavior.runCli([
        "prefs",
        "set",
        "threadLifecycles",
        '["archived"]',
      ])
    ).exitCode,
  ).toBe(0);
  await expect(
    api.storage.kv.get("preference:threadLifecycles"),
  ).resolves.toEqual(["archived"]);

  for (const value of [[], ["archived", "archived"], ["deleted"]]) {
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "threadLifecycles",
        value,
      }),
    ).rejects.toThrow(/Invalid value/);
  }

  await expect(
    api.storage.kv.get("preference:threadLifecycles"),
  ).resolves.toEqual(["archived"]);
  expect(harness.realtimeSignals).toContainEqual({
    channel: "preferences",
    payload: { key: "threadLifecycles", value: ["archived"], origin: null },
  });
});
