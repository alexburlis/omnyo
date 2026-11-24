import type { DbConnection } from "@omnyo/db";
import { ApiError } from "../../errors.js";
import { isSourceMoveFrozen } from "../server-move/freeze-state.js";

const transitions = new WeakMap<DbConnection, symbol>();

export function reserveMaintenanceAdmission(db: DbConnection): () => void {
  if (transitions.has(db) || isSourceMoveFrozen(db))
    throw new ApiError(
      409,
      "maintenance_conflict",
      "A server admission transition is already in progress",
    );
  const reservation = Symbol();
  transitions.set(db, reservation);

  return () => {
    if (transitions.get(db) === reservation) transitions.delete(db);
  };
}

export function maintenanceAdmissionReserved(db: DbConnection): boolean {
  return transitions.has(db);
}

export function startupManualTargetLaunchKey(holdId: string): string {
  return `startup-maintenance:${holdId}:manual-target`;
}
