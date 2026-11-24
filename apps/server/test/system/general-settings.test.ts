import * as processErrorReporting from "@omnyo/process-utils/error-reporting";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getAppSettings } from "@omnyo/db";
import {
  appSettingsSchema,
  defaultAppSettings,
  type AppSettings,
} from "@omnyo/domain";
import { setProcessErrorReportingEnabled } from "@omnyo/process-utils/error-reporting";
import { systemConfigResponseSchema } from "@omnyo/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { seedHost, seedHostSession, seedPrimaryHost } from "../helpers/seed.js";

describe("general settings", () => {
  it("preserves newer settings across older clients and clears them explicitly", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { name: "Mac Pro" });

      const put = (settings: Partial<AppSettings>) =>
        harness.app.request("/api/v1/settings/general", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        });

      expect(
        (
          await put({
            ...defaultAppSettings,
            defaultThreadMachineId: host.id,
            defaultPermissionMode: "accept-edits",
            modelPermissionModes: { codex: { "gpt-5": "full" } },
            providerAllowFastServiceTier: { codex: true, "claude-code": false },
          })
        ).status,
      ).toBe(200);
      const legacy = { ...defaultAppSettings };
      Reflect.deleteProperty(legacy, "defaultThreadMachineId");
      Reflect.deleteProperty(legacy, "defaultPermissionMode");
      Reflect.deleteProperty(legacy, "modelPermissionModes");
      Reflect.deleteProperty(legacy, "providerAllowFastServiceTier");
      expect((await put({ ...legacy, showKeyboardHints: false })).status).toBe(
        200,
      );

      const config = await readJson(
        await harness.app.request("/api/v1/system/config"),
      );

      expect(config).toMatchObject({
        generalSettings: {
          defaultThreadMachineId: host.id,
          defaultPermissionMode: "accept-edits",
          modelPermissionModes: { codex: { "gpt-5": "full" } },
          providerAllowFastServiceTier: { codex: true, "claude-code": false },
          showKeyboardHints: false,
        },
      });
      expect(
        (await put({ ...defaultAppSettings, defaultThreadMachineId: null }))
          .status,
      ).toBe(200);
      expect(
        await readJson(await harness.app.request("/api/v1/system/config")),
      ).toMatchObject({
        generalSettings: {
          defaultThreadMachineId: null,
          defaultPermissionMode: "auto",
          modelPermissionModes: {},
          providerAllowFastServiceTier: {},
        },
      });
    });
  });

  it("rejects unknown default machines but allows a known offline machine", async () => {
    await withTestHarness(async (harness) => {
      const put = (id: string) =>
        harness.app.request("/api/v1/settings/general", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...defaultAppSettings,
            defaultThreadMachineId: id,
          }),
        });

      expect((await put("missing-machine")).status).toBe(400);
      const host = seedHost(harness.deps, { name: "Offline Mac" });
      expect((await put(host.id)).status).toBe(200);
    });
  });

  it("reports only the server's local host in /system/config", async () => {
    await withTestHarness(async (harness) => {
      seedHostSession(harness.deps, { name: "remote" });
      const before = await harness.app.request("/api/v1/system/config");

      const uninitialized = systemConfigResponseSchema.parse(
        await readJson(before),
      );

      expect(uninitialized.primaryHostId).toBeNull();
      expect(uninitialized.primaryHostPlatform).toBeNull();

      const { host: local } = seedHostSession(harness.deps, { name: "local" });
      seedPrimaryHost(harness.deps, local.id);
      const after = await harness.app.request("/api/v1/system/config");

      const initialized = systemConfigResponseSchema.parse(
        await readJson(after),
      );

      expect(initialized.primaryHostId).toBe(local.id);
      expect(initialized.primaryHostPlatform).toBe("darwin");
    });
  });

  it("defaults general settings in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const body = systemConfigResponseSchema.parse(await readJson(response));
      expect(body.generalSettings).toEqual({
        ...defaultAppSettings,
        machineGitCredentialsEnabled: false,
        showUnhandledProviderEvents: false,
      });
      expect(body.primaryHostId).toBeNull();
    });
  });

  it("persists a PUT and reflects it in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...defaultAppSettings,
          showKeyboardHints: false,
          allowFastServiceTier: false,
          providerAllowFastServiceTier: { codex: true, "claude-code": false },
          steerActiveThreadOnEnter: true,
          providerOrder: ["pi", "codex"],
          defaultProviderId: "pi",
        }),
      });

      expect(put.status).toBe(200);
      expect(
        appSettingsSchema
          .extend({
            showUnhandledProviderEvents:
              appSettingsSchema.shape.showDiagnosticEvents,
          })
          .parse(await readJson(put)),
      ).toEqual({
        ...defaultAppSettings,
        showKeyboardHints: false,
        allowFastServiceTier: false,
        providerAllowFastServiceTier: { codex: true, "claude-code": false },
        steerActiveThreadOnEnter: true,
        providerOrder: ["pi", "codex"],
        defaultProviderId: "pi",
        showUnhandledProviderEvents: false,
      });
      expect(getAppSettings(harness.db)).toEqual({
        ...defaultAppSettings,
        showKeyboardHints: false,
        allowFastServiceTier: false,
        providerAllowFastServiceTier: { codex: true, "claude-code": false },
        steerActiveThreadOnEnter: true,
        providerOrder: ["pi", "codex"],
        defaultProviderId: "pi",
      });

      const config = await harness.app.request("/api/v1/system/config");

      const parsedConfig = systemConfigResponseSchema.parse(
        await readJson(config),
      );

      expect(parsedConfig.generalSettings).toEqual({
        ...defaultAppSettings,
        showUnhandledProviderEvents: false,
        showKeyboardHints: false,
        allowFastServiceTier: false,
        providerAllowFastServiceTier: { codex: true, "claude-code": false },
        steerActiveThreadOnEnter: true,
        providerOrder: ["pi", "codex"],
        defaultProviderId: "pi",
      });
    });
  });

  it("rejects payloads that are not the full general settings object", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });

  it("rejects unknown general settings fields", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...defaultAppSettings,
          unused: true,
        }),
      });

      expect(response.status).toBe(400);
    });
  });
});

it("accepts old SDK payloads and round-trips edits through either setting name", async () => {
  await withTestHarness(async (harness) => {
    const { showDiagnosticEvents, ...legacy } = defaultAppSettings;
    expect(showDiagnosticEvents).toBe(false);

    const update = async (settings: object) => {
      const response = await harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });

      expect(response.status).toBe(200);

      return appSettingsSchema
        .extend({
          showUnhandledProviderEvents:
            appSettingsSchema.shape.showDiagnosticEvents,
        })
        .parse(await readJson(response));
    };

    const enabled = await update({
      ...legacy,
      showUnhandledProviderEvents: true,
    });

    expect(enabled.showDiagnosticEvents).toBe(true);

    const disabled = await update({
      ...enabled,
      showUnhandledProviderEvents: false,
    });

    expect(disabled.showDiagnosticEvents).toBe(false);

    const newEnabled = await update({
      ...disabled,
      showDiagnosticEvents: true,
    });

    expect(newEnabled.showUnhandledProviderEvents).toBe(true);
    expect(getAppSettings(harness.db).showDiagnosticEvents).toBe(true);
  });
});

it("preserves telemetry opt-out when older clients update other settings", async () => {
  await withTestHarness(async (harness) => {
    const put = (settings: object) =>
      harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });

    expect(
      (await put({ ...defaultAppSettings, telemetryEnabled: false })).status,
    ).toBe(200);
    expect(getAppSettings(harness.db).telemetryEnabled).toBe(false);
    const { telemetryEnabled, ...legacy } = defaultAppSettings;
    expect(telemetryEnabled).toBe(true);
    expect((await put({ ...legacy, showKeyboardHints: false })).status).toBe(
      200,
    );

    const config = systemConfigResponseSchema.parse(
      await readJson(await harness.app.request("/api/v1/system/config")),
    );

    expect(config.generalSettings.telemetryEnabled).toBe(false);
    expect(config.generalSettings.showKeyboardHints).toBe(false);
  });
});

it.each([
  "confirmThreadArchive",
  "showGitChanges",
  "crashReportsEnabled",
] as const)(
  "persists %s opt-out and preserves it for older clients",
  async (key) => {
    await withTestHarness(async (harness) => {
      const put = (settings: object) =>
        harness.app.request("/api/v1/settings/general", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        });

      expect(getAppSettings(harness.db)[key]).toBe(true);
      expect((await put({ ...defaultAppSettings, [key]: false })).status).toBe(
        200,
      );
      expect(getAppSettings(harness.db)[key]).toBe(false);
      const { [key]: omitted, ...legacy } = defaultAppSettings;
      expect(omitted).toBe(true);
      expect((await put({ ...legacy, showKeyboardHints: false })).status).toBe(
        200,
      );

      const config = systemConfigResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/system/config")),
      );

      expect(config.generalSettings[key]).toBe(false);
      expect(config.generalSettings.showKeyboardHints).toBe(false);
      expect((await put({ ...defaultAppSettings, [key]: true })).status).toBe(
        200,
      );
      expect(getAppSettings(harness.db)[key]).toBe(true);
    });
  },
);

it("stops and resumes coordinator crash reports when the setting changes", async () => {
  const replacePolicy = vi.spyOn(
    processErrorReporting,
    "setProcessErrorReportingEnabled",
  );

  await withTestHarness(async (harness) => {
    const put = (crashReportsEnabled: boolean) =>
      harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...defaultAppSettings, crashReportsEnabled }),
      });

    try {
      expect((await put(false)).status).toBe(200);
      expect(replacePolicy).toHaveBeenLastCalledWith(false);
      expect((await put(true)).status).toBe(200);
      expect(replacePolicy).toHaveBeenLastCalledWith(true);
    } finally {
      setProcessErrorReportingEnabled(true);
      replacePolicy.mockRestore();
    }
  });
});

describe("system config diagnostics", () => {
  const readConfig = async (harness: TestAppHarness) =>
    systemConfigResponseSchema.parse(
      await readJson(await harness.app.request("/api/v1/system/config")),
    );

  it("reports the runtime release without a DSN when error reporting is disabled", async () => {
    await withTestHarness(async (harness) => {
      const config = await readConfig(harness);

      expect(config.diagnostics).toEqual({ release: "0.0.0-test" });
      expect(config.generalSettings.crashReportsEnabled).toBe(true);
    });
  });

  it("exposes the enabled error reporting DSN with the runtime release", async () => {
    const errorReportingDsn = "https://public@sentry.example.invalid/1";

    await withTestHarness(
      { appVersion: "0.46.300+private.1", errorReportingDsn },
      async (harness) => {
        expect((await readConfig(harness)).diagnostics).toEqual({
          release: "0.46.300+private.1",
          sentryDsn: errorReportingDsn,
        });
      },
    );
  });

  it("accepts responses from older servers without diagnostics or crash reports", async () => {
    await withTestHarness(async (harness) => {
      const {
        diagnostics: _diagnostics,
        generalSettings: {
          crashReportsEnabled: _crashReports,
          ...olderSettings
        },
        ...olderResponse
      } = z
        .looseObject({
          diagnostics: z.unknown(),
          generalSettings: z.record(z.string(), z.unknown()),
        })
        .parse(
          await readJson(await harness.app.request("/api/v1/system/config")),
        );

      const parsed = systemConfigResponseSchema.parse({
        ...olderResponse,
        generalSettings: olderSettings,
      });

      expect(parsed.diagnostics).toBeUndefined();
      expect(parsed.generalSettings.crashReportsEnabled).toBe(true);
    });
  });
});
