import type { DbConnection } from "@omnyo/db";
import type { ProviderCliStatusResponse } from "@omnyo/host-daemon-contract";
import type { HostProviderCliStatusResponse } from "@omnyo/server-contract";
import { ApiError } from "../../errors.js";

const failures = new WeakMap<DbConnection, Map<string, string>>();

export function hasProviderCliStartupFailure(
  db: DbConnection,
  hostId: string,
): boolean {
  return [...(failures.get(db)?.keys() ?? [])].some((key) =>
    key.startsWith(`${hostId} `),
  );
}

export function reconcileProviderCliStartupFailures(
  db: DbConnection,
  hostId: string,
  statuses: ProviderCliStatusResponse,
): void {
  setProviderCliStartupFailure(db, hostId, "*", null);

  for (const [providerId, status] of Object.entries(statuses)) {
    if (
      status.installed &&
      status.latestVersion !== null &&
      !status.needsUpdate &&
      !status.versionUnsupported
    )
      setProviderCliStartupFailure(db, hostId, providerId, null);
  }
}

export function setProviderCliStartupFailure(
  db: DbConnection,
  hostId: string,
  providerId: string,
  message: string | null,
): void {
  const entries = failures.get(db) ?? new Map<string, string>();
  failures.set(db, entries);
  const key = `${hostId} ${providerId}`;

  if (message === null) entries.delete(key);
  else entries.set(key, message);
}

export function withProviderCliStartupFailures(
  db: DbConnection,
  hostId: string,
  statuses: ProviderCliStatusResponse,
): HostProviderCliStatusResponse {
  const entries = failures.get(db);

  if (entries !== undefined) {
    for (const [key, message] of entries) {
      if (!key.startsWith(`${hostId} `)) continue;
      const providerId = key.slice(hostId.length + 1);

      if (
        (providerId === "*" && Object.keys(statuses).length === 0) ||
        (providerId !== "*" && statuses[providerId] === undefined)
      )
        throw new ApiError(502, "provider_cli_startup_failed", message);
    }
  }

  return Object.fromEntries(
    Object.entries(statuses).map(([providerId, status]) => {
      const startupUpdateError =
        failures.get(db)?.get(`${hostId} ${providerId}`) ??
        failures.get(db)?.get(`${hostId} *`);

      return [
        providerId,
        startupUpdateError === undefined
          ? status
          : { ...status, startupUpdateError },
      ];
    }),
  );
}
