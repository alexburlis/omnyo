import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { getExperiments } from "@omnyo/db";
import type { LastServerMove } from "@omnyo/domain";
import {
  readLastServerMoveFile,
  type ServerArchiveDigest,
  writeLastServerMoveFile,
} from "@omnyo/server-archive";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import {
  getGateAuthKind,
  type GateAuthHeaderReader,
} from "../request-context.js";
import { callHostOnlineRpc } from "../services/hosts/online-rpc.js";
import {
  assertUsableHostId,
  readPrimaryHostIdFromDataDir,
} from "../services/hosts/primary-host.js";
import {
  isServerMoveInFlight,
  type ServerMoveCoordinator,
} from "../services/server-move/coordinator.js";
import { streamServerExport } from "../services/server-move/export.js";
import { SERVER_EXPORT_FREE_SPACE } from "../services/server-move/export-snapshot.js";
import type { AppDeps } from "../types.js";

const SERVER_EXPORT_WORK_DIR_NAME = "server-export";

const CLIENT_CLOSED_REQUEST_STATUS = 499;

const DELETE_OLD_SERVER_COPY_TIMEOUT_MS = 5 * 60_000;

function assertServerManagementAllowed(context: GateAuthHeaderReader): void {
  if (
    getGateAuthKind(context) === "machine" ||
    context.req.header("authorization") !== undefined
  ) {
    throw new ApiError(
      403,
      "machine_host_management_forbidden",
      "Machine credentials cannot move, export, or clean up the server",
    );
  }
}

export const SERVER_MOVE_EXPERIMENT_DISABLED_MESSAGE =
  "Moving the server is off. Run omnyo settings experiment serverMove true, then try again.";

function assertServerMoveExperimentEnabled(deps: AppDeps): void {
  if (!getExperiments(deps.db).serverMove) {
    throw new ApiError(
      403,
      "server_move_experiment_disabled",
      SERVER_MOVE_EXPERIMENT_DISABLED_MESSAGE,
    );
  }
}

export async function readLastServerMove(
  dataDir: string,
): Promise<LastServerMove | null> {
  const file = await readLastServerMoveFile(dataDir);

  if (file === null) {
    return null;
  }

  const { version: _version, ...lastMove } = file;

  return lastMove;
}

function serverExportFileName(now: Date): string {
  return `omnyo-server-${now.toISOString().slice(0, 10)}.tar.gz`;
}

export function registerServerMoveRoutes(
  app: Hono,
  deps: AppDeps,
  serverMove: ServerMoveCoordinator,
): void {
  const { del, get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  const routes = publicApiRoutes.server;

  post(routes.checkMove, async (context, payload) => {
    assertServerManagementAllowed(context);
    assertServerMoveExperimentEnabled(deps);

    return context.json(await serverMove.check(payload));
  });

  post(routes.startMove, async (context, payload) => {
    assertServerManagementAllowed(context);
    assertServerMoveExperimentEnabled(deps);

    return context.json(await serverMove.start(payload));
  });

  get(routes.moveStatus, async (context) => {
    assertServerManagementAllowed(context);

    return context.json({
      move: serverMove.getStatus(),
      lastMove: await readLastServerMove(deps.config.dataDir),
    });
  });

  post(routes.cancelMove, async (context) => {
    assertServerManagementAllowed(context);

    return context.json(await serverMove.cancel());
  });

  post(routes.export, async (context) => {
    const { signal } = context.req.raw;
    assertServerManagementAllowed(context);
    assertServerMoveExperimentEnabled(deps);

    if (isServerMoveInFlight(serverMove.getStatus())) {
      throw new ApiError(
        409,
        "server_move_in_progress",
        "The server can't be exported while it is moving",
      );
    }

    const now = new Date();
    const fileName = serverExportFileName(now);
    const body = new PassThrough();

    const archive = await new Promise<ServerArchiveDigest | null>(
      (resolve, reject) => {
        let measured = false;

        void streamServerExport({
          appVersion: deps.config.appVersion,
          dataDir: deps.config.dataDir,
          db: deps.db,
          freeSpace: SERVER_EXPORT_FREE_SPACE,
          logger: deps.logger,
          now: now.getTime(),
          onMeasured: (digest) => {
            measured = true;
            resolve(digest);
          },
          output: body,
          signal,
          sourceServerHostId: readPrimaryHostIdFromDataDir({
            dataDir: deps.config.dataDir,
          }),
          vault: deps.vault,
          workDir: join(deps.config.dataDir, SERVER_EXPORT_WORK_DIR_NAME),
        }).catch((error: unknown) => {
          body.destroy();

          if (signal.aborted) {
            resolve(null);
          } else if (measured) {
            deps.logger.warn(
              { err: error },
              "Server export stopped while it was streaming",
            );
          } else {
            reject(error);
          }
        });
      },
    );

    if (archive === null) {
      return new Response(null, { status: CLIENT_CLOSED_REQUEST_STATUS });
    }

    return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${fileName}"`,
        "content-length": String(archive.sizeBytes),
        "content-type": "application/gzip",
        "x-omnyo-archive-sha256": archive.sha256,
      },
    });
  });

  del(publicApiRoutes.hosts.deleteOldServerCopy, async (context) => {
    assertServerManagementAllowed(context);
    assertServerMoveExperimentEnabled(deps);
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const lastMove = await readLastServerMoveFile(deps.config.dataDir);

    if (lastMove === null || lastMove.fromHostId !== hostId) {
      throw new ApiError(
        404,
        "old_server_copy_not_found",
        "This machine doesn't have an old server copy",
      );
    }

    const result = await callHostOnlineRpc(deps, {
      hostId,
      timeoutMs: DELETE_OLD_SERVER_COPY_TIMEOUT_MS,
      command: { type: "server_move.delete_old_copy" },
    });

    if (lastMove.oldCopyDeletedAt === null) {
      await writeLastServerMoveFile(deps.config.dataDir, {
        ...lastMove,
        oldCopyDeletedAt: Date.now(),
      });
    }

    deps.hub.notifySystem(["server-move-changed"]);

    return context.json({ deleted: result.deleted });
  });
}
