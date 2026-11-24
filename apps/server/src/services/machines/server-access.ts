import { setTimeout as sleep } from "node:timers/promises";
import { ApiError } from "../../errors.js";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { readPrimaryHostIdFromDataDir } from "../hosts/primary-host.js";
import { callHostOnlineRpc } from "../hosts/online-rpc.js";
import {
  createDirectProof,
  createCurrentPrimaryProof,
  directAccessCoordinatorStatus,
  directAccessState,
  getDirectRetirement,
  withServerAccessLane,
} from "./direct-access-state.js";
import {
  getAppSettings,
  getHost,
  hosts,
  serverAccessRetirements,
  getLatestSessionForHost,
  listRunningThreads,
  pendingInteractions,
  environments,
  terminalSessions,
} from "@omnyo/db";
import { eq, ne, and, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ServerAccessGrant } from "@omnyo/plugin-sdk";
import type {
  HostDirectAccessStatus,
  ServerAccessStatus,
} from "@omnyo/server-contract";
import { decideWithinBox } from "../lib/decision-timeout.js";
import type { AppDeps, WorkSessionDeps } from "../../types.js";
import {
  invokeServerAccessProvider,
  listServerAccessProviders,
} from "../plugins/plugin-server-access-registry.js";
import { getMachineProvider } from "../plugins/plugin-machine-provider-registry.js";

type Dependencies = Pick<WorkSessionDeps, "db" | "hub" | "logger">;

const reachableUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);

    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  });

const grantSchema: z.ZodType<ServerAccessGrant> = z
  .object({
    id: z.string().min(1),
    serverUrl: reachableUrlSchema,
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const acquireResultSchema = z.union([
  grantSchema,
  z
    .object({ status: z.literal("failed"), message: z.string().min(1) })
    .strict(),
]);

const availabilitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    serverUrl: reachableUrlSchema.optional(),
  }),
  z.object({ status: z.literal("setup-required"), message: z.string() }),
  z.object({ status: z.literal("unavailable"), message: z.string() }),
]);

export function machineServerUrl(deps: Dependencies) {
  const configured = getAppSettings(deps.db).machineServerUrl;
  const raw = configured ?? process.env.OMNYO_EXTERNAL_URL ?? null;
  const parsed = reachableUrlSchema.safeParse(raw);

  return {
    url: parsed.success ? parsed.data.replace(/\/$/u, "") : null,
    source:
      configured !== null
        ? ("setting" as const)
        : raw !== null
          ? ("OMNYO_EXTERNAL_URL" as const)
          : null,
  };
}

function serverAccessConfiguration(deps: Dependencies) {
  const direct = machineServerUrl(deps);
  const records = listServerAccessProviders();

  const providers: Array<{
    id: string;
    displayName: string;
    description: string;
    pluginId: string | null;
  }> = records.map((record) => ({
    id: record.provider.id,
    displayName: record.provider.displayName,
    description: record.provider.description,
    pluginId: record.pluginId,
  }));

  providers.push({
    id: "direct",
    displayName: "Manual",
    description: "Use your own domain or network address.",
    pluginId: null,
  });
  const configured = getAppSettings(deps.db).defaultMachineAccess;
  const defaultProviderId = configured ?? records[0]?.provider.id ?? "direct";

  return {
    providers,
    defaultProviderId,
    effectiveUrl: direct.url,
    urlSource: direct.source,
  };
}

export async function serverAccessStatus(
  deps: Dependencies,
): Promise<ServerAccessStatus> {
  const configuration = serverAccessConfiguration(deps);
  const records = listServerAccessProviders();

  const providers = await Promise.all(
    configuration.providers.map(async (provider) => {
      if (provider.id === "direct") return { ...provider, availability: null };
      const record = records.find((entry) => entry.provider.id === provider.id);

      const result =
        record === undefined
          ? null
          : await decideWithinBox(
              () =>
                invokeServerAccessProvider(record, async () =>
                  record.provider.availability(),
                ),
              5_000,
            );

      const parsed = result?.ok
        ? availabilitySchema.safeParse(result.value)
        : null;

      const availability: z.infer<typeof availabilitySchema> = parsed?.success
        ? parsed.data
        : {
            status: "unavailable",
            message:
              "Could not check machine access. Try again or check the provider's configuration.",
          };

      return { ...provider, availability };
    }),
  );

  return { ...configuration, providers };
}

export async function directAccessStatus(
  deps: AppDeps,
  hostId: string,
): Promise<HostDirectAccessStatus> {
  const coordinator = directAccessCoordinatorStatus(deps, hostId);
  const session = getLatestSessionForHost(deps.db, { hostId });

  if (
    session?.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION ||
    !deps.hub.hasDaemonForHost(hostId)
  )
    return {
      status: "available",
      coordinator,
      worker: {
        status: "unavailable",
        code: "direct_access_inspection_unavailable",
        message:
          "A connected compatible worker is required to inspect probe ownership",
      },
    };

  try {
    const worker = await callHostOnlineRpc(deps, {
      hostId,
      timeoutMs: 3_000,
      command: { type: "server_access.inspect_direct_probe" },
    });

    if (
      worker.hostId !== hostId ||
      worker.workerInstanceId !== session.instanceId ||
      worker.sessionId !== session.id ||
      getLatestSessionForHost(deps.db, { hostId })?.id !== session.id
    )
      throw new ApiError(
        409,
        "direct_access_inspection_changed",
        "Worker identity changed during probe inspection",
      );

    return {
      status: "available",
      coordinator,
      worker: { status: "available", ...worker },
    };
  } catch (error) {
    return {
      status: "available",
      coordinator,
      worker: {
        status: "unavailable",
        code:
          error instanceof ApiError
            ? error.body.code
            : "direct_access_inspection_failed",
        message:
          error instanceof Error
            ? error.message
            : "Worker probe inspection failed",
      },
    };
  }
}

function acquisitionKey(
  host: NonNullable<ReturnType<typeof getHost>>,
  fallback: string,
): string {
  const owner =
    host.machineProviderId === null
      ? null
      : (getMachineProvider(host.machineProviderId)?.pluginId ?? null);

  return owner !== null && host.launchKey !== null
    ? JSON.stringify([owner, host.launchKey])
    : fallback;
}

async function resolveOwned(
  deps: Dependencies,
  args: {
    key: string;
    hostId: string;
    signal: AbortSignal;
  },
): Promise<ServerAccessGrant> {
  args.signal.throwIfAborted();
  await drainRetirement(deps, args.hostId);
  const host = getHost(deps.db, args.hostId);

  if (!host || host.destroyedAt !== null)
    throw new Error("Machine identity is unavailable");
  const status = serverAccessConfiguration(deps);
  const providerId = host.serverAccessProviderId ?? status.defaultProviderId;
  let grant: ServerAccessGrant;

  if (providerId === "direct") {
    const serverUrl = status.effectiveUrl;

    if (serverUrl === null)
      throw new Error("Set a server URL reachable by machines");
    grant = { id: args.hostId, serverUrl };
  } else {
    const record = listServerAccessProviders().find(
      (entry) => entry.provider.id === providerId,
    );

    if (!record) throw new Error("Server access provider is unavailable");
    let availability: z.infer<typeof availabilitySchema>;
    let onAbort: (() => void) | undefined;

    try {
      args.signal.throwIfAborted();
      availability = availabilitySchema.parse(
        await Promise.race([
          invokeServerAccessProvider(record, async () =>
            record.provider.availability(),
          ),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(args.signal.reason);
            args.signal.addEventListener("abort", onAbort, { once: true });

            if (args.signal.aborted) onAbort();
          }),
        ]),
      );
    } catch {
      args.signal.throwIfAborted();
      throw new Error("Server access provider is unavailable");
    } finally {
      if (onAbort) args.signal.removeEventListener("abort", onAbort);
    }

    args.signal.throwIfAborted();

    if (availability.status !== "available") {
      throw new Error(availability.message);
    }

    deps.db
      .update(hosts)
      .set({ serverAccessProviderId: providerId })
      .where(eq(hosts.id, args.hostId))
      .run();
    let result: unknown;

    try {
      result = await invokeServerAccessProvider(record, () =>
        record.provider.acquire({
          ...args,
          key: acquisitionKey(host, args.key),
        }),
      );
      const parsed = acquireResultSchema.safeParse(result);

      if (!parsed.success)
        throw new Error("Server access provider returned an invalid grant");

      if ("status" in parsed.data) throw new Error(parsed.data.message);
      grant = parsed.data;
    } catch (error) {
      deps.db
        .update(hosts)
        .set({
          statusMessage: error instanceof Error ? error.message : String(error),
        })
        .where(eq(hosts.id, args.hostId))
        .run();
      deps.hub.notifyHost(args.hostId, ["host-connected"]);
      throw error;
    }
  }

  if (
    host.serverAccessGrantId !== null &&
    host.serverAccessGrantId !== grant.id
  ) {
    throw new Error("Server access provider changed its grant identity");
  }

  deps.db
    .update(hosts)
    .set({
      serverAccessProviderId: providerId,
      serverAccessGrantId: grant.id,
      statusMessage: null,
    })
    .where(eq(hosts.id, args.hostId))
    .run();
  args.signal.throwIfAborted();

  return grant;
}

async function releaseOwned(
  deps: Dependencies,
  args: { key: string; hostId: string },
  purpose: "remove" | "repair" = "remove",
) {
  await drainRetirement(deps, args.hostId);
  const host = getHost(deps.db, args.hostId);

  if (!host) return;
  const providerId = host.serverAccessProviderId;
  const grantId = host.serverAccessGrantId;

  if (providerId === null) return;

  if (providerId !== "direct") {
    const record = listServerAccessProviders().find(
      (entry) => entry.provider.id === providerId,
    );

    if (!record) {
      if (purpose === "repair")
        throw new Error("Server access provider is unavailable");
      deps.logger.warn(
        { hostId: args.hostId, providerId },
        "Server access provider is not installed; skipping release during machine removal",
      );
    } else {
      await invokeServerAccessProvider(record, () =>
        record.provider.release({
          key: acquisitionKey(host, args.key),
          grantId,
          hostId: args.hostId,
        }),
      );
    }
  }

  deps.db
    .update(hosts)
    .set({
      serverAccessProviderId: purpose === "repair" ? providerId : null,
      serverAccessGrantId: null,
    })
    .where(eq(hosts.id, args.hostId))
    .run();
}

async function repairOwned(
  deps: Dependencies,
  args: { key: string; hostId: string; signal: AbortSignal },
): Promise<ServerAccessGrant> {
  args.signal.throwIfAborted();
  const host = getHost(deps.db, args.hostId);

  if (!host || host.destroyedAt !== null)
    throw new Error("Machine identity is unavailable");
  await drainRetirement(deps, args.hostId);

  if (host.serverAccessProviderId === "direct") return resolveOwned(deps, args);
  await releaseOwned(deps, args, "repair");

  return resolveOwned(deps, args);
}

async function drainRetirement(
  deps: Dependencies,
  hostId: string,
): Promise<void> {
  const row = getDirectRetirement(deps, hostId);

  if (row === null) return;
  const state = directAccessState(deps);
  const heldChallenge = state.holds.get(hostId);

  const heldProof =
    heldChallenge === undefined ? undefined : state.proofs.get(heldChallenge);

  if (!isOwnedRetirementHold(state, hostId, row))
    throw new Error("Retiring server access handoff belongs to another owner");

  if (row.primaryProofRuntimeId !== directAccessState(deps).instanceId)
    throw new Error(
      "Direct primary confirmation is pending; retry direct access conversion",
    );

  if (row.providerId !== null && row.providerId !== "direct") {
    const record = listServerAccessProviders().find(
      (entry) => entry.provider.id === row.providerId,
    );

    if (!record)
      throw new Error("Retiring server access provider is unavailable");
    await invokeServerAccessProvider(record, () =>
      record.provider.release({
        key: row.acquisitionKey,
        hostId,
        grantId: row.grantId,
      }),
    );
  }

  if (
    !sameRetirement(getDirectRetirement(deps, hostId), row) ||
    state.holds.get(hostId) !== heldChallenge ||
    (heldChallenge !== undefined &&
      state.proofs.get(heldChallenge) !== heldProof) ||
    !isOwnedRetirementHold(state, hostId, row)
  )
    throw new Error("Retiring server access owner changed during release");

  deps.db
    .delete(serverAccessRetirements)
    .where(eq(serverAccessRetirements.hostId, hostId))
    .run();

  if (heldChallenge !== undefined) {
    state.holds.delete(hostId);
    state.proofs.delete(heldChallenge);
  }
}

function isOwnedRetirementHold(
  state: ReturnType<typeof directAccessState>,
  hostId: string,
  row: ReturnType<typeof getDirectRetirement>,
): boolean {
  const challenge = state.holds.get(hostId);

  if (challenge === undefined) return true;
  const proof = state.proofs.get(challenge);

  return (
    row !== null &&
    challenge === row.challenge &&
    proof?.kind === "handoff" &&
    proof.committed &&
    proof.hostId === hostId &&
    proof.serverUrl === row.serverUrl
  );
}

function sameRetirement(
  current: ReturnType<typeof getDirectRetirement>,
  expected: NonNullable<ReturnType<typeof getDirectRetirement>>,
): boolean {
  return (
    current !== null &&
    current.providerId === expected.providerId &&
    current.grantId === expected.grantId &&
    current.acquisitionKey === expected.acquisitionKey &&
    current.serverUrl === expected.serverUrl &&
    current.challenge === expected.challenge &&
    current.primaryProofRuntimeId === expected.primaryProofRuntimeId &&
    current.createdAt === expected.createdAt
  );
}

async function confirmCurrentPrimaryAndDrain(
  deps: AppDeps,
  hostId: string,
): Promise<{
  hostId: string;
  providerId: "direct";
  retirementPending: boolean;
}> {
  const state = directAccessState(deps);
  const row = getDirectRetirement(deps, hostId);
  const heldChallenge = state.holds.get(hostId);

  const heldProof =
    heldChallenge === undefined ? undefined : state.proofs.get(heldChallenge);

  const host = getHost(deps.db, hostId);
  const session = getLatestSessionForHost(deps.db, { hostId });
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);

  const refusal = (message: string) =>
    new ApiError(409, "direct_access_refused", message);

  if (
    !isOwnedRetirementHold(state, hostId, row) ||
    !host ||
    host.destroyedAt !== null ||
    host.phase !== "active" ||
    host.serverAccessProviderId !== "direct"
  ) {
    throw refusal(
      "An active direct worker without another handoff is required",
    );
  }

  if (row === null)
    return { hostId, providerId: "direct", retirementPending: false };
  const serverUrl = machineServerUrl(deps).url;

  if (
    serverUrl === null ||
    row.serverUrl !== serverUrl ||
    host.serverAccessGrantId !== hostId ||
    sessionId === null ||
    session?.id !== sessionId ||
    session.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION
  ) {
    throw refusal(
      "A connected compatible direct primary and its original retirement are required",
    );
  }

  const proof = createCurrentPrimaryProof(deps, hostId, serverUrl, sessionId);

  try {
    await callHostOnlineRpc(deps, {
      hostId,
      timeoutMs: 12_000,
      command: {
        type: "server_access.prove_current_primary",
        serverUrl,
        challenge: proof.challenge,
        instanceId: state.instanceId,
        expectedSessionId: sessionId,
      },
    });
    const current = getDirectRetirement(deps, hostId);
    const currentHost = getHost(deps.db, hostId);

    if (
      !proof.http ||
      !proof.ws ||
      proof.expiresAt < Date.now() ||
      directAccessState(deps) !== state ||
      state.proofs.get(proof.challenge) !== proof ||
      state.holds.get(hostId) !== heldChallenge ||
      (heldChallenge !== undefined &&
        state.proofs.get(heldChallenge) !== heldProof) ||
      !isOwnedRetirementHold(state, hostId, row) ||
      deps.hub.getDaemonSessionIdForHost(hostId) !== sessionId ||
      !sameRetirement(current, row) ||
      currentHost?.phase !== "active" ||
      currentHost.destroyedAt !== null ||
      currentHost.serverAccessProviderId !== "direct" ||
      currentHost.serverAccessGrantId !== host.serverAccessGrantId ||
      machineServerUrl(deps).url !== serverUrl
    ) {
      throw refusal(
        "Fresh direct proofs or their primary retirement owner changed",
      );
    }

    deps.db
      .update(serverAccessRetirements)
      .set({ primaryProofRuntimeId: state.instanceId })
      .where(eq(serverAccessRetirements.hostId, hostId))
      .run();
    await drainRetirement(deps, hostId);

    return {
      hostId,
      providerId: "direct",
      retirementPending: getDirectRetirement(deps, hostId) !== null,
    };
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.body.code === "direct_access_refused"
    )
      throw error;
    throw refusal(
      "Direct primary confirmation or owned grant retirement failed",
    );
  } finally {
    if (state.proofs.get(proof.challenge) === proof)
      state.proofs.delete(proof.challenge);
  }
}

export async function convertToDirect(
  deps: AppDeps,
  hostId: string,
): Promise<{
  hostId: string;
  providerId: "direct";
  retirementPending: boolean;
}> {
  const state = directAccessState(deps);

  if (getHost(deps.db, hostId)?.serverAccessProviderId === "direct") {
    return withServerAccessLane(deps, hostId, () =>
      confirmCurrentPrimaryAndDrain(deps, hostId),
    );
  }

  if (state.holds.has(hostId))
    throw new ApiError(
      409,
      "direct_access_conflict",
      "A direct access handoff is already pending",
    );
  const reserved = "reserving";
  state.holds.set(hostId, reserved);
  let committed = false;
  let challenge: string | null = null;
  let probeSent = false;
  let releaseUncertain = false;

  const refusal = (message: string) =>
    new ApiError(409, "direct_access_refused", message);

  function inspectIdle() {
    const primary = readPrimaryHostIdFromDataDir({
      dataDir: deps.config.dataDir,
    });

    if (primary === null)
      throw refusal("Authoritative server identity is unknown");

    if (primary === hostId)
      throw refusal(
        "The authoritative server machine cannot use a worker handoff",
      );

    const host = getHost(deps.db, hostId),
      session = getLatestSessionForHost(deps.db, { hostId });

    if (
      !host ||
      host.destroyedAt !== null ||
      host.phase !== "active" ||
      !deps.hub.hasDaemonForHost(hostId) ||
      session?.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION
    )
      throw refusal("An active connected compatible worker is required");

    const running = listRunningThreads(deps.db).some(
      (thread) => thread.hostId === null || thread.hostId === hostId,
    );

    const interactions = deps.db
      .select({ id: pendingInteractions.id })
      .from(pendingInteractions)
      .where(inArray(pendingInteractions.status, ["pending", "resolving"]))
      .all().length;

    const provisioning = deps.db
      .select({ id: environments.id })
      .from(environments)
      .where(
        and(
          eq(environments.hostId, hostId),
          eq(environments.status, "provisioning"),
        ),
      )
      .all().length;

    const terminals =
      deps.db
        .select({ id: terminalSessions.id })
        .from(terminalSessions)
        .where(
          and(
            eq(terminalSessions.hostId, hostId),
            ne(terminalSessions.status, "exited"),
          ),
        )
        .get() !== undefined;

    if (
      running ||
      interactions > 0 ||
      provisioning > 0 ||
      terminals ||
      deps.lifecycleDedupers.threadProvisionAdvance.size > 0 ||
      deps.lifecycleDedupers.queuedMessageDispatch.size > 0 ||
      deps.hub.countPendingHostRpcs(hostId) > 0
    )
      throw refusal("Worker work is busy or uncertain");

    return { host, session, url: machineServerUrl(deps).url };
  }

  try {
    const initial = inspectIdle();

    if (initial.url === null)
      throw refusal("A configured direct server URL is required");

    return await withServerAccessLane(deps, hostId, async () => {
      const idle = inspectIdle();

      if (idle.url !== initial.url || idle.session.id !== initial.session.id)
        throw refusal("Worker access changed during inspection");

      const proof = createDirectProof(
        deps,
        hostId,
        initial.url!,
        idle.session.id,
      );

      challenge = proof.challenge;

      try {
        probeSent = true;
        await callHostOnlineRpc(deps, {
          hostId,
          timeoutMs: 12_000,
          command: {
            type: "server_access.probe_direct",
            serverUrl: proof.serverUrl,
            challenge: proof.challenge,
            instanceId: state.instanceId,
          },
        });

        if (!proof.http || !proof.ws)
          throw refusal("Direct HTTP and WebSocket proof was not observed");
        const final = inspectIdle();

        if (
          final.url !== proof.serverUrl ||
          final.host.serverAccessProviderId !==
            idle.host.serverAccessProviderId ||
          final.host.serverAccessGrantId !== idle.host.serverAccessGrantId
        )
          throw refusal("Worker access changed before commit");
        const pending = getDirectRetirement(deps, hostId);
        deps.db.transaction((tx) => {
          if (pending === null)
            tx.insert(serverAccessRetirements)
              .values({
                hostId,
                providerId: final.host.serverAccessProviderId,
                grantId: final.host.serverAccessGrantId,
                acquisitionKey: acquisitionKey(final.host, hostId),
                serverUrl: proof.serverUrl,
                challenge: proof.challenge,
                primaryProofRuntimeId: null,
                createdAt: Date.now(),
              })
              .run();
          else
            tx.update(serverAccessRetirements)
              .set({
                serverUrl: proof.serverUrl,
                challenge: proof.challenge,
                primaryProofRuntimeId: null,
              })
              .where(eq(serverAccessRetirements.hostId, hostId))
              .run();
          tx.update(hosts)
            .set({
              serverAccessProviderId: "direct",
              serverAccessGrantId: hostId,
              statusMessage: null,
            })
            .where(eq(hosts.id, hostId))
            .run();
        });
        committed = true;
        proof.committed = true;
        deps.hub.sendDaemonMessage(hostId, {
          type: "server.moved",
          serverUrl: proof.serverUrl,
          headers: { "x-omnyo-direct-proof": proof.challenge },
        });
        await Promise.race([proof.primaryReady, sleep(2_000)]);

        if (proof.primary) await drainRetirement(deps, hostId);
      } catch (error) {
        if (!committed) {
          let cleanupError: { code: string; message: string } | undefined;

          if (probeSent) {
            try {
              await callHostOnlineRpc(deps, {
                hostId,
                timeoutMs: 3_000,
                command: {
                  type: "server_access.release_direct_probe",
                  challenge: proof.challenge,
                },
              });
            } catch (releaseError) {
              releaseUncertain = true;
              proof.releaseUncertain = true;
              cleanupError = {
                code:
                  releaseError instanceof ApiError
                    ? releaseError.body.code
                    : "direct_access_release_failed",
                message:
                  releaseError instanceof Error
                    ? releaseError.message
                    : "Worker admission release failed",
              };
            }
          }

          throw new ApiError(
            409,
            error instanceof ApiError
              ? error.body.code
              : "direct_access_refused",
            error instanceof Error ? error.message : "Direct proof failed",
            cleanupError === undefined
              ? undefined
              : { details: { releaseUncertain: true, cleanupError } },
          );
        }

        deps.logger.warn(
          { err: error, hostId },
          "Direct access retirement remains pending",
        );
      }

      return {
        hostId,
        providerId: "direct",
        retirementPending: getDirectRetirement(deps, hostId) !== null,
      };
    });
  } finally {
    if (
      !committed &&
      !releaseUncertain &&
      (state.holds.get(hostId) === reserved ||
        state.holds.get(hostId) === challenge)
    )
      state.holds.delete(hostId);
  }
}

export const serverAccess = {
  resolve: (deps: Dependencies, args: Parameters<typeof resolveOwned>[1]) =>
    withServerAccessLane(deps, args.hostId, () => resolveOwned(deps, args)),
  release: (
    deps: Dependencies,
    args: Parameters<typeof releaseOwned>[1],
    purpose?: "remove" | "repair",
  ) =>
    withServerAccessLane(deps, args.hostId, () =>
      releaseOwned(deps, args, purpose),
    ),
  repair: (deps: Dependencies, args: Parameters<typeof repairOwned>[1]) =>
    withServerAccessLane(deps, args.hostId, () => repairOwned(deps, args)),
};
