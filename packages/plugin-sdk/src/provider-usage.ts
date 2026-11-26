import type { PluginApi } from "@omnyo/plugin-sdk";
import { defineRpcContract } from "./rpc-contract.js";
import { z } from "zod";

const usagePlanSchema = z.object({
  id: z.string().min(1),
  multiplier: z.number().int().positive().nullable(),
});

const accountFields = {
  plan: usagePlanSchema.nullable().default(null),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};

const usageWindowKindSchema = z.enum([
  "five-hour",
  "daily",
  "weekly",
  "custom",
]);

const usageWindowSchema = z.object({
  kind: usageWindowKindSchema.default("custom"),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z
    .number()
    .nonnegative()
    .describe("Percentage consumed; may exceed 100 for overage."),
  resetsAt: z
    .string()
    .nullable()
    .describe("ISO timestamp, or null when no reset is known."),
  model: z
    .string()
    .nullable()
    .describe("Applicable model family, or null for all models."),
  cost: z
    .object({
      usedUsdCents: z.number().nonnegative(),
      limitUsdCents: z.number().positive(),
    })
    .nullable(),
});

const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    ...accountFields,
    windows: z.array(usageWindowSchema),
  }),
  z.object({ status: z.literal("not_installed"), ...accountFields }),
  z.object({ status: z.literal("unauthenticated"), ...accountFields }),
  z.object({ status: z.literal("expired"), ...accountFields }),
  z.object({
    status: z.literal("error"),
    ...accountFields,
    message: z.string(),
  }),
]);

const usageAccountKeySchema = z
  .string()
  .min(1)
  .nullable()
  .default(null)
  .describe(
    "Provider-issued quota account identity, namespaced by issuer and account/organization scope. Never use email, a display label, a source-local ID, or credentials. Null means unknown; unknown accounts must not be merged.",
  );

const usageResourceSchema = z.object({
  accountKey: usageAccountKeySchema,
  id: z
    .string()
    .min(1)
    .describe("Stable resource ID within this source plugin."),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostName: z.string().min(1),
    }),
  ]),
});

const usageResourceListSchema = z.object({
  label: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Declares a shared group even when empty. Host-only sources omit it; machine groups use host names.",
    ),
  resources: z.array(usageResourceSchema),
});

const usageMeasurementSchema = z.object({
  accountKey: usageAccountKeySchema,
  observedAt: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe(
      "Last successful measurement time in epoch milliseconds; null if never observed.",
    ),
  usage: usageSchema,
});

const usageListInputSchema = z.object({});

const usageFetchInputSchema = z.object({
  resourceId: z.string().min(1),
  refresh: z
    .boolean()
    .describe(
      "False permits a cached measurement but still returns actual usage. True requests a fresh collection attempt for this resource only.",
    ),
});

const usageListMethod = "provider-usage.v1.listResources";

const usageFetchMethod = "provider-usage.v1.getResource";

const usageSourceRpcContract = defineRpcContract({
  [usageListMethod]: {
    input: usageListInputSchema,
    output: usageResourceListSchema,
    experimental_description:
      "Cheap complete inventory of resources owned by this source. Reads local metadata only; never refreshes quota or contacts providers. IDs are stable and source-local. Resource order is display order. Shared label preserves empty groups. Resources may disappear between list and fetch.",
  },
  [usageFetchMethod]: {
    input: usageFetchInputSchema,
    output: usageMeasurementSchema,
    experimental_description:
      "Returns actual usage for exactly one listed resource, even when refresh is false. False permits cached observations; true requests a fresh attempt. Never collects other resources as a side effect. A removed resource fails the RPC; consumers relist. Per-account authentication and collection failures are usage states. observedAt is the last successful measurement time.",
  },
});

export const experimental_providerUsageSourceV1 = {
  usageListMethod,
  usageFetchMethod,
  usageSourceRpcContract,
  usageMeasurementSchema,
  usagePlanSchema,
  usageResourceListSchema,
  usageWindowKindSchema,
} as const;

type UsageMeasurement = z.infer<typeof usageMeasurementSchema>;

const locatorSchema = z.tuple([z.string().min(1), z.string().min(1)]);

const metadataSchema = z.object({
  accountKey: z.string().min(1).nullable().catch(null),
  plan: usagePlanSchema.nullable().catch(null),
});

const windowMetadataSchema = z.object({
  kind: usageWindowKindSchema.catch("custom"),
  model: z.string().nullable().catch(null),
});

type HostProvider = Awaited<
  ReturnType<PluginApi["sdk"]["providers"]["list"]>
>[number];

/** Register host-local usage discovery and measurement with a per-registration cache. */
export function experimental_registerHostProviderUsageSourceV1(
  api: PluginApi,
  {
    ownsProvider,
    description,
  }: {
    ownsProvider: (provider: HostProvider) => boolean;
    description: string;
  },
): void {
  const cache = new Map<string, UsageMeasurement>();

  const pending = new Map<
    string,
    { refresh: boolean; promise: Promise<UsageMeasurement> }
  >();

  const load = async (
    resourceId: string,
    refresh: boolean,
  ): Promise<UsageMeasurement> => {
    const [hostId, providerId] = locatorSchema.parse(JSON.parse(resourceId));

    const host = await api.sdk.hosts.get({ hostId }).catch((error: unknown) => {
      if (error instanceof Error && "status" in error && error.status === 404)
        throw new Error("Usage resource no longer exists.");
      throw error;
    });

    const previous = cache.get(resourceId);

    const unavailable = (message: string) =>
      usageMeasurementSchema.parse({
        accountKey: previous?.accountKey ?? null,
        observedAt: previous?.observedAt ?? null,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message,
        },
      });

    if (host.status === "disconnected")
      return unavailable("Machine is disconnected.");

    const providers = await api.sdk.providers.list({
      hostId,
      capability: "usage",
    });

    if (
      !providers.some(
        (provider) => provider.id === providerId && ownsProvider(provider),
      )
    )
      throw new Error("Usage resource no longer exists.");

    if (
      !refresh &&
      previous?.usage.status === "ok" &&
      previous.observedAt !== null &&
      Date.now() - previous.observedAt < 60_000
    )
      return previous;

    const promise = (async () => {
      try {
        const result = await api.sdk.system.usageLimits({
          hostId,
          providerId,
          refresh,
        });

        const usage = result[providerId];

        if (!usage) throw new Error("Provider returned no usage information.");
        const metadata = metadataSchema.parse(usage);

        const value = usageMeasurementSchema.parse({
          accountKey: metadata.accountKey,
          observedAt:
            usage.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
          usage: {
            accountEmail: null,
            planLabel: null,
            ...usage,
            plan: metadata.plan,
            ...(usage.status === "ok"
              ? {
                  windows: usage.windows.map((window, index) => ({
                    ...window,
                    ...windowMetadataSchema.parse(window),
                    id: `${index}:${window.label}`,
                    cost: window.cost ?? null,
                  })),
                }
              : {}),
          },
        });

        cache.set(resourceId, value);

        return value;
      } catch {
        return unavailable("Usage could not be collected from this machine.");
      }
    })();

    return promise;
  };

  const collect = async (
    resourceId: string,
    refresh: boolean,
  ): Promise<UsageMeasurement> => {
    const running = pending.get(resourceId);

    if (running) {
      if (!refresh || running.refresh) return running.promise;
      await running.promise.catch(() => undefined);

      return collect(resourceId, refresh);
    }

    const promise = load(resourceId, refresh).finally(() =>
      pending.delete(resourceId),
    );

    pending.set(resourceId, { refresh, promise });

    return promise;
  };

  api.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const hosts = await api.sdk.hosts.list();

        const resources = (
          await Promise.all(
            hosts.map(async (host) => {
              const providers = await api.sdk.providers.list({
                hostId: host.id,
                capability: "usage",
              });

              return providers
                .filter((provider) => ownsProvider(provider))
                .map((provider) => {
                  const id = JSON.stringify([host.id, provider.id]);

                  return {
                    id,
                    accountKey: cache.get(id)?.accountKey ?? null,
                    providerId: provider.id,
                    label: provider.displayName,
                    scope: {
                      kind: "host" as const,
                      hostId: host.id,
                      hostName: host.name,
                    },
                  };
                });
            }),
          )
        ).flat();

        const ids = new Set(resources.map((resource) => resource.id));

        for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);

        return { resources };
      },
      [usageFetchMethod]: ({ resourceId, refresh }) =>
        collect(resourceId, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description: description,
    },
  );
}
