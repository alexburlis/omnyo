import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import type { ProviderUsage } from "@omnyo/plugin-sdk/provider-bridge";
import { z } from "zod";

const READINGS_MAX_AGE_MS = 60_000;

const READINGS_CONCURRENCY = 3;

const method = "experimental_nativeClaudeRouting.v1.select";

const contract = defineRpcContract({
  [method]: {
    input: z.object({
      hostId: z.string().min(1),
      profileIds: z.array(z.uuid()).nonempty(),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("selected"), profileId: z.uuid() }),
      z.object({ kind: z.literal("exhausted") }),
      z.object({ kind: z.literal("usage-unavailable") }),
    ]),
  },
});

type RoutingDecision = z.output<(typeof contract)[typeof method]["output"]>;

function capacity(
  usage: ProviderUsage | null,
  threshold: number,
  now: number,
): "available" | "exhausted" | "unknown" {
  if (usage?.status !== "ok" || usage.windows.length === 0) return "unknown";

  const exhausted = usage.windows.some(
    ({ usedPercent, resetsAt }) =>
      usedPercent >= threshold * 100 &&
      !(resetsAt !== null && Date.parse(resetsAt) <= now),
  );

  return exhausted ? "exhausted" : "available";
}

export function registerNativeClaudeRouting(
  api: PluginApi,
  threshold: () => number,
  now: () => number,
): void {
  const readings = new Map<
    string,
    { expiresAt: number; usage: Promise<ProviderUsage | null> }
  >();

  function read(hostId: string, profileId: string) {
    const key = `${hostId}:${profileId}`;
    const cached = readings.get(key);

    if (cached !== undefined && cached.expiresAt > now()) return cached.usage;

    const usage = api.sdk.providers.claudeProfiles
      .usage({ hostId, profileId })
      .then(
        (result) => result.usage,
        () => null,
      );

    readings.set(key, { usage, expiresAt: now() + READINGS_MAX_AGE_MS });

    return usage;
  }

  api.rpc.register(contract, {
    [method]: async ({ hostId, profileIds }): Promise<RoutingDecision> => {
      const time = now();
      const switchThreshold = threshold();

      for (const [key, reading] of readings)
        if (reading.expiresAt <= time) readings.delete(key);

      let hasUnknownUsage = false;

      for (
        let offset = 0;
        offset < profileIds.length;
        offset += READINGS_CONCURRENCY
      ) {
        const batch = profileIds.slice(offset, offset + READINGS_CONCURRENCY);

        const observations = await Promise.all(
          batch.map(async (profileId) => ({
            profileId,
            capacity: capacity(
              await read(hostId, profileId),
              switchThreshold,
              now(),
            ),
          })),
        );

        const available = observations.find(
          ({ capacity }) => capacity === "available",
        );

        if (available !== undefined)
          return { kind: "selected", profileId: available.profileId };

        hasUnknownUsage ||= observations.some(
          ({ capacity }) => capacity === "unknown",
        );
      }

      return { kind: hasUnknownUsage ? "usage-unavailable" : "exhausted" };
    },
  });
}
