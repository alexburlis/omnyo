import { resolve } from "node:path";
import type { ServerConfig } from "@omnyo/config/server";
import {
  readMaintenanceHold,
  readServerImportFile,
  readServerMovedFile,
  writeMaintenanceHold,
} from "@omnyo/server-archive";
import { readPrimaryHostIdFromDataDir } from "../hosts/primary-host.js";
import { readServerMoveRunFile } from "../server-move/run-state.js";

export async function ensureStartupHold(config: ServerConfig) {
  const request = config.OMNYO_SERVER_STARTUP_HOLD;
  const current = readMaintenanceHold(config.OMNYO_DATA_DIR);

  if (request === undefined) return current;

  if (
    request.expectedDataDir !== config.OMNYO_DATA_DIR ||
    resolve(config.OMNYO_DATA_DIR) !== config.OMNYO_DATA_DIR ||
    readPrimaryHostIdFromDataDir({ dataDir: config.OMNYO_DATA_DIR }) !==
      request.expectedServerHostId
  )
    throw new Error("Startup maintenance ownership does not match this server");

  if (
    (await readServerImportFile(config.OMNYO_DATA_DIR)) !== null ||
    (await readServerMovedFile(config.OMNYO_DATA_DIR)) !== null
  )
    throw new Error("Startup maintenance conflicts with migration authority");

  if (current !== null) {
    if (
      current.kind !== "startup" ||
      current.phase !== "held" ||
      current.id !== request.id ||
      current.ownerId !== request.ownerId ||
      current.serverHostId !== request.expectedServerHostId
    )
      throw new Error("Startup maintenance conflicts with the existing hold");

    return current;
  }

  if ((await readServerMoveRunFile(config.OMNYO_DATA_DIR)) !== null)
    throw new Error("Startup maintenance conflicts with source move authority");

  const hold = {
    version: 1 as const,
    id: request.id,
    ownerId: request.ownerId,
    kind: "startup" as const,
    phase: "held" as const,
    serverHostId: request.expectedServerHostId,
    createdAt: Date.now(),
    artifact: null,
  };

  await writeMaintenanceHold(config.OMNYO_DATA_DIR, hold);

  return hold;
}
