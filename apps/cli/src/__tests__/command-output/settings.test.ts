import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, defaultExperiments } from "@omnyo/domain";
import {
  collectLogLines,
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerSettingsCommands } from "../../commands/settings.js";

describe("omnyo settings commands", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerSettingsCommands(program, () => "http://server");

  it("clears the setup guide completion time and keeps every other setting", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: {
          ...defaultAppSettings,
          onboardingCompletedAt: "2026-10-01T00:00:00.000Z",
          streamerMode: true,
        },
      })),
      "v1.settings.general.$put": put,
    });

    await runCommand(["settings", "replay-onboarding"], register);

    expect(put).toHaveBeenCalledWith({
      json: {
        ...defaultAppSettings,
        onboardingCompletedAt: null,
        streamerMode: true,
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "The setup guide is showing again",
    ]);
  });

  it("sets and resets a plugin shortcut while preserving other overrides", async () => {
    const other = { command: "plugin:other/open", shortcut: null };
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        keybindingOverrides: [other],
      })),
      "v1.settings.keyboard.$put": put,
    });
    await runCommand(
      ["settings", "keyboard", "set", "plugin:example/open", "Mod+Shift+I"],
      register,
    );
    expect(put).toHaveBeenLastCalledWith({
      json: [
        other,
        {
          command: "plugin:example/open",
          shortcut: {
            key: "I",
            mod: true,
            meta: false,
            control: false,
            alt: false,
            shift: true,
          },
        },
      ],
    });
    await runCommand(
      ["settings", "keyboard", "reset", "plugin:example/open"],
      register,
    );
    expect(put).toHaveBeenLastCalledWith({ json: [other] });
  });

  it("keeps command scopes separate when setting and resetting platform bindings", async () => {
    const general = { command: "thread.new", shortcut: null };
    const mac = { command: "thread.new", platform: "mac", shortcut: null };
    const linux = { command: "thread.new", platform: "linux", shortcut: null };
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        keybindingOverrides: [general, mac, linux],
      })),
      "v1.settings.keyboard.$put": put,
    });
    await runCommand(
      [
        "settings",
        "keyboard",
        "set",
        "thread.new",
        "disabled",
        "--platform",
        "windows",
      ],
      register,
    );
    expect(put).toHaveBeenLastCalledWith({
      json: [
        general,
        mac,
        linux,
        { command: "thread.new", platform: "windows", shortcut: null },
      ],
    });
    await runCommand(
      ["settings", "keyboard", "reset", "thread.new", "--platform", "mac"],
      register,
    );
    expect(put).toHaveBeenLastCalledWith({ json: [general, linux] });
    await runCommand(
      ["settings", "keyboard", "reset", "--platform", "linux"],
      register,
    );
    expect(put).toHaveBeenLastCalledWith({ json: [general, mac] });
  });

  describe("settings ui", () => {
    function stubUiPreferences(revisions: readonly number[]) {
      let listCall = 0;

      const list = vi.fn(async () => {
        const revision = revisions[Math.min(listCall, revisions.length - 1)];
        listCall += 1;

        return {
          preferences: {
            "modelPicker.favorites": { revision, value: [] },
            "modelPicker.footerFavorites": { revision, value: true },
          },
        };
      });

      const put = vi.fn(
        async ({
          json,
          param,
        }: {
          json: { expectedRevision: number; value: unknown };
          param: { key: string };
        }) => ({
          key: param.key,
          revision: json.expectedRevision + 1,
          value: json.value,
        }),
      );

      stubServerApi({
        "v1.preferences.ui.$get": list,
        "v1.preferences.ui.:key.$put": put,
      });

      return { list, put };
    }

    const favorites = [
      {
        providerId: "codex",
        model: "gpt-6.1-sol",
        reasoningLevel: "xhigh",
        serviceTier: "fast",
      },
      {
        providerId: "claude-code",
        model: "claude-opus-5-5",
        reasoningLevel: "ultracode",
      },
    ];

    it("sends model picker favorites parsed from JSON with the current revision", async () => {
      const { put } = stubUiPreferences([4]);

      await runCommand(
        [
          "settings",
          "ui",
          "set",
          "modelPicker.favorites",
          JSON.stringify(favorites),
        ],
        register,
      );

      expect(put).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith({
        json: {
          expectedRevision: 4,
          value: [favorites[0], { ...favorites[1], serviceTier: "default" }],
        },
        param: { key: "modelPicker.favorites" },
      });
      expect(collectLogLines(vi.mocked(console.log))).toEqual([
        "modelPicker.favorites updated",
      ]);
    });

    it("retries a stale favorites write once against the refreshed revision", async () => {
      const { list, put } = stubUiPreferences([4, 7]);
      put.mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              code: "ui_preference_conflict",
              details: { currentRevision: 7 },
              message: "UI preference changed on another client",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ) as never,
      );

      await runCommand(
        [
          "settings",
          "ui",
          "set",
          "modelPicker.favorites",
          JSON.stringify(favorites.slice(0, 1)),
        ],
        register,
      );

      expect(list).toHaveBeenCalledTimes(2);
      expect(
        put.mock.calls.map(([args]) => args.json.expectedRevision),
      ).toEqual([4, 7]);
    });

    it("rejects a malformed favorite without writing", async () => {
      const { put } = stubUiPreferences([0]);

      await expect(
        runCommand(
          [
            "settings",
            "ui",
            "set",
            "modelPicker.favorites",
            JSON.stringify([{ ...favorites[0], label: "Sol" }]),
          ],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Lists, objects, numbers and null take JSON; plain strings may be unquoted.",
        ),
      );
      expect(put).not.toHaveBeenCalled();
    });

    it("sends the composer favorites switch as a boolean", async () => {
      const { put } = stubUiPreferences([2]);

      await runCommand(
        ["settings", "ui", "set", "modelPicker.footerFavorites", "false"],
        register,
      );

      expect(put).toHaveBeenCalledWith({
        json: { expectedRevision: 2, value: false },
        param: { key: "modelPicker.footerFavorites" },
      });
    });
  });

  const completedTurnProviders = [
    {
      id: "claude-code",
      displayName: "Claude Code",
      completedTurnDisplay: "flat",
    },
    { id: "codex", displayName: "Codex", completedTurnDisplay: "collapse" },
  ];

  it("lists each provider's finished turn display and where it comes from", async () => {
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: {
          ...defaultAppSettings,
          providerCompletedTurnDisplay: { codex: "flat" },
        },
        experiments: defaultExperiments,
      })),
      "v1.system.providers.$get": vi.fn(async () => completedTurnProviders),
    });

    await runCommand(["settings", "completed-turns", "--json"], register);

    expect(
      collectLogPayloads(vi.mocked(console.log)).map((payload) =>
        JSON.parse(payload),
      ),
    ).toEqual([
      [
        {
          providerId: "claude-code",
          displayName: "Claude Code",
          completedTurnDisplay: "flat",
          providerDefault: "flat",
          source: "provider-default",
        },
        {
          providerId: "codex",
          displayName: "Codex",
          completedTurnDisplay: "flat",
          providerDefault: "collapse",
          source: "setting",
        },
      ],
    ]);
  });

  it("stores a per-provider override and keeps the other overrides", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: {
          ...defaultAppSettings,
          providerCompletedTurnDisplay: { codex: "flat" },
        },
        experiments: defaultExperiments,
      })),
      "v1.system.providers.$get": vi.fn(async () => completedTurnProviders),
      "v1.settings.general.$put": put,
    });

    await runCommand(
      ["settings", "completed-turns", "claude-code", "collapse"],
      register,
    );

    expect(put).toHaveBeenCalledWith({
      json: {
        ...defaultAppSettings,
        providerCompletedTurnDisplay: {
          codex: "flat",
          "claude-code": "collapse",
        },
      },
    });
    expect(console.log).toHaveBeenCalledWith(
      "claude-code finished turns: collapse (setting)",
    );
  });

  it("removes the override when set back to default", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: {
          ...defaultAppSettings,
          providerCompletedTurnDisplay: {
            codex: "flat",
            "claude-code": "collapse",
          },
        },
        experiments: defaultExperiments,
      })),
      "v1.system.providers.$get": vi.fn(async () => completedTurnProviders),
      "v1.settings.general.$put": put,
    });

    await runCommand(
      ["settings", "completed-turns", "claude-code", "default"],
      register,
    );

    expect(put).toHaveBeenCalledWith({
      json: {
        ...defaultAppSettings,
        providerCompletedTurnDisplay: { codex: "flat" },
      },
    });
    expect(console.log).toHaveBeenCalledWith(
      "claude-code finished turns: flat (provider default)",
    );
  });

  it("rejects an unknown provider or display without writing settings", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.system.providers.$get": vi.fn(async () => completedTurnProviders),
      "v1.settings.general.$put": put,
    });

    await expect(
      runCommand(["settings", "completed-turns", "cursor", "flat"], register),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Unknown provider 'cursor'. Known providers: claude-code, codex.",
      ),
    );

    await expect(
      runCommand(["settings", "completed-turns", "codex", "open"], register),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid finished turn display 'open'. Use collapse, flat, or default.",
      ),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("updates one general setting while preserving the full contract", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": put,
    });

    await runCommand(
      ["settings", "general", "showDiagnosticEvents", "true"],
      register,
    );

    expect(put).toHaveBeenCalledWith({
      json: { ...defaultAppSettings, showDiagnosticEvents: true },
    });
  });

  it("disables automatic machine Git credentials despite the legacy response alias", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: {
          ...defaultAppSettings,
          showUnhandledProviderEvents: false,
        },
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": put,
    });
    await runCommand(
      ["settings", "general", "machineGitCredentialsEnabled", "false"],
      register,
    );
    expect(put).toHaveBeenCalledWith({
      json: { ...defaultAppSettings, machineGitCredentialsEnabled: false },
    });
  });

  it("rejects an unknown general setting key", async () => {
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": vi.fn(async ({ json }) => json),
    });

    await expect(
      runCommand(["settings", "general", "notASetting", "true"], register),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown general setting 'notASetting'"),
    );
  });

  it("updates keyboard hint visibility while preserving the full contract", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": put,
    });

    await runCommand(["settings", "keyboard", "hints", "false"], register);

    expect(put).toHaveBeenCalledWith({
      json: { ...defaultAppSettings, showKeyboardHints: false },
    });
  });

  it("disables thread archive confirmation through general settings", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": put,
    });
    await runCommand(
      ["settings", "general", "confirmThreadArchive", "off"],
      register,
    );
    expect(put).toHaveBeenCalledWith({
      json: { ...defaultAppSettings, confirmThreadArchive: false },
    });
  });

  it("sets new-chat approval defaults and resets model overrides through general settings", async () => {
    const put = vi.fn(async ({ json }) => json);

    const settings = {
      ...defaultAppSettings,
      defaultPermissionMode: "accept-edits" as const,
    };

    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: settings,
      })),
      "v1.settings.general.$put": put,
    });

    await runCommand(
      ["settings", "general", "defaultPermissionMode", "full"],
      register,
    );
    expect(put).toHaveBeenLastCalledWith({
      json: { ...settings, defaultPermissionMode: "full" },
    });

    await runCommand(
      [
        "settings",
        "general",
        "modelPermissionModes",
        '{"codex":{"gpt-5":"auto"}}',
      ],
      register,
    );
    expect(put).toHaveBeenLastCalledWith({
      json: {
        ...settings,
        modelPermissionModes: { codex: { "gpt-5": "auto" } },
      },
    });

    await runCommand(
      ["settings", "general", "modelPermissionModes", "{}"],
      register,
    );
    expect(put).toHaveBeenLastCalledWith({ json: settings });
  });

  it("enables the server move experiment", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({ "v1.settings.experiments.$put": put });

    await runCommand(
      ["settings", "experiment", "serverMove", "true"],
      register,
    );

    expect(put).toHaveBeenCalledWith({ json: { serverMove: true } });
  });

  it("reads usage from a selected machine", async () => {
    const getUsage = vi.fn(async () => ({
      codex: { status: "unauthenticated" },
      "claude-code": { status: "unauthenticated" },
      "acp-cursor": { status: "unauthenticated" },
    }));

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          status: "connected",
          lastSeenAt: 1,
          lastRejectedProtocolVersion: null,
          runtimeVersion: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.system.usage-limits.$get": getUsage,
    });

    await runCommand(
      ["settings", "usage", "--machine", "builder", "--refresh", "--json"],
      register,
    );

    expect(getUsage).toHaveBeenCalledWith({
      query: { hostId: "host-remote", refresh: "true" },
    });
  });

  it("reads privacy status with inherited JSON without shadowing provider usage", async () => {
    const status = {
      count: { effective: false },
      product: { effective: false },
    };

    const getStatus = vi.fn(async () => status);
    stubServerApi({ "v1.system.usage.$get": getStatus });
    await runCommand(["settings", "usage", "--json", "status"], register);
    expect(getStatus).toHaveBeenCalled();
    expect(
      collectLogPayloads(vi.mocked(console.log)).map((payload) =>
        JSON.parse(payload),
      ),
    ).toEqual([status]);
  });

  describe("ai-services", () => {
    const aiView = {
      selections: {
        "thread-title": { mode: "automatic" },
        "commit-message": {
          mode: "service",
          pluginId: "my-openrouter",
          serviceId: "helper",
        },
        voice: { mode: "off" },
      },
      services: [
        {
          id: "codex",
          displayName: "Codex",
          pluginId: "provider-codex",
          tasks: ["thread-title", "commit-message", "voice"],
          automaticRank: 0,
          status: { ready: false, message: "Run `codex login`" },
        },
        {
          id: "helper",
          displayName: "OpenRouter",
          pluginId: "my-openrouter",
          tasks: ["thread-title", "commit-message"],
          automaticRank: null,
          status: { ready: true },
        },
        {
          id: "helper",
          displayName: "Other helper",
          pluginId: "other-plugin",
          tasks: ["thread-title", "commit-message"],
          automaticRank: null,
          status: { ready: true },
        },
      ],
    };

    function stubAiServices() {
      const put = vi.fn(async ({ json }) => ({
        ...aiView,
        selections: { ...aiView.selections, [json.task]: json.selection },
      }));

      const test = vi.fn(async () => ({
        ok: true,
        pluginId: "my-openrouter",
        serviceId: "helper",
        displayName: "OpenRouter",
        text: "Add a dark mode toggle",
        durationMs: 250,
      }));

      stubServerApi({
        "v1.system.ai-services.$get": vi.fn(async () => aiView),
        "v1.system.ai-services.selection.$put": put,
        "v1.system.ai-services.test.$post": test,
      });

      return { put, test };
    }

    afterEach(() => {
      process.exitCode = undefined;
    });

    it("shows each task's choice and every service", async () => {
      stubAiServices();

      await runCommand(["settings", "ai-services"], register);

      const lines = collectLogLines(vi.mocked(console.log));
      expect(lines[0]).toBe("thread-title    Automatic (nothing ready)");
      expect(lines[1]).toBe("commit-message  OpenRouter");
      expect(lines[2]).toBe("voice           Off");
      expect(lines).toContain(
        "  codex  Codex  plugin provider-codex  [thread-title, commit-message, voice]  Automatic #1  not ready: Run `codex login`",
      );
      expect(lines).toContain(
        "  helper  Other helper  plugin other-plugin  [thread-title, commit-message]  ready",
      );
    });

    it("sets automatic, off, and a service picked by id and plugin", async () => {
      const { put } = stubAiServices();

      await runCommand(
        ["settings", "ai-services", "set", "voice", "automatic"],
        register,
      );
      await runCommand(
        ["settings", "ai-services", "set", "thread-title", "off"],
        register,
      );
      await runCommand(
        [
          "settings",
          "ai-services",
          "set",
          "commit-message",
          "helper",
          "--plugin",
          "other-plugin",
        ],
        register,
      );

      expect(put.mock.calls.map(([request]) => request.json)).toEqual([
        { task: "voice", selection: { mode: "automatic" } },
        { task: "thread-title", selection: { mode: "off" } },
        {
          task: "commit-message",
          selection: {
            mode: "service",
            pluginId: "other-plugin",
            serviceId: "helper",
          },
        },
      ]);
      expect(console.log).toHaveBeenLastCalledWith(
        "commit-message: Other helper",
      );
    });

    it("refuses an ambiguous, unknown, or ineligible service without saving", async () => {
      const { put } = stubAiServices();

      await expect(
        runCommand(
          ["settings", "ai-services", "set", "thread-title", "helper"],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Several plugins register AI service 'helper': my-openrouter, other-plugin. Pass --plugin <plugin-id>.",
        ),
      );

      await expect(
        runCommand(
          ["settings", "ai-services", "set", "voice", "helper"],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "No AI service 'helper' handles voice. Choose automatic, off, or one of: codex.",
        ),
      );

      await expect(
        runCommand(
          ["settings", "ai-services", "set", "subtitles", "codex"],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Unknown task 'subtitles'. Tasks: thread-title, commit-message, voice",
        ),
      );
      expect(put).not.toHaveBeenCalled();
    });

    it("runs a test and reports a failure with a non-zero exit code", async () => {
      const { test } = stubAiServices();

      await runCommand(
        ["settings", "ai-services", "test", "commit-message"],
        register,
      );
      expect(test).toHaveBeenCalledWith({ json: { task: "commit-message" } });
      expect(console.log).toHaveBeenLastCalledWith(
        "OpenRouter (250ms): Add a dark mode toggle",
      );
      expect(process.exitCode).toBeUndefined();

      test.mockResolvedValueOnce({
        ok: false,
        message: "OpenRouter: bad key",
        durationMs: 40,
      } as never);
      await runCommand(
        ["settings", "ai-services", "test", "thread-title"],
        register,
      );
      expect(console.log).toHaveBeenLastCalledWith(
        "Failed after 40ms: OpenRouter: bad key",
      );
      expect(process.exitCode).toBe(1);

      await expect(
        runCommand(["settings", "ai-services", "test", "voice"], register),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Unknown task 'voice'. Testable tasks: thread-title, commit-message",
        ),
      );
    });
  });
});
