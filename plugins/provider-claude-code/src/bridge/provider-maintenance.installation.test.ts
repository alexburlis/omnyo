import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{
  tags: string;
  channel: string;
  compatibilityOnly: boolean;
  executablePath: string | null;
}>(() => ({
  tags: "",
  channel: "latest",
  compatibilityOnly: false,
  executablePath: "/test/claude",
}));

vi.mock("@omnyo/plugin-sdk/provider-bridge", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@omnyo/plugin-sdk/provider-bridge")
  >()),
  experimental_resolveExecutablePath: async () => state.executablePath,
  experimental_probeNpmGlobalPackage: async () => {
    if (state.compatibilityOnly)
      throw new Error("Update discovery ran during compatibility validation");

    return { npmBin: null, npmGlobalPackageVersion: null };
  },
  experimental_commandOutput: async (_command: string, args: string[]) => {
    if (state.compatibilityOnly && args[0] !== "--version")
      throw new Error("Update discovery ran during compatibility validation");

    if (args[0] === "view") return state.tags;

    if (args[0] === "--version") return "2.1.274 (Claude Code)";

    if (args[0] === "doctor") {
      return `Running: native\nAuto-update channel: ${state.channel}`;
    }

    throw new Error(`Unexpected command arguments: ${args.join(" ")}`);
  },
}));

import {
  getClaudeProviderInstallationRun,
  getClaudeProviderInstallationStatus,
} from "./provider-maintenance.js";

const tags = { stable: "2.1.274", latest: "2.1.283", next: "2.1.283" };

describe("Claude Code installation status", () => {
  it.each([
    "C:\\Users\\pc\\.local\\bin\\claude.exe",
    "C:\\Users\\Test User\\.local\\bin\\claude.exe",
    "/test/claude",
    null,
  ])("updates the detected executable at %s", async (executablePath) => {
    state.tags = JSON.stringify(tags);
    state.channel = "latest";
    state.executablePath = executablePath;

    try {
      const run = await getClaudeProviderInstallationRun("update");

      expect(run).toMatchObject({
        available: true,
        command: {
          command: executablePath ?? "claude",
          args: ["update"],
          displayCommand: "claude update",
        },
      });
    } finally {
      state.executablePath = "/test/claude";
    }
  });

  it("checks the local installation without npm or doctor probes", async () => {
    state.compatibilityOnly = true;

    try {
      const status = await getClaudeProviderInstallationStatus(false);
      expect(status).toMatchObject({
        installed: true,
        currentVersion: "2.1.274",
        versionUnsupported: false,
        latestVersion: null,
      });
    } finally {
      state.compatibilityOnly = false;
    }
  });

  it.each([
    ["npm 11", JSON.stringify(tags), "latest", "2.1.283", true],
    ["npm 12", JSON.stringify([tags]), "latest", "2.1.283", true],
    ["npm 11", JSON.stringify(tags), "stable", "2.1.274", false],
    ["npm 12", JSON.stringify([tags]), "stable", "2.1.274", false],
    [
      "npm 12 without stable",
      '[{"latest":"2.1.283"}]',
      "stable",
      "2.1.283",
      true,
    ],
  ])(
    "reads %s dist-tags (case %#)",
    async (_npm, output, channel, latestVersion, needsUpdate) => {
      state.tags = output;
      state.channel = channel;

      const status = await getClaudeProviderInstallationStatus();

      expect(status.latestVersion).toBe(latestVersion);
      expect(status.needsUpdate).toBe(needsUpdate);
      expect(status.installAction?.kind ?? null).toBe(
        needsUpdate ? "update" : null,
      );
    },
  );

  it.each([
    ["multiple packages", JSON.stringify([tags, tags])],
    ["empty array", "[]"],
    ["invalid JSON", "{"],
    ["missing latest", '[{"stable":"2.1.274"}]'],
  ])("reports an unknown version for %s", async (_name, output) => {
    state.tags = output;
    state.channel = "latest";

    const status = await getClaudeProviderInstallationStatus();

    expect(status.latestVersion).toBeNull();
    expect(status.needsUpdate).toBe(false);
    expect(status.installAction).toBeNull();
  });
});
