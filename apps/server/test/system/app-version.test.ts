import { describe, expect, it, vi } from "vitest";
import { createAppVersionService } from "../../src/services/system/app-version.js";

describe("unpublished Omnyo registry admission", () => {
  it.each(["1.0.0", "1.0.0-nightly.1"])(
    "never queries a public registry for %s",
    async (appVersion) => {
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
        );

      try {
        const service = createAppVersionService({
          sourceCommit: null,
          installKind: "npm",
          config: { appVersion, isDevelopment: false },
        });

        const version = await service.getSystemVersion({ forceRefresh: true });
        expect(provider).not.toHaveBeenCalled();
        expect(version.updateAvailable).toBe(false);
        expect(version.latestVersion).toBeNull();
        expect(version.upgradeCommand).toBe(
          "Use the verified private release installer",
        );
        expect(version.source).toBe("private");
        await service.getSystemVersion({ forceRefresh: true });
        expect(provider).not.toHaveBeenCalled();
      } finally {
        provider.mockRestore();
      }
    },
  );
});

describe("current private version metadata", () => {
  it("never offers upstream npm updates over a private coordinator", async () => {
    const provider = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected provider request"));

    try {
      const service = createAppVersionService({
        sourceCommit: null,
        installKind: "npm",
        config: { appVersion: "0.46.3+private.1", isDevelopment: false },
      });

      const response = await service.getSystemVersion({ forceRefresh: true });
      expect(response).toMatchObject({
        currentVersion: "0.46.3+private.1",
        source: "private",
        latestVersion: null,
        updateAvailable: false,
      });
      expect(response.upgradeCommand).not.toContain("npx");
      expect(provider).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });

  it.each(["source", "desktop", "npm", null] as const)(
    "preserves the actual %s installation identity without fabricating a source commit",
    async (installKind) => {
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected provider request"));

      try {
        const sourceCommit = "a".repeat(40);

        const service = createAppVersionService({
          sourceCommit,
          installKind,
          config: { appVersion: "1.2.3", isDevelopment: false },
        });

        const version = await service.getSystemVersion({ forceRefresh: true });
        expect(version.installKind).toBe(installKind);
        expect(version.currentCommit).toBe(
          installKind === "source" ? sourceCommit : null,
        );
        expect(version.currentVersion).toBe("1.2.3");
        expect(version.latestVersion).toBeNull();
        expect(provider).not.toHaveBeenCalled();
      } finally {
        provider.mockRestore();
      }
    },
  );

  it("keeps development version metadata local without a provider query", async () => {
    const provider = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected provider request"));

    try {
      const service = createAppVersionService({
        sourceCommit: null,
        installKind: "source",
        config: { appVersion: "0.0.0-dev", isDevelopment: true },
      });

      const version = await service.getSystemVersion({ forceRefresh: true });
      expect(version).toMatchObject({
        isDevelopment: true,
        currentVersion: "0.0.0-dev",
        currentCommit: null,
        latestVersion: null,
        updateAvailable: false,
      });
      expect(provider).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });
});
