import { describe, expect, it } from "vitest";
import { resolveOnboardingAcpDetection } from "../../../src/services/system/onboarding-provider-detection.js";
import { hostCommandMayWake } from "../../../src/services/hosts/wake-policy.js";

describe("onboarding ACP discovery", () => {
  it("does not wake a suspended machine to detect installed providers", () => {
    expect(
      hostCommandMayWake({
        type: "host.detect_provider_clis",
        customAgents: [],
      }),
    ).toBe(false);
  });
  it("preserves a disabled adapter with custom agents and passes only executable lookup fields", () => {
    expect(
      resolveOnboardingAcpDetection([
        { id: "omnyo--provider-acp-next", enabled: false, customAgents: "" },
        {
          id: "provider-acp",
          enabled: false,
          customAgents: JSON.stringify([
            {
              id: "team",
              displayName: "Team",
              command: "/opt/team",
              args: ["acp"],
              env: { EXAMPLE: "ignored" },
            },
          ]),
        },
      ]),
    ).toEqual({
      acpPluginId: "provider-acp",
      customAgents: [
        { id: "acp-team", displayName: "Team", command: "/opt/team" },
      ],
    });
  });

  it("prefers the enabled adapter and otherwise uses the new adapter for a fresh setup", () => {
    const plugins = [
      { id: "omnyo--provider-acp-next", enabled: false, customAgents: "" },
      { id: "provider-acp", enabled: true, customAgents: "" },
    ] as const;

    expect(resolveOnboardingAcpDetection(plugins).acpPluginId).toBe(
      "provider-acp",
    );
    expect(
      resolveOnboardingAcpDetection(
        plugins.map((plugin) => ({ ...plugin, enabled: false })),
      ).acpPluginId,
    ).toBe("omnyo--provider-acp-next");
  });

  it("does not treat a package runner as an installed ACP agent", () => {
    expect(
      resolveOnboardingAcpDetection([
        {
          id: "omnyo--provider-acp-next",
          enabled: false,
          customAgents: JSON.stringify([
            {
              id: "registry-agent",
              displayName: "Registry agent",
              command: "npx",
              args: ["-y", "agent-package"],
            },
          ]),
        },
      ]).customAgents,
    ).toEqual([]);
  });
});
