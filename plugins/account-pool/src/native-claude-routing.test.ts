import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { registerNativeClaudeRouting } from "./native-claude-routing.js";

const profileIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];

it("routes around an exhausted profile and shares usage readings across launches", async () => {
  const usedPercent = new Map([
    [profileIds[0], 100],
    [profileIds[1], 40],
  ]);

  const usage = vi.fn(async ({ profileId }: { profileId: string }) => ({
    action: "usage",
    usage: {
      status: "ok",
      windows: [
        {
          label: "7D",
          usedPercent: usedPercent.get(profileId),
          resetsAt: null,
        },
      ],
    },
  }));

  const { api, harness } = createFakePluginHost({
    sdk: { providers: { claudeProfiles: { usage } } },
  });

  let now = 0;
  registerNativeClaudeRouting(
    api,
    () => 0.98,
    () => now,
  );

  const select = () =>
    harness.callRpc("experimental_nativeClaudeRouting.v1.select", {
      hostId: "host_mac",
      profileIds,
    });

  try {
    const expected = { kind: "selected", profileId: profileIds[1] };
    await expect(select()).resolves.toEqual(expected);
    await expect(select()).resolves.toEqual(expected);
    expect(usage).toHaveBeenCalledTimes(2);

    usedPercent.set(profileIds[1], 100);
    now = 60_000;
    await expect(select()).resolves.toEqual({ kind: "exhausted" });
  } finally {
    await harness.lifecycle.dispose();
  }
});
