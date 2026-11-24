import { getAppSettings } from "@omnyo/db";
import { providerCliInstallEventSchema } from "@omnyo/host-daemon-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { getProviderInstallations } from "./provider-installations.js";
import { resolveBridgeLaunchForProviderId } from "./provider-bridge-launch.js";
import {
  pendingProviderCliUpdateRequest,
  providerCliUpdateResponse,
} from "./provider-cli-update.js";
import { reserveHostStartupDrain } from "./server-update-drain.js";
import { requestQueuedMessageDispatch } from "../threads/queued-message-dispatch.js";
import { setProviderCliStartupFailure } from "./provider-cli-startup-state.js";

const starts = new WeakMap<object, Map<string, Promise<void>>>();

const checkedSessions = new WeakMap<object, Map<string, string>>();

export function beginProviderCliStartup(
  deps: LoggedPendingInteractionWorkSessionDeps,
  hostId: string,
  sessionId: string,
): Promise<void> {
  let hosts = starts.get(deps.db);

  if (hosts === undefined) {
    hosts = new Map();
    starts.set(deps.db, hosts);
  }

  const current = hosts.get(hostId);

  if (current !== undefined) return current;
  const checked = checkedSessions.get(deps.db) ?? new Map<string, string>();
  checkedSessions.set(deps.db, checked);
  const existing = pendingProviderCliUpdateRequest(deps, hostId);
  const automatic = getAppSettings(deps.db).autoUpdateProviderClisOnStartup;

  if (existing === null && (checked.get(hostId) === sessionId || !automatic))
    return Promise.resolve();
  const release = reserveHostStartupDrain(deps.db, hostId);
  let selectedProviderId = "*";
  setProviderCliStartupFailure(deps.db, hostId, "*", null);

  const pending = Promise.resolve()
    .then(async () => {
      if (!(await deps.providerRegistry.whenRegistrationsSettled()))
        throw new Error("Provider registrations did not settle");

      if (existing !== null) {
        selectedProviderId = existing.providerId;
        await consumeUpdate(providerCliUpdateResponse(deps, existing));
      }

      if (!automatic || checked.get(hostId) === sessionId) return;

      const statuses = await getProviderInstallations(deps, {
        hostId,
        strict: true,
      });

      for (const [providerId, status] of Object.entries(statuses)) {
        selectedProviderId = providerId;
        setProviderCliStartupFailure(deps.db, hostId, providerId, null);

        if (
          !status.installed ||
          !status.needsUpdate ||
          status.installAction?.kind !== "update"
        )
          continue;
        const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, providerId);

        if (bridgeLaunch === null)
          throw new Error(`Provider bridge unavailable for ${providerId}`);

        const response = providerCliUpdateResponse(deps, {
          hostId,
          providerId,
          action: "update",
          bridgeLaunch,
        });

        await consumeUpdate(response);
      }

      checked.set(hostId, sessionId);
    })
    .catch((error: unknown) => {
      setProviderCliStartupFailure(
        deps.db,
        hostId,
        selectedProviderId,
        "Automatic CLI update failed. Check the installed version, then use Update now to retry.",
      );
      deps.logger.warn(
        {
          hostId,
          code: "provider_cli_startup_failed",
          failureKind: error instanceof Error ? error.name : "unknown",
        },
        "Provider CLI startup update failed",
      );
    })
    .finally(() => {
      release();

      if (hosts.get(hostId) === pending) hosts.delete(hostId);
      deps.hub.notifySystem(["config-changed"]);
      requestQueuedMessageDispatch(deps, { hostId, kind: "host-connected" });
      requestQueuedMessageDispatch(deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
    });

  hosts.set(hostId, pending);

  return pending;
}

async function consumeUpdate(response: Response): Promise<void> {
  const events = (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => providerCliInstallEventSchema.parse(JSON.parse(line)));

  const result = events
    .reverse()
    .find((event) => event.type === "error" || event.type === "completed");

  if (result?.type !== "completed" || !result.success)
    throw new Error("Provider CLI update did not complete successfully");
}
