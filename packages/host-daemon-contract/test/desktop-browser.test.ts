import { describe, expect, it } from "vitest";
import {
  desktopBrowserCommandSchema,
  desktopBrowserResultSchemas,
  desktopBrowserInstanceSchema,
  desktopRendererProfileSchema,
} from "../src/desktop-browser.js";
import { desktopBrowserImportSourceIdSchema } from "../src/desktop-browser-import.js";

const scope = {
  instanceId: "window",
  generation: "generation",
  threadId: "thread",
};

describe("desktop browser command boundaries", () => {
  it("bounds renderer capture and keeps older instance capabilities absent", () => {
    const request = {
      type: "desktop.browser.profile_renderer",
      instanceId: "window",
      generation: "generation",
    };

    expect(desktopBrowserCommandSchema.parse(request)).toEqual({
      ...request,
      durationMs: 2000,
    });

    for (const durationMs of [199, 5001, 200.5]) {
      expect(
        desktopBrowserCommandSchema.safeParse({ ...request, durationMs })
          .success,
      ).toBe(false);
    }

    expect(
      desktopBrowserInstanceSchema.parse({
        instanceId: "window",
        generation: "generation",
        label: "Desktop",
      }).rendererProfiling,
    ).toBeUndefined();
  });

  it("rejects content-bearing renderer results and inconsistent sample counts", () => {
    const profile = {
      requestedDurationMs: 2000,
      actualDurationMs: 2001,
      sampleIntervalUs: 1000,
      totalSamples: 3,
      omittedSamples: 1,
      hotspots: [
        { assetPath: "/assets/app-a1.js", line: 1, column: 2, hits: 1 },
      ],
      builtinSamples: { idle: 1, program: 0, garbageCollection: 0 },
      truncated: false,
    };

    expect(desktopRendererProfileSchema.safeParse(profile).success).toBe(true);
    expect(
      desktopRendererProfileSchema.safeParse({ ...profile, totalSamples: 4 })
        .success,
    ).toBe(false);
    expect(
      desktopRendererProfileSchema.safeParse({
        ...profile,
        functionName: "private-content",
      }).success,
    ).toBe(false);

    for (const assetPath of [
      "https://private.test/assets/app.js",
      "/assets/app.js?private=1",
      "/home/alex/app.js",
      "data:private",
      "/assets/nested/app.js",
    ]) {
      expect(
        desktopRendererProfileSchema.safeParse({
          ...profile,
          hotspots: [{ ...profile.hotspots[0], assetPath }],
        }).success,
      ).toBe(false);
    }
  });
  it.each(["dia", "zen", `storage-${"a".repeat(64)}`])(
    "accepts %s import discovery and selection across the wire",
    (sourceId) => {
      expect(
        desktopBrowserCommandSchema.safeParse({
          type: "desktop.browser.import_cookies",
          instanceId: scope.instanceId,
          generation: scope.generation,
          sourceId,
          sourceProfileDirectory: "Default",
        }).success,
      ).toBe(true);
      expect(
        desktopBrowserResultSchemas[
          "desktop.browser.list_import_sources"
        ].safeParse({
          sources: [
            {
              id: sourceId,
              name: "Browser",
              profiles: [{ directory: "Default", name: "Personal" }],
            },
          ],
        }).success,
      ).toBe(true);
    },
  );

  it("carries the default browser recommendation and still accepts listings without one", () => {
    const schema =
      desktopBrowserResultSchemas["desktop.browser.list_import_sources"];

    const sources = [
      {
        id: "dia",
        name: "Dia",
        profiles: [{ directory: "Profile 7", name: "Work" }],
      },
    ];

    expect(
      schema.parse({
        sources,
        recommended: { sourceId: "dia", sourceProfileDirectory: "Profile 7" },
      }).recommended,
    ).toEqual({ sourceId: "dia", sourceProfileDirectory: "Profile 7" });
    expect(schema.parse({ sources })).toEqual({ sources });
    expect(
      schema.safeParse({
        sources,
        recommended: { sourceId: "/tmp/Cookies", sourceProfileDirectory: "" },
      }).success,
    ).toBe(false);
  });

  it("rejects path-shaped and malformed discovered source IDs", () => {
    for (const id of [
      "/tmp/Cookies",
      "../profile",
      "storage-",
      "storage-anything",
      `storage-${"a".repeat(65)}`,
    ]) {
      expect(desktopBrowserImportSourceIdSchema.safeParse(id).success).toBe(
        false,
      );
    }
  });

  it("rejects arbitrary RPC, endpoints, unsupported navigation schemes, and duplicate grants", () => {
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.rpc",
        method: "Runtime.evaluate",
      }).success,
    ).toBe(false);
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.open_connection",
        ...scope,
        leaseId: "lease",
        tabIds: ["tab"],
        endpoint: "http://internal",
      }).success,
    ).toBe(false);

    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,test",
      "https://user:password@example.com",
    ]) {
      expect(
        desktopBrowserCommandSchema.safeParse({
          type: "desktop.browser.create_tab",
          ...scope,
          tabId: "tab",
          url,
          presentation: "hidden",
        }).success,
      ).toBe(false);
    }

    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.acquire_control",
        ...scope,
        leaseId: "lease",
        controllerLabel: "Agent",
        expiresAt: Date.now() + 1000,
        tabIds: ["tab", "tab"],
      }).success,
    ).toBe(false);
  });

  it("requires explicit thread, generation, and scoped local connection results", () => {
    expect(
      desktopBrowserCommandSchema.safeParse({
        type: "desktop.browser.list_tabs",
        instanceId: "window",
      }).success,
    ).toBe(false);

    for (const wsEndpoint of [
      "ws://example.com:1234/",
      "http://127.0.0.1:1234/",
      "ws://user:pass@127.0.0.1:1234/",
    ]) {
      expect(
        desktopBrowserResultSchemas[
          "desktop.browser.open_connection"
        ].safeParse({ wsEndpoint, expiresAt: Date.now() + 1000 }).success,
      ).toBe(false);
    }

    expect(
      desktopBrowserResultSchemas["desktop.browser.open_connection"].safeParse({
        wsEndpoint: "ws://127.0.0.1:1234/scoped/credential",
        expiresAt: Date.now() + 1000,
      }).success,
    ).toBe(true);
  });
});
