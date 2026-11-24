import type { DbConnection } from "@omnyo/db";
import type { AppDeps } from "../../types.js";

type UpdateAdmissionDeps = Pick<AppDeps, "db">;

const drainingDatabases = new WeakSet<DbConnection>();

const drainingHosts = new WeakMap<DbConnection, Map<string, symbol>>();

const startingHosts = new WeakMap<DbConnection, Set<string>>();

export function isServerRestartDraining(db: DbConnection): boolean {
  return drainingDatabases.has(db);
}

export function reserveHostStartupDrain(
  db: DbConnection,
  hostId: string,
): () => void {
  const hosts = startingHosts.get(db) ?? new Set<string>();
  startingHosts.set(db, hosts);
  hosts.add(hostId);

  return () => {
    hosts.delete(hostId);
  };
}

export function reserveHostUpdateDrain(
  db: DbConnection,
  hostId: string,
): () => void {
  const hosts = drainingHosts.get(db) ?? new Map<string, symbol>();
  drainingHosts.set(db, hosts);

  if (hosts.has(hostId))
    throw new Error("The machine already has an update in progress");
  const owner = Symbol(hostId);
  hosts.set(hostId, owner);

  return () => {
    if (hosts.get(hostId) === owner) hosts.delete(hostId);
  };
}

export function isHostUpdateDraining(
  deps: UpdateAdmissionDeps,
  hostId: string | null,
): boolean {
  return (
    hostId !== null &&
    ((drainingHosts.get(deps.db)?.has(hostId) ?? false) ||
      (startingHosts.get(deps.db)?.has(hostId) ?? false))
  );
}

export function setServerUpdateDraining(
  db: DbConnection,
  draining: boolean,
): void {
  if (draining) drainingDatabases.add(db);
  else drainingDatabases.delete(db);
}

export function isServerUpdateDraining(
  deps: UpdateAdmissionDeps,
  hostId: string | null = null,
): boolean {
  return drainingDatabases.has(deps.db) || isHostUpdateDraining(deps, hostId);
}
