import {
  defineRpcContract,
  PluginCliError,
  cliCommand,
  defineCli,
  type PluginApi,
  type PluginThreadEventName,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  concurrencyLimitHostContract,
  machineFactsSchema,
  type MachineFacts,
} from "./contract.js";
import {
  automaticHostLimit,
  MAX_LIMIT_VALUE,
  parseLimitValue,
  resolveHostLimit,
} from "./limits.js";
import {
  chooseOverflowTarget,
  DEFAULT_OVERFLOW,
  declaredNeeds,
  formatNeed,
  homeMachineWord,
  hostSetting,
  NEED_TOKENS,
  needSchema,
  overflowConfigurationSchema,
  parseNeedToken,
  tagSchema,
  type Need,
  type OverflowConfiguration,
} from "./overflow.js";

const CONFIGURATION_KEY = "configuration";

const CAPACITIES_KEY = "host-capacities";

const FACTS_KEY = "machine-facts";

const CONFIGURATION_CHANGED_CHANNEL = "configuration-changed";

const DISPATCH_READINESS_CHANGED_CHANNEL = "dispatch-readiness-changed";

const RETRY_MIN_MS = 1_000;

const RETRY_MAX_MS = 30_000;

const RESERVATION_MS = 2 * 60 * 1000;

const MOVE_COOLDOWN_MS = 30_000;

const MAX_MOVES_PER_CHAT = 3;

export const MAX_REASON_LENGTH = 200;

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const limitSchema = z.number().int().min(0).max(MAX_LIMIT_VALUE);

const hostOverrideSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    limit: limitSchema,
  })
  .strict();

const configurationShape = {
  globalLimit: limitSchema.nullable(),
  hostOverrides: z.array(hostOverrideSchema).max(256),
  overflow: overflowConfigurationSchema.default(DEFAULT_OVERFLOW),
};

const configurationSchema = z
  .object(configurationShape)
  .strict()
  .superRefine((configuration, context) => {
    const seen = new Set<string>();

    for (const override of configuration.hostOverrides) {
      if (seen.has(override.hostId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate host override for ${override.hostId}`,
          path: ["hostOverrides"],
        });
      }

      seen.add(override.hostId);
    }
  });

const capacityRecordSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    availableParallelism: z.number().int().positive(),
  })
  .strict();

const capacityRecordsSchema = z.array(capacityRecordSchema).max(256);

const factsRecordsSchema = z
  .array(
    z
      .object({ hostId: z.string().min(1).max(256), facts: machineFactsSchema })
      .strict(),
  )
  .max(256);

const hostConfigurationSchema = z
  .object({
    globalLimit: limitSchema.nullable(),
    hostOverrides: z.array(hostOverrideSchema),
    overflow: overflowConfigurationSchema,
    hosts: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string(),
          status: z.enum(["connected", "disconnected"]),
          availableParallelism: z.number().int().positive().nullable(),
          automaticLimit: limitSchema,
          effectiveLimit: limitSchema,
          override: limitSchema.nullable(),
          facts: machineFactsSchema.nullable(),
          takesOverflow: z.boolean(),
          tags: z.array(tagSchema),
        })
        .strict(),
    ),
    projects: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string(),
          needs: z.array(needSchema).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const dispatchReadinessInputSchema = z
  .object({
    thread: z
      .object({
        id: z.string(),
        status: z.enum([
          "pending",
          "idle",
          "starting",
          "active",
          "stopping",
          "error",
        ]),
      })
      .strict(),
    host: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
  })
  .strict();

const dispatchReadinessSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("proceed") }).strict(),
  z
    .object({
      action: z.literal("wait"),
      reason: z.string().min(1).max(MAX_REASON_LENGTH),
    })
    .strict(),
]);

type DispatchReadiness = z.infer<typeof dispatchReadinessSchema>;

export const concurrencyLimitRpcContract = defineRpcContract({
  getDispatchReadiness: {
    experimental_dispatchReadiness: true,
    input: dispatchReadinessInputSchema,
    output: dispatchReadinessSchema,
  },
  getConfiguration: {
    input: z.null(),
    output: hostConfigurationSchema,
  },
  setConfiguration: {
    input: configurationSchema,
    output: hostConfigurationSchema,
  },
});

type Configuration = z.infer<typeof configurationSchema>;

type CapacityRecord = z.infer<typeof capacityRecordSchema>;

type RefreshOutcome = "settled" | "retry";

type RunningThreads = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["listRunning"]>
>;

const DEFAULT_CONFIGURATION: Configuration = {
  globalLimit: null,
  hostOverrides: [],
  overflow: DEFAULT_OVERFLOW,
};

const CAPACITY_FREED_EVENTS = [
  "thread.idle",
  "thread.failed",
  "thread.archived",
  "thread.deleted",
] as const satisfies readonly PluginThreadEventName[];

function normalizeOverflow(
  overflow: OverflowConfiguration,
): OverflowConfiguration {
  return {
    enabled: overflow.enabled,
    hosts: [...overflow.hosts].sort((left, right) =>
      left.hostId.localeCompare(right.hostId),
    ),
    projectNeeds: [...overflow.projectNeeds].sort((left, right) =>
      left.projectId.localeCompare(right.projectId),
    ),
  };
}

function normalizeConfiguration(configuration: Configuration): Configuration {
  return {
    globalLimit: configuration.globalLimit,
    hostOverrides: [...configuration.hostOverrides].sort((left, right) =>
      left.hostId.localeCompare(right.hostId),
    ),
    overflow: normalizeOverflow(configuration.overflow),
  };
}

function waitDecision(limit: number, scopeLabel: string): DispatchReadiness {
  const reason = `${limit} of ${limit} running on ${scopeLabel}`;

  return {
    action: "wait",
    reason:
      reason.length <= MAX_REASON_LENGTH
        ? reason
        : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLimitArgument(
  raw: string,
  automaticKeyword: "auto" | "unlimited",
): number | null {
  if (raw === automaticKeyword) return null;
  const value = parseLimitValue(raw);

  if (value === null) {
    throw new PluginCliError(
      `Limit must be ${automaticKeyword} or a whole number from 0 to ${MAX_LIMIT_VALUE}`,
      { code: "invalid_limit" },
    );
  }

  return value;
}

function parseOnOff(raw: string, option: string): boolean {
  if (raw === "on") return true;

  if (raw === "off") return false;

  throw new PluginCliError(`${option} must be on or off`, {
    code: "invalid_option",
  });
}

function parseTags(raw: string): string[] {
  const tags = raw
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag !== "");

  for (const tag of tags) {
    if (!tagSchema.safeParse(tag).success) {
      throw new PluginCliError(
        `Tag "${tag}" must use lowercase letters, digits and hyphens`,
        { code: "invalid_tag" },
      );
    }
  }

  return [...new Set(tags)];
}

function parseNeeds(tokens: readonly string[]): Need[] | null {
  if (tokens.length === 1 && tokens[0] === "same-os") return null;
  const needs: Need[] = [];

  for (const token of tokens.flatMap((value) => value.split(","))) {
    if (token.trim() === "") continue;
    const need = parseNeedToken(token);

    if (need === null) {
      throw new PluginCliError(
        `Unknown need "${token}". Use ${NEED_TOKENS}, or same-os.`,
        { code: "invalid_need" },
      );
    }

    needs.push(need);
  }

  return needs;
}

function setHostOverride(
  configuration: Configuration,
  hostId: string,
  limit: number | null,
): Configuration {
  const hostOverrides = configuration.hostOverrides.filter(
    (override) => override.hostId !== hostId,
  );

  if (limit !== null) hostOverrides.push({ hostId, limit });

  return normalizeConfiguration({ ...configuration, hostOverrides });
}

function setOverflowHost(
  configuration: Configuration,
  hostId: string,
  change: { takesOverflow?: boolean; tags?: string[] },
): Configuration {
  const current = hostSetting(configuration.overflow, hostId);

  const next = {
    hostId,
    takesOverflow: change.takesOverflow ?? current.takesOverflow,
    tags: change.tags ?? current.tags,
  };

  const hosts = configuration.overflow.hosts.filter(
    (host) => host.hostId !== hostId,
  );

  if (next.takesOverflow !== true || next.tags.length > 0) hosts.push(next);

  return normalizeConfiguration({
    ...configuration,
    overflow: { ...configuration.overflow, hosts },
  });
}

function setProjectNeeds(
  configuration: Configuration,
  projectId: string,
  needs: Need[] | null,
): Configuration {
  const projectNeeds = configuration.overflow.projectNeeds.filter(
    (entry) => entry.projectId !== projectId,
  );

  if (needs !== null) projectNeeds.push({ projectId, needs });

  return normalizeConfiguration({
    ...configuration,
    overflow: { ...configuration.overflow, projectNeeds },
  });
}

function describeFacts(facts: MachineFacts | null): string {
  if (facts === null) return "machine facts unknown";
  const parts: string[] = [facts.os, facts.arch];

  if (facts.tools.xcode) parts.push("Xcode");

  if (facts.tools.nvidiaGpu !== null) parts.push(facts.tools.nvidiaGpu);

  return parts.join(", ");
}

function formatHostLine(host: {
  name: string;
  status: "connected" | "disconnected";
  availableParallelism: number | null;
  effectiveLimit: number;
  override: number | null;
  facts: MachineFacts | null;
  takesOverflow: boolean;
  tags: readonly string[];
}): string {
  const source =
    host.override === null
      ? `auto, ${host.effectiveLimit}`
      : String(host.override);

  const processors =
    host.availableParallelism === null
      ? "processors unknown"
      : `${host.availableParallelism} processors`;

  const overflow = host.takesOverflow ? "takes overflow" : "no overflow";
  const tags = host.tags.length === 0 ? "" : `, tags ${host.tags.join(",")}`;

  return `${host.name}: ${source} (${processors}, ${host.status}; ${describeFacts(host.facts)}; ${overflow}${tags})`;
}

function formatNeeds(needs: readonly Need[] | null): string {
  return needs === null
    ? "same OS as its machine"
    : needs.map(formatNeed).join(", ") || "any machine";
}

export default async function concurrencyLimitPlugin(
  api: PluginApi,
): Promise<void> {
  const hostClient = api.hosts.experimental_client({
    contract: concurrencyLimitHostContract,
  });

  const storedConfiguration = configurationSchema.safeParse(
    await api.storage.kv.get<unknown>(CONFIGURATION_KEY),
  );

  let configuration = storedConfiguration.success
    ? normalizeConfiguration(storedConfiguration.data)
    : DEFAULT_CONFIGURATION;

  const storedCapacities = capacityRecordsSchema.safeParse(
    await api.storage.kv.get<unknown>(CAPACITIES_KEY),
  );

  const capacities = new Map<string, number>(
    (storedCapacities.success ? storedCapacities.data : []).map((record) => [
      record.hostId,
      record.availableParallelism,
    ]),
  );

  const storedFacts = factsRecordsSchema.safeParse(
    await api.storage.kv.get<unknown>(FACTS_KEY),
  );

  const facts = new Map<string, MachineFacts>(
    (storedFacts.success ? storedFacts.data : []).map((record) => [
      record.hostId,
      record.facts,
    ]),
  );

  async function readConfiguration() {
    const [availableHosts, projects] = await Promise.all([
      api.sdk.hosts.list(),
      api.sdk.projects.list(),
    ]);

    return {
      ...configuration,
      hosts: availableHosts.map(({ id, name, status }) => {
        const availableParallelism = capacities.get(id) ?? null;

        const resolved = resolveHostLimit(
          configuration,
          id,
          availableParallelism,
        );

        const setting = hostSetting(configuration.overflow, id);

        return {
          id,
          name,
          status,
          availableParallelism,
          automaticLimit: automaticHostLimit(availableParallelism),
          effectiveLimit: resolved.limit,
          override: resolved.mode === "override" ? resolved.limit : null,
          facts: facts.get(id) ?? null,
          takesOverflow: setting.takesOverflow,
          tags: setting.tags,
        };
      }),
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        needs: declaredNeeds(configuration.overflow, project.id),
      })),
    };
  }

  async function saveConfiguration(next: Configuration): Promise<void> {
    const normalized = normalizeConfiguration(next);
    await api.storage.kv.set(CONFIGURATION_KEY, normalized);
    configuration = normalized;
    api.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
    api.realtime.publish(DISPATCH_READINESS_CHANGED_CHANNEL, {});
    await api.experimental_hooks.recheck("message.dispatch");

    if (configuration.overflow.enabled) attemptAllOverflow();
  }

  async function persistCapacities(): Promise<void> {
    const records: CapacityRecord[] = [...capacities]
      .map(([hostId, availableParallelism]) => ({
        hostId,
        availableParallelism,
      }))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));

    await api.storage.kv.set(CAPACITIES_KEY, records);
  }

  async function persistFacts(): Promise<void> {
    await api.storage.kv.set(
      FACTS_KEY,
      [...facts]
        .map(([hostId, value]) => ({ hostId, facts: value }))
        .sort((left, right) => left.hostId.localeCompare(right.hostId)),
    );
  }

  api.rpc.register(concurrencyLimitRpcContract, {
    getDispatchReadiness: readDispatchReadiness,
    getConfiguration: readConfiguration,
    async setConfiguration(next) {
      await saveConfiguration(next);

      return readConfiguration();
    },
  });

  function unknownHost(hostId: string): PluginCliError {
    return new PluginCliError(`Unknown host: ${hostId}`, {
      code: "unknown_host",
      hint: "Run `omnyo machine list` for the enrolled host ids.",
    });
  }

  api.cli.register(
    defineCli({
      name: "concurrency-limit",
      summary: "Configure thread limits and overflow to other machines",
      description:
        "A limit holds new turns in line until a running thread goes idle. The automatic host limit is one thread per available processor. With overflow on, a waiting new chat starts on another machine that has free slots and meets its project's needs.",
      commands: {
        status: cliCommand({
          summary: "Show effective limits, machine facts and overflow",
          options: { json: JSON_OPTION },
          async run(input) {
            const view = await readConfiguration();

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(view)
                : [
                    `Overall: ${view.globalLimit === null ? "unlimited" : view.globalLimit}`,
                    "Automatic host limit: one thread per available processor",
                    `Overflow: ${view.overflow.enabled ? "on" : "off"}`,
                    ...view.hosts.map(formatHostLine),
                    ...view.projects
                      .filter((project) => project.needs !== null)
                      .map(
                        (project) =>
                          `Needs for ${project.name}: ${formatNeeds(project.needs)}`,
                      ),
                  ].join("\n"),
            };
          },
        }),
        global: cliCommand({
          summary: "Show or set the overall limit",
          positionals: [
            {
              name: "limit",
              description: `unlimited, or a whole number from 0 to ${MAX_LIMIT_VALUE} (0 holds every new turn); omit it to print the current limit`,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const requested = input.positionals.limit;

            if (requested !== undefined) {
              await saveConfiguration({
                ...configuration,
                globalLimit: parseLimitArgument(requested, "unlimited"),
              });
            }

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ globalLimit: configuration.globalLimit })
                : configuration.globalLimit === null
                  ? "Unlimited"
                  : String(configuration.globalLimit),
            };
          },
        }),
        host: cliCommand({
          summary: "Show or set one host's limit, overflow and tags",
          positionals: [
            {
              name: "host-id",
              description:
                "Enrolled host id, as `omnyo machine list` prints it",
              required: true,
            },
            {
              name: "limit",
              description: `auto, or a whole number from 0 to ${MAX_LIMIT_VALUE} (0 holds every new turn on that host); omit it to keep the current limit`,
            },
          ],
          options: {
            json: JSON_OPTION,
            overflow: {
              type: "string",
              description:
                "on or off: whether this host takes waiting chats from full machines",
            },
            tags: {
              type: "string",
              description:
                "Comma-separated tags that project needs can require, such as dia; an empty value clears them",
            },
          },
          async run(input) {
            const hostId = input.positionals["host-id"];
            const view = await readConfiguration();

            if (!view.hosts.some((candidate) => candidate.id === hostId)) {
              throw unknownHost(hostId);
            }

            let next = configuration;
            const requested = input.positionals.limit;

            if (requested !== undefined) {
              next = setHostOverride(
                next,
                hostId,
                parseLimitArgument(requested, "auto"),
              );
            }

            if (
              input.options.overflow !== undefined ||
              input.options.tags !== undefined
            ) {
              next = setOverflowHost(next, hostId, {
                ...(input.options.overflow === undefined
                  ? {}
                  : {
                      takesOverflow: parseOnOff(
                        input.options.overflow,
                        "--overflow",
                      ),
                    }),
                ...(input.options.tags === undefined
                  ? {}
                  : { tags: parseTags(input.options.tags) }),
              });
            }

            if (next !== configuration) await saveConfiguration(next);

            const updated = (await readConfiguration()).hosts.find(
              (candidate) => candidate.id === hostId,
            );

            if (updated === undefined) throw unknownHost(hostId);

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(updated)
                : formatHostLine(updated),
            };
          },
        }),
        overflow: cliCommand({
          summary: "Show or switch overflow to other machines",
          positionals: [
            {
              name: "state",
              description: "on or off; omit it to print the current state",
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const requested = input.positionals.state;

            if (requested !== undefined) {
              await saveConfiguration({
                ...configuration,
                overflow: {
                  ...configuration.overflow,
                  enabled: parseOnOff(requested, "Overflow"),
                },
              });
            }

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ enabled: configuration.overflow.enabled })
                : configuration.overflow.enabled
                  ? "On"
                  : "Off",
            };
          },
        }),
        needs: cliCommand({
          summary: "Show or set what a project's chats need from a machine",
          positionals: [
            {
              name: "project-id",
              description: "Project id, as `omnyo project list` prints it",
              required: true,
            },
            {
              name: "needs",
              description: `${NEED_TOKENS}, comma-separated; same-os restores the default; omit it to print the current needs`,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const projectId = input.positionals["project-id"];
            const view = await readConfiguration();

            const project = view.projects.find(
              (entry) => entry.id === projectId,
            );

            if (project === undefined) {
              throw new PluginCliError(`Unknown project: ${projectId}`, {
                code: "unknown_project",
                hint: "Run `omnyo project list` for project ids.",
              });
            }

            const requested = input.positionals.needs;

            if (requested !== undefined) {
              await saveConfiguration(
                setProjectNeeds(
                  configuration,
                  projectId,
                  parseNeeds([requested]),
                ),
              );
            }

            const needs = declaredNeeds(configuration.overflow, projectId);

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ projectId, needs })
                : `${project.name}: ${formatNeeds(needs)}`,
            };
          },
        }),
      },
    }),
  );

  let refreshAllRequested = true;
  const requestedHostIds = new Set<string>();
  let wakeWaiter: (() => void) | null = null;

  function requestRefresh(hostId?: string): void {
    if (hostId === undefined) refreshAllRequested = true;
    else requestedHostIds.add(hostId);
    wakeWaiter?.();
  }

  async function detectHost(
    hostId: string,
    signal: AbortSignal,
  ): Promise<{ parallelism: number; facts: MachineFacts | null }> {
    try {
      const detected = await hostClient.call("getMachineFacts", null, {
        hostId,
        signal,
      });

      return { parallelism: detected.availableParallelism, facts: detected };
    } catch (factsError) {
      if (signal.aborted) throw factsError;
      api.log.warn(
        `Could not read machine facts for host ${hostId}; it takes no overflow until it can: ${errorMessage(factsError)}`,
      );

      const capacity = await hostClient.call("getCapacity", null, {
        hostId,
        signal,
      });

      return { parallelism: capacity.availableParallelism, facts: null };
    }
  }

  async function refreshCapacities(
    signal: AbortSignal,
    refreshAll: boolean,
    hostIds: ReadonlySet<string>,
  ): Promise<RefreshOutcome> {
    try {
      const availableHosts = await api.sdk.hosts.list({ signal });
      let changed = false;

      if (refreshAll) {
        const availableHostIds = new Set(availableHosts.map((host) => host.id));

        for (const hostId of capacities.keys()) {
          if (!availableHostIds.has(hostId)) {
            capacities.delete(hostId);
            facts.delete(hostId);
            changed = true;
          }
        }
      }

      let retry = false;

      const targets = availableHosts.filter(
        (availableHost) =>
          availableHost.status === "connected" &&
          (refreshAll || hostIds.has(availableHost.id)),
      );

      await Promise.all(
        targets.map(async (availableHost) => {
          try {
            const result = await detectHost(availableHost.id, signal);

            if (capacities.get(availableHost.id) !== result.parallelism) {
              capacities.set(availableHost.id, result.parallelism);
              changed = true;
            }

            const known = facts.get(availableHost.id) ?? null;

            if (JSON.stringify(known) !== JSON.stringify(result.facts)) {
              if (result.facts === null) facts.delete(availableHost.id);
              else facts.set(availableHost.id, result.facts);
              changed = true;
            }
          } catch (error) {
            if (signal.aborted) return;
            retry = true;
            api.log.warn(
              `Could not detect capacity for host ${availableHost.id}: ${errorMessage(error)}`,
            );
          }
        }),
      );

      if (changed) {
        await persistCapacities();
        await persistFacts();
        api.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
        api.realtime.publish(DISPATCH_READINESS_CHANGED_CHANNEL, {});
        await api.experimental_hooks.recheck("message.dispatch");
      }

      return retry ? "retry" : "settled";
    } catch (error) {
      if (!signal.aborted) {
        api.log.warn(
          `Could not load hosts for capacity detection: ${errorMessage(error)}`,
        );
      }

      return signal.aborted ? "settled" : "retry";
    }
  }

  function waitForRefresh(
    signal: AbortSignal,
    retryDelayMs: number | null,
  ): Promise<"requested" | "retry" | "aborted"> {
    if (signal.aborted) return Promise.resolve("aborted");

    if (refreshAllRequested || requestedHostIds.size > 0) {
      return Promise.resolve("requested");
    }

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const finish = (reason: "requested" | "retry" | "aborted"): void => {
        if (settled) return;
        settled = true;

        if (timer !== null) clearTimeout(timer);

        if (wakeWaiter === wake) wakeWaiter = null;
        signal.removeEventListener("abort", abort);
        resolve(reason);
      };

      const wake = (): void => finish("requested");
      const abort = (): void => finish("aborted");
      wakeWaiter = wake;
      signal.addEventListener("abort", abort, { once: true });

      if (retryDelayMs !== null) {
        timer = setTimeout(() => finish("retry"), retryDelayMs);
      }
    });
  }

  api.background.service("capacity-detector", {
    async start(signal) {
      const unsubscribeThreads = api.sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          if (
            event.changes.some(
              (change) =>
                change === "status-changed" ||
                change === "thread-created" ||
                change === "thread-deleted" ||
                change === "archived-changed" ||
                change === "environment-changed",
            )
          )
            api.realtime.publish(DISPATCH_READINESS_CHANGED_CHANNEL, {});
        },
      });

      const unsubscribeHost = api.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (
            event.changes.some(
              (change) =>
                change === "host-connected" || change === "host-disconnected",
            )
          )
            api.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});

          if (event.changes.includes("host-connected"))
            requestRefresh(event.id);
        },
      });

      const unsubscribeRealtime = api.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected)
            requestRefresh();
        },
      });

      let retryMs = RETRY_MIN_MS;

      try {
        while (!signal.aborted) {
          const refreshAll = refreshAllRequested;
          const hostIds = new Set(requestedHostIds);
          refreshAllRequested = false;
          requestedHostIds.clear();
          const outcome = await refreshCapacities(signal, refreshAll, hostIds);

          if (signal.aborted) break;

          if (refreshAllRequested || requestedHostIds.size > 0) continue;

          const wakeReason = await waitForRefresh(
            signal,
            outcome === "retry" ? retryMs : null,
          );

          if (wakeReason === "retry") {
            refreshAllRequested = true;
            retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
          } else if (outcome === "settled") {
            retryMs = RETRY_MIN_MS;
          }
        }
      } finally {
        unsubscribeThreads();
        unsubscribeRealtime();
        unsubscribeHost();
        wakeWaiter?.();
        wakeWaiter = null;
      }
    },
  });

  const waitingThreadIds = new Set<string>();
  const reservations = new Map<string, { hostId: string; expiresAt: number }>();
  const cooldownUntil = new Map<string, number>();
  const moveAttempts = new Map<string, number>();
  const movesInFlight = new Set<string>();
  const reportedNoTarget = new Set<string>();
  const heldHome = new Map<string, string>();
  const maintenanceThreadIds = new Set<string>();

  function forgetThread(threadId: string): void {
    waitingThreadIds.delete(threadId);
    reservations.delete(threadId);
    cooldownUntil.delete(threadId);
    moveAttempts.delete(threadId);
    reportedNoTarget.delete(threadId);
    heldHome.delete(threadId);
    maintenanceThreadIds.delete(threadId);
  }

  async function listCountedRunning(): Promise<RunningThreads> {
    const running = await api.sdk.threads.listRunning();

    return running.filter((thread) => !maintenanceThreadIds.has(thread.id));
  }

  async function freeCapacity(threadId: string): Promise<void> {
    forgetThread(threadId);
    await api.experimental_hooks.recheck("message.dispatch");
    attemptAllOverflow();
  }

  function reservedOn(hostId: string, now: number): number {
    let count = 0;

    for (const [threadId, reservation] of reservations) {
      if (reservation.expiresAt <= now) reservations.delete(threadId);
      else if (reservation.hostId === hostId) count += 1;
    }

    return count;
  }

  function limitFor(hostId: string): number {
    return resolveHostLimit(
      configuration,
      hostId,
      capacities.get(hostId) ?? null,
    ).limit;
  }

  function runningOn(running: RunningThreads, hostId: string): number {
    return running.filter((thread) => thread.hostId === hostId).length;
  }

  async function attemptOverflow(threadId: string): Promise<void> {
    if (!configuration.overflow.enabled || movesInFlight.has(threadId)) return;
    const now = Date.now();

    if ((cooldownUntil.get(threadId) ?? 0) > now) return;

    if ((moveAttempts.get(threadId) ?? 0) >= MAX_MOVES_PER_CHAT) return;
    movesInFlight.add(threadId);

    try {
      const [running, availableHosts] = await Promise.all([
        listCountedRunning(),
        api.sdk.hosts.list(),
      ]);

      if (
        configuration.globalLimit !== null &&
        running.length >= configuration.globalLimit
      ) {
        return;
      }

      const anyMachineHasRoom = availableHosts.some(
        (host) =>
          host.status === "connected" &&
          hostSetting(configuration.overflow, host.id).takesOverflow &&
          limitFor(host.id) -
            runningOn(running, host.id) -
            reservedOn(host.id, now) >
            0,
      );

      if (!anyMachineHasRoom) return;

      const listing = await api.sdk.threads.experimental_listStartMachines({
        threadId,
      });

      const origin = listing.originHostId;

      if (origin === null) {
        forgetThread(threadId);

        return;
      }

      if (runningOn(running, origin) < limitFor(origin)) return;

      const thread = await api.sdk.threads.get({ threadId });

      const target = chooseOverflowTarget({
        originHostId: origin,
        projectId: thread.projectId,
        candidates: listing.machines.filter((machine) => machine.eligible),
        facts,
        overflow: configuration.overflow,
        freeSlots: (hostId) =>
          limitFor(hostId) -
          runningOn(running, hostId) -
          reservedOn(hostId, now),
      });

      if (target === null) {
        if (!reportedNoTarget.has(threadId)) {
          reportedNoTarget.add(threadId);

          const reasons = listing.machines
            .map(
              (machine) =>
                `${machine.name}: ${machine.reason ?? "no free slot or a missing need"}`,
            )
            .join("; ");

          api.log.info(
            `No machine can take waiting thread ${threadId} yet. ${reasons === "" ? "No other machines." : reasons}`,
          );
        }

        return;
      }

      reservations.set(threadId, {
        hostId: target.hostId,
        expiresAt: now + RESERVATION_MS,
      });
      moveAttempts.set(threadId, (moveAttempts.get(threadId) ?? 0) + 1);

      const originName =
        availableHosts.find((host) => host.id === origin)?.name ?? origin;

      const result = await api.sdk.threads.experimental_moveStart({
        threadId,
        hostId: target.hostId,
        expectedHostId: origin,
        note: `Started on ${target.name} because ${originName} was full.`,
      });

      if (result.kind === "moved") {
        api.log.info(
          `Moved waiting thread ${threadId} from ${originName} to ${target.name}`,
        );
        api.realtime.publish(DISPATCH_READINESS_CHANGED_CHANNEL, {});

        return;
      }

      reservations.delete(threadId);
      cooldownUntil.set(threadId, now + MOVE_COOLDOWN_MS);
      api.log.info(
        `Could not move waiting thread ${threadId} to ${target.name}: ${result.message}`,
      );

      if (result.code === "machine_changed" || result.code === "not_waiting") {
        await api.experimental_hooks.recheck("message.dispatch");
      }
    } catch (error) {
      reservations.delete(threadId);
      cooldownUntil.set(threadId, Date.now() + MOVE_COOLDOWN_MS);
      api.log.warn(
        `Overflow check failed for thread ${threadId}: ${errorMessage(error)}`,
      );
    } finally {
      movesInFlight.delete(threadId);
    }
  }

  function attemptAllOverflow(): void {
    for (const threadId of waitingThreadIds) void attemptOverflow(threadId);
  }

  api.events.on("message.queued", ({ entry }) => {
    if (
      entry.waitingOn?.kind !== "plugin" ||
      entry.waitingOn.pluginId !== api.pluginId
    ) {
      return;
    }

    if (heldHome.has(entry.threadId)) return;

    if (!waitingThreadIds.has(entry.threadId)) {
      const word = homeMachineWord(
        entry.content
          .flatMap((input) => (input.type === "text" ? [input.text] : []))
          .join("\n"),
      );

      if (word !== null) {
        heldHome.set(entry.threadId, word);
        api.log.info(
          `Keeping waiting thread ${entry.threadId} on its machine: its first message mentions "${word}".`,
        );

        return;
      }
    }

    waitingThreadIds.add(entry.threadId);
    void attemptOverflow(entry.threadId);
  });

  api.events.on("message.dispatched", ({ entry }) => {
    waitingThreadIds.delete(entry.threadId);
  });

  api.events.on("thread.active", ({ thread }) => {
    forgetThread(thread.id);
  });

  for (const event of CAPACITY_FREED_EVENTS) {
    api.events.on(event, ({ thread }) => freeCapacity(thread.id));
  }

  try {
    api.events.on(
      "experimental_thread.maintenance",
      async ({ thread, phase }) => {
        if (phase === "started") {
          maintenanceThreadIds.add(thread.id);

          return;
        }

        await freeCapacity(thread.id);
      },
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith(
        'unknown event "experimental_thread.maintenance"',
      )
    )
      throw error;

    api.log.info(
      "This Omnyo version has no maintenance events; automatic compactions are not tracked.",
    );
  }

  async function readDispatchReadiness(
    context: z.infer<typeof dispatchReadinessInputSchema>,
  ): Promise<DispatchReadiness> {
    if (
      context.thread.status === "active" ||
      context.thread.status === "starting"
    ) {
      return { action: "proceed" };
    }

    const host = context.host;

    if (configuration.globalLimit === null && host === null) {
      return { action: "proceed" };
    }

    const running = await listCountedRunning();

    if (
      configuration.globalLimit !== null &&
      running.length >= configuration.globalLimit
    ) {
      return waitDecision(configuration.globalLimit, "all hosts");
    }

    if (host !== null) {
      const resolved = resolveHostLimit(
        configuration,
        host.id,
        capacities.get(host.id) ?? null,
      );

      const onHost = running.filter((thread) => thread.hostId === host.id);

      if (onHost.length >= resolved.limit) {
        const label = host.name.trim() === "" ? host.id : host.name;

        return waitDecision(resolved.limit, `host ${label}`);
      }
    }

    return { action: "proceed" };
  }

  api.experimental_hooks.on("message.dispatch", async (context) => {
    if (context.attempt === "join-turn") return { action: "proceed" };

    return readDispatchReadiness(context);
  });
}
