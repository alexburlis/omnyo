import { describe, expect, it } from "vitest";
import {
  detectedOnboardingProviders,
  initialOnboardingProviderSelected,
  ONBOARDING_PROVIDERS,
  onboardingProviderChanges,
} from "./provider-selection";

describe("onboarding provider selection", () => {
  it("preselects detected CLIs and preserves existing choices on replay or failed detection", () => {
    expect(
      initialOnboardingProviderSelected({
        id: "codex",
        replay: false,
        detected: ["Codex"],
        enabled: false,
      }),
    ).toBe(true);
    expect(
      initialOnboardingProviderSelected({
        id: "codex",
        replay: false,
        detected: [],
        enabled: true,
      }),
    ).toBe(false);
    expect(
      initialOnboardingProviderSelected({
        id: "codex",
        replay: false,
        detected: undefined,
        enabled: true,
      }),
    ).toBe(true);
    expect(
      initialOnboardingProviderSelected({
        id: "codex",
        replay: true,
        detected: ["Codex"],
        enabled: false,
      }),
    ).toBe(false);
    expect(
      initialOnboardingProviderSelected({
        id: "acp",
        replay: false,
        detected: [],
        enabled: true,
      }),
    ).toBe(true);
  });
  it("offers one ACP option alongside Claude Code and Codex", () => {
    expect(ONBOARDING_PROVIDERS.map((provider) => provider.id)).toEqual([
      "acp",
      "claude-code",
      "codex",
    ]);
  });

  it("distinguishes failed detection from a completed check with no installed CLI", () => {
    expect(detectedOnboardingProviders("acp", undefined)).toBeUndefined();
    expect(detectedOnboardingProviders("acp", { providers: [] })).toEqual([]);
    expect(
      detectedOnboardingProviders("acp", {
        providers: [
          { id: "acp-opencode", displayName: "OpenCode", installed: true },
          { id: "acp-cursor", displayName: "Cursor", installed: false },
          { id: "codex", displayName: "Codex", installed: true },
        ],
      }),
    ).toEqual(["OpenCode"]);
  });

  it("keeps an enabled legacy ACP instead of switching its adapter", () => {
    expect(
      onboardingProviderChanges({
        id: "acp",
        enabled: true,
        plugins: [
          { id: "provider-acp", enabled: true },
          { id: "omnyo--provider-acp-next", enabled: false },
        ],
      }),
    ).toEqual([]);
  });

  it("chooses the new adapter for a fresh selection and disables both to turn ACP off", () => {
    const plugins = [
      { id: "provider-acp", enabled: false },
      { id: "omnyo--provider-acp-next", enabled: false },
    ];

    expect(
      onboardingProviderChanges({ id: "acp", enabled: true, plugins }),
    ).toEqual([{ pluginId: "omnyo--provider-acp-next", enabled: true }]);
    expect(
      onboardingProviderChanges({
        id: "acp",
        enabled: false,
        plugins: [
          ...plugins.slice(0, 1),
          { id: "omnyo--provider-acp-next", enabled: true },
        ],
      }),
    ).toEqual([
      { pluginId: "omnyo--provider-acp-next", enabled: false },
      { pluginId: "provider-acp", enabled: false },
    ]);
  });

  it("uses the adapter that owns saved custom agents", () => {
    expect(
      onboardingProviderChanges({
        id: "acp",
        enabled: true,
        preferredAcpPluginId: "provider-acp",
        plugins: [
          { id: "provider-acp", enabled: false },
          { id: "omnyo--provider-acp-next", enabled: false },
        ],
      }),
    ).toEqual([{ pluginId: "provider-acp", enabled: true }]);
  });
});
