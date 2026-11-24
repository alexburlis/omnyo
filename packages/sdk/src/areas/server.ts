import type {
  MaintenanceStatus,
  ServerRuntimeIdentity,
  AcquireUpdateHold,
  MaintenanceAcquireResult,
  ReleaseHold,
  MaintenanceReleaseResult,
  PrepareMaintenance,
  MaintenancePrepareResult,
} from "@omnyo/server-contract";
import type {
  ServerMoveCheckRequest,
  ServerMoveCheckResponse,
  ServerMoveStartRequest,
  ServerMoveStatus,
  ServerMoveStatusResponse,
} from "@omnyo/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type {
  IdentityAdoptionBinding,
  IdentityAdoptionControlRequestV1,
} from "@omnyo/domain";

export type {
  PrepareMaintenance,
  MaintenancePreparationOperation,
  MaintenancePreparationResult,
  MaintenancePrepareResult,
  ServerMoveCheckItem,
  ServerMoveCheckRequest,
  ServerMoveCheckResponse,
  ServerMoveStartRequest,
  ServerMoveState,
  ServerMoveStatus,
  ServerMoveStatusResponse,
  ServerMoveStep,
} from "@omnyo/server-contract";

export interface ServerMoveCheckArgs extends ServerMoveCheckRequest {
  signal?: AbortSignal;
}

export interface ServerMoveStatusArgs {
  signal?: AbortSignal;
}

export interface ServerExportArgs {
  signal?: AbortSignal;
}

export interface ServerExportResult {
  fileName: string;
  body: ReadableStream<Uint8Array>;
  sha256: string;
}

export interface ExperimentalServerArea {
  maintenance: {
    status(): Promise<MaintenanceStatus>;
    acquire(input: AcquireUpdateHold): Promise<MaintenanceAcquireResult>;
    prepare(input: PrepareMaintenance): Promise<MaintenancePrepareResult>;
    release(input: ReleaseHold): Promise<MaintenanceReleaseResult>;
  };
  runtimeIdentity(): Promise<ServerRuntimeIdentity>;
  checkMove(args: ServerMoveCheckArgs): Promise<ServerMoveCheckResponse>;
  startMove(args: ServerMoveStartRequest): Promise<ServerMoveStatus>;
  moveStatus(args?: ServerMoveStatusArgs): Promise<ServerMoveStatusResponse>;
  cancelMove(): Promise<ServerMoveStatus>;
  export(args?: ServerExportArgs): Promise<ServerExportResult>;
}

const EXPORT_FILE_NAME_PATTERN = /filename="([^"]+)"/u;

const EXPORT_SHA256_HEADER = "x-omnyo-archive-sha256";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

function exportFileName(contentDisposition: string | null): string {
  const match =
    contentDisposition === null
      ? null
      : EXPORT_FILE_NAME_PATTERN.exec(contentDisposition);

  return match?.[1] ?? "omnyo-server-export";
}

export function createServerArea(
  args: CreateSdkAreaArgs,
): ExperimentalServerArea {
  const { transport } = args;

  return {
    maintenance: {
      status: () =>
        transport.readJson(transport.api.v1.server.maintenance.$get()),
      acquire: (input) =>
        transport.readJson(
          transport.api.v1.server.maintenance.acquire.$post({ json: input }),
        ),
      prepare: (input) =>
        transport.readJson(
          transport.api.v1.server.maintenance.prepare.$post({ json: input }),
        ),
      release: (input) =>
        transport.readJson(
          transport.api.v1.server.maintenance.release.$post({ json: input }),
        ),
    },
    runtimeIdentity: () =>
      transport.readJson(transport.api.v1.server.runtime.$get()),
    async checkMove(input) {
      return transport.readJson(
        transport.api.v1.server.move.check.$post(
          {
            json: {
              targetHostId: input.targetHostId,
              serverUrl: input.serverUrl,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async startMove(input) {
      return transport.readJson(
        transport.api.v1.server.move.$post({
          json: {
            targetHostId: input.targetHostId,
            serverUrl: input.serverUrl,
            stopRunningWork: input.stopRunningWork,
            archiveExistingTargetServerData:
              input.archiveExistingTargetServerData,
            startupOwnership: input.startupOwnership,
          },
        }),
      );
    },
    async moveStatus(input) {
      return transport.readJson(
        transport.api.v1.server.move.$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async cancelMove() {
      return transport.readJson(transport.api.v1.server.move.cancel.$post());
    },
    async export(input) {
      const response = await transport.resolve(
        transport.api.v1.server.export.$post(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );

      if (response.body === null) {
        throw new Error("The server returned an empty export");
      }

      const sha256 = response.headers.get(EXPORT_SHA256_HEADER);

      if (sha256 === null || !SHA256_HEX_PATTERN.test(sha256)) {
        await response.body.cancel().catch(() => undefined);
        throw new Error(
          "The server did not send a SHA-256 digest for the export",
        );
      }

      return {
        fileName: exportFileName(response.headers.get("content-disposition")),
        body: response.body,
        sha256,
      };
    },
  };
}
