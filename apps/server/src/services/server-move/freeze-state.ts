import type { DbConnection } from "@omnyo/db";
import { ApiError } from "../../errors.js";

export const SERVER_MOVE_FROZEN_RETRY_MS = 10_000;

const frozenDatabases = new WeakSet<DbConnection>();

export function setServerMoveFrozen(db: DbConnection, frozen: boolean): void {
  if (frozen) {
    frozenDatabases.add(db);

    return;
  }

  frozenDatabases.delete(db);
}

export function isSourceMoveFrozen(db: DbConnection): boolean {
  return frozenDatabases.has(db);
}

export function isServerMoveFrozen(db: DbConnection): boolean {
  return frozenDatabases.has(db) || maintenanceDatabases.has(db);
}

const snapshotFencedDatabases = new WeakSet<DbConnection>();

export function setServerMoveSnapshotFence(
  db: DbConnection,
  fenced: boolean,
): void {
  if (fenced) {
    snapshotFencedDatabases.add(db);

    return;
  }

  snapshotFencedDatabases.delete(db);
}

export function isServerMoveSnapshotFenced(db: DbConnection): boolean {
  return snapshotFencedDatabases.has(db);
}

export function serverMovingError(): ApiError {
  return new ApiError(
    503,
    "server_moving",
    "The server is moving to another machine. Changes are paused until the move finishes or is cancelled.",
    true,
  );
}

const maintenanceDatabases = new WeakSet<DbConnection>();

export function setMaintenanceFrozen(db: DbConnection, frozen: boolean): void {
  if (frozen) maintenanceDatabases.add(db);
  else maintenanceDatabases.delete(db);
}

export function isMaintenanceFrozen(db: DbConnection): boolean {
  return maintenanceDatabases.has(db);
}
