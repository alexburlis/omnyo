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
        {
          id: "omnyo--provider-acp-next",
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
      acpPluginId: "omnyo--provider-acp-next",
      customAgents: [
        { id: "acp-team", displayName: "Team", command: "/opt/team" },
      ],
    });
  });

  it("selects Next even when Classic is enabled or configured", () => {
    const classic = {
      id: "provider-acp",
      enabled: true,
      customAgents: JSON.stringify([
        { id: "legacy", displayName: "Legacy", command: "/opt/legacy" },
      ]),
    };

    expect(
      resolveOnboardingAcpDetection([
        classic,
        { id: "omnyo--provider-acp-next", enabled: false, customAgents: "" },
      ]),
    ).toEqual({ acpPluginId: "omnyo--provider-acp-next", customAgents: [] });
    expect(resolveOnboardingAcpDetection([classic])).toEqual({
      acpPluginId: null,
      customAgents: [],
    });
    expect(resolveOnboardingAcpDetection([])).toEqual({
      acpPluginId: null,
      customAgents: [],
    });
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
