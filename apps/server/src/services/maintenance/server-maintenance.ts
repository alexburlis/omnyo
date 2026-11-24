import { createOriginAdoptionV1 } from "./origin-adoption-v1.js";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  environments,
  pendingInteractions,
  terminalSessions,
  listRunningThreads,
  getAppSettings,
  getPluginSettingsValues,
  setPluginSettingsValues,
  setAppSettings,
  setExperiments,
  getNonDestroyedHostByLaunchKey,
  updateHost,
} from "@omnyo/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { formatAppRuntimeFilePath } from "@omnyo/config/app-runtime-file";
import {
  readMaintenanceHold,
  readLastServerMoveFile,
  readServerImportFile,
  readServerMovedFile,
  writeMaintenanceHold,
  assertIdentityAdoptionHoldCanReleaseV1,
} from "@omnyo/server-archive";
import type {
  AcquireUpdateHold,
  ReleaseHold,
  MaintenanceHold,
  MaintenanceStatus,
  MaintenanceAcquireResult,
  MaintenanceReleaseResult,
  PrepareMaintenance,
  MaintenancePrepareResult,
  MaintenancePreparationResult,
} from "@omnyo/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { PluginService } from "../plugins/plugin-service.js";
import {
  reserveMaintenanceAdmission,
  maintenanceAdmissionReserved,
  startupManualTargetLaunchKey,
} from "./admission.js";
import { stopRunningServerWork } from "../server-move/stop-work.js";
import {
  submitMachine,
  waitForMachineCreation,
} from "../machines/provider-orchestration.js";
import { getMachineEnrollmentService } from "../machines/machine-services.js";
import { convertToDirect } from "../machines/server-access.js";
import { readPrimaryHostIdFromDataDir } from "../hosts/primary-host.js";
import {
  isServerMoveFrozen,
  isSourceMoveFrozen,
  isMaintenanceFrozen,
  setMaintenanceFrozen,
} from "../server-move/freeze-state.js";

export function createServerMaintenance(
  deps: AppDeps,
  plugins: PluginService,
  options: { originAdoptionAssets?(): Promise<readonly string[]> } = {},
) {
  const runtimeId = randomUUID();
  let hold = readMaintenanceHold(deps.config.dataDir);
  let resumeFramework: (() => Promise<void>) | null = null;
  let startDeferred: (() => void) | null = null;
  let suspendFramework: (() => Promise<void>) | null = null;

  let manualPreparation: {
    hostId: string;
    creationDone: boolean;
    preparationDone: boolean;
    enrollments: number;
    release: () => void;
  } | null = null;

  setMaintenanceFrozen(deps.db, hold !== null && hold.phase !== "released");

  if (hold !== null && hold.phase !== "released")
    plugins.setSchedulesPaused(true);

  function runtime(): MaintenanceStatus["runtime"] {
    return {
      runtimeId,
      processId: process.pid,
      parentProcessId: process.ppid,
      launchId: deps.config.launchId ?? null,
      dataDir: deps.config.dataDir,
      serverHostId: readPrimaryHostIdFromDataDir({
        dataDir: deps.config.dataDir,
      }),
      appVersion: deps.config.appVersion,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      runtimeRecordPath: formatAppRuntimeFilePath(deps.config.dataDir),
    };
  }

  function activity(): MaintenanceStatus["activity"] {
    return {
      runningThreads: listRunningThreads(deps.db).length,
      pendingInteractions: deps.db
        .select({ id: pendingInteractions.id })
        .from(pendingInteractions)
        .where(inArray(pendingInteractions.status, ["pending", "resolving"]))
        .all().length,
      hostRpcs: deps.hub.countPendingHostRpcs(),
      provisioning:
        deps.db
          .select({ id: environments.id })
          .from(environments)
          .where(eq(environments.status, "provisioning"))
          .all().length + deps.lifecycleDedupers.threadProvisionAdvance.size,
      queuedDispatches: deps.lifecycleDedupers.queuedMessageDispatch.size,
      ...plugins.getMaintenanceActivity(),
    };
  }

  async function persist(next: MaintenanceHold) {
    await writeMaintenanceHold(deps.config.dataDir, next);
    hold = next;
  }

  function ownershipError(): ApiError {
    return new ApiError(
      409,
      "maintenance_ownership_mismatch",
      "Server maintenance ownership does not match",
    );
  }

  function assertRole(expectedHost: string) {
    const host = runtime().serverHostId;

    if (host === null)
      throw new ApiError(
        503,
        "maintenance_unknown",
        "Authoritative server identity is unavailable",
      );

    if (host !== expectedHost) throw ownershipError();
  }

  function settleManualPreparation() {
    if (
      manualPreparation?.creationDone &&
      manualPreparation.preparationDone &&
      manualPreparation.enrollments === 0
    ) {
      manualPreparation.release();
      manualPreparation = null;
    }
  }

  function getRuntimeId(): string {
    if (runtime().serverHostId === null)
      throw new ApiError(
        503,
        "maintenance_unknown",
        "Authoritative server identity is unavailable",
      );

    return runtimeId;
  }

  function status(): MaintenanceStatus {
    getRuntimeId();

    return {
      contractVersion: 1,
      privateUpdateManifestSchema: 2,
      runtime: runtime(),
      hold: hold?.phase === "released" ? null : hold,
      activity: activity(),
    };
  }

  const originAdoption = createOriginAdoptionV1({
    dataDir: deps.config.dataDir,
    status,
    assetPaths: options.originAdoptionAssets,
  });

  return {
    originAdoption,
    getRuntimeId,
    isHeld: () => isMaintenanceFrozen(deps.db),
    status,
    bindFrameworkResume(
      resume: () => Promise<void>,
      start?: () => void,
      suspend?: () => Promise<void>,
    ) {
      resumeFramework = resume;
      startDeferred = start ?? null;
      suspendFramework = suspend ?? null;
    },
    async acquire(input: AcquireUpdateHold): Promise<MaintenanceAcquireResult> {
      const releaseAdmission = reserveMaintenanceAdmission(deps.db);
      const wasFrozen = isServerMoveFrozen(deps.db);
      setMaintenanceFrozen(deps.db, true);
      let durable = hold !== null && hold.phase !== "released";

      try {
        assertRole(input.expectedServerHostId);

        if (
          input.expectedRuntimeId !== runtimeId ||
          input.expectedDataDir !== deps.config.dataDir
        )
          throw ownershipError();

        if (durable) {
          if (
            hold?.id !== input.id ||
            hold.ownerId !== input.ownerId ||
            hold.kind !== "desktop-update" ||
            hold.phase !== "held"
          )
            throw new ApiError(
              409,
              "maintenance_conflict",
              "A different or uncertain maintenance hold exists",
            );

          return { acquired: true, runtime: runtime(), hold };
        }

        if (wasFrozen)
          throw new ApiError(
            409,
            "maintenance_conflict",
            "A server move is already in progress",
          );
        const counts = activity();

        if (Object.values(counts).some((count) => count > 0))
          throw new ApiError(
            409,
            "maintenance_busy",
            "Registered server work is still active",
          );

        if (
          deps.db
            .select({ id: terminalSessions.id })
            .from(terminalSessions)
            .where(
              inArray(terminalSessions.status, [
                "starting",
                "running",
                "disconnected",
              ]),
            )
            .get() !== undefined
        )
          throw new ApiError(
            409,
            "maintenance_busy",
            "A registered terminal remains active",
          );

        const next: MaintenanceHold = {
          version: 1,
          id: input.id,
          ownerId: input.ownerId,
          kind: "desktop-update",
          phase: "acquiring",
          serverHostId: input.expectedServerHostId,
          createdAt: Date.now(),
          artifact: null,
        };

        await persist(next);
        durable = true;
        plugins.setSchedulesPaused(true);

        try {
          await suspendFramework?.();
          await plugins.suspendPlugins({ keep: () => false, strict: true });
          const after = activity();

          if (Object.values(after).some((count) => count > 0))
            throw new Error("Framework quiescence could not be proved");
          await persist({ ...next, phase: "held" });
        } catch (error) {
          throw new ApiError(
            503,
            "maintenance_unknown",
            error instanceof Error
              ? error.message
              : "Registered owner disposal failed",
          );
        }

        return {
          acquired: true,
          runtime: runtime(),
          hold: { ...next, phase: "held" },
        };
      } finally {
        if (!durable) {
          const persisted = readMaintenanceHold(deps.config.dataDir);

          if (persisted !== null && persisted.phase !== "released") {
            hold = persisted;
            durable = true;
          } else setMaintenanceFrozen(deps.db, false);
        }

        releaseAdmission();
      }
    },
    async prepare(
      input: PrepareMaintenance,
    ): Promise<MaintenancePrepareResult> {
      const releaseAdmission = reserveMaintenanceAdmission(deps.db);
      let transferred = false;

      try {
        assertRole(input.expectedServerHostId);

        if (
          input.expectedRuntimeId !== runtimeId ||
          input.expectedDataDir !== deps.config.dataDir ||
          hold === null ||
          hold.kind !== "startup" ||
          hold.phase !== "held" ||
          hold.id !== input.id ||
          hold.ownerId !== input.ownerId ||
          hold.serverHostId !== input.expectedServerHostId
        )
          throw ownershipError();

        if (
          (await readServerImportFile(deps.config.dataDir)) !== null ||
          (await readServerMovedFile(deps.config.dataDir)) !== null
        )
          throw new ApiError(
            409,
            "maintenance_conflict",
            "Migration authority prevents preparation",
          );
        const operation = input.operation;
        let result: MaintenancePreparationResult;

        switch (operation.type) {
          case "quiesce":
            await stopRunningServerWork(deps, {
              targetHostName: "the prepared target",
              timeoutMs: 30_000,
            });
            result = { type: operation.type, threadsStopped: true };
            break;
          case "create-manual-target": {
            const key = startupManualTargetLaunchKey(hold.id);

            const host = await submitMachine(deps, {
              key,
              machineProviderId: "manual",
              inputs: null,
            });

            if (host.machineProviderId !== "manual")
              throw new ApiError(
                409,
                "maintenance_conflict",
                "Startup target is not a manual machine",
              );
            updateHost(deps.db, deps.hub, host.id, { name: operation.name });

            if (host.lifecycle.phase === "creating") {
              manualPreparation = {
                hostId: host.id,
                creationDone: false,
                preparationDone: false,
                enrollments: 0,
                release: releaseAdmission,
              };
              transferred = true;
              void waitForMachineCreation(deps, host.id)
                .finally(() => {
                  if (manualPreparation?.hostId === host.id) {
                    manualPreparation.creationDone = true;
                    settleManualPreparation();
                  }
                })
                .catch((error) =>
                  deps.logger.error(
                    { err: error },
                    "Startup manual target preparation failed",
                  ),
                );
            }

            await getMachineEnrollmentService(deps)
              .forOwner("core")
              .prepare({ key, signal: AbortSignal.timeout(60_000) });
            result = { type: operation.type, hostId: host.id };
            break;
          }

          case "configure-direct-access": {
            const machineServerUrl = operation.machineServerUrl.replace(
              /\/$/u,
              "",
            );

            const scriptHostId = getPluginSettingsValues(
              deps.db,
              "automations",
            ).scriptHostId;

            if (
              scriptHostId === undefined ||
              scriptHostId === JSON.stringify("")
            ) {
              setPluginSettingsValues(deps.db, "automations", {
                scriptHostId: JSON.stringify(input.expectedServerHostId),
              });
            }

            setPluginSettingsValues(deps.db, "connect", {
              remoteAccess: JSON.stringify(false),
            });
            setAppSettings(deps.db, {
              ...getAppSettings(deps.db),
              machineServerUrl,
              defaultMachineAccess: "direct",
            });
            deps.hub.notifySystem(["config-changed"]);
            result = { type: operation.type, machineServerUrl };
            break;
          }

          case "convert-to-direct":
            await convertToDirect(deps, operation.hostId);
            result = { type: operation.type, hostId: operation.hostId };
            break;
          case "enable-server-move":
            setExperiments(deps.db, { serverMove: true });
            deps.hub.notifySystem(["config-changed"]);
            result = { type: operation.type, enabled: true };
            break;
          case "rebind-plugin": {
            const rootDir = await plugins.rebindInstalledPath(
              operation.pluginId,
              operation.rootDir,
            );

            result = {
              type: operation.type,
              pluginId: operation.pluginId,
              rootDir,
            };
            break;
          }
        }

        return { prepared: true, id: input.id, result };
      } finally {
        if (transferred && manualPreparation !== null) {
          manualPreparation.preparationDone = true;
          settleManualPreparation();
        } else releaseAdmission();
      }
    },
    canEnrollStartupTarget(hostId: string): boolean {
      if (
        hold?.kind !== "startup" ||
        hold.phase !== "held" ||
        isSourceMoveFrozen(deps.db) ||
        (maintenanceAdmissionReserved(deps.db) &&
          manualPreparation?.hostId !== hostId)
      )
        return false;

      const target = getNonDestroyedHostByLaunchKey(
        deps.db,
        startupManualTargetLaunchKey(hold.id),
      );

      return target?.id === hostId && target.machineProviderId === "manual";
    },
    reserveStartupEnrollment(hostId: string): () => void {
      if (manualPreparation?.hostId === hostId) {
        manualPreparation.enrollments += 1;

        return () => {
          if (manualPreparation?.hostId === hostId) {
            manualPreparation.enrollments -= 1;
            settleManualPreparation();
          }
        };
      }

      return reserveMaintenanceAdmission(deps.db);
    },
    async release(input: ReleaseHold): Promise<MaintenanceReleaseResult> {
      const releaseAdmission = reserveMaintenanceAdmission(deps.db);

      try {
        assertRole(input.expectedServerHostId);

        if (
          hold === null ||
          hold.id !== input.id ||
          hold.ownerId !== input.ownerId ||
          hold.serverHostId !== input.expectedServerHostId
        )
          throw ownershipError();

        if (isSourceMoveFrozen(deps.db))
          throw new ApiError(
            409,
            "maintenance_conflict",
            "A server move still owns source admission",
          );

        if (hold.phase === "released") return { released: true, id: input.id };

        if (hold.identityAdoption !== undefined) {
          try {
            assertIdentityAdoptionHoldCanReleaseV1(deps.config.dataDir, hold);
          } catch (error) {
            throw new ApiError(
              409,
              "maintenance_conflict",
              error instanceof Error
                ? error.message
                : "Identity adoption authority is not confirmed",
            );
          }
        } else if (hold.kind === "migration") {
          const last = await readLastServerMoveFile(deps.config.dataDir);

          if (
            last?.moveId !== hold.id ||
            last.toHostId !== hold.serverHostId ||
            (await readServerImportFile(deps.config.dataDir)) !== null ||
            (await readServerMovedFile(deps.config.dataDir)) !== null
          )
            throw new ApiError(
              409,
              "maintenance_conflict",
              "Migration authority is not confirmed for this server",
            );
        }

        await persist({ ...hold, phase: "released" });
        setMaintenanceFrozen(deps.db, false);
        plugins.setSchedulesPaused(false);
        await plugins.resumeMaintenancePlugins();
        await resumeFramework?.();
        startDeferred?.();

        return { released: true, id: input.id };
      } finally {
        releaseAdmission();
      }
    },
  };
}

export type ServerMaintenance = ReturnType<typeof createServerMaintenance>;
