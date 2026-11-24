import { hostProviderCliInstallEventSchema } from "@omnyo/server-contract";
import type { Host, HostType } from "@omnyo/domain";
import type {
  CreateHostJoinCodeResponse,
  CreateMachineRequest,
  HostEnrollmentCommandResponse,
  HostReconnectResponse,
  HostCloneDefaultPathQuery,
  HostCloneDefaultPathResponse,
  HostDirectoryListing,
  HostDirectoryQuery,
  HostGetResponse,
  HostHousekeepingResponse,
  HostDiscoveredReposResponse,
  HostActionResponse,
  HostPathsExistRequest,
  HostPathsExistResponse,
  HostPickFolderRequest,
  HostPickFolderResponse,
  HostProviderCliInstallEvent,
  HostProviderCliInstallRequest,
  HostProviderCliStatusResponse,
  HostRetryUpdateResponse,
  DeleteOldServerCopyResponse,
  UpdateHostRequest,
  UpdateHostAvailabilityRequest,
  SystemMachineProvider,
} from "@omnyo/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface HostGetArgs {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostDeleteArgs {
  hostId: string;
}

export interface HostUpdateArgs extends UpdateHostRequest {
  hostId: string;
}

export interface HostSetAvailabilityArgs extends UpdateHostAvailabilityRequest {
  hostId: string;
}

export interface HostRetryUpdateArgs {
  hostId: string;
}

export interface HostActionArgs {
  hostId: string;
}

export interface HostReconnectArgs extends HostActionArgs {
  signal?: AbortSignal;
}

export interface HostDirectoryArgs extends HostDirectoryQuery {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostDiscoverReposArgs {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostCloneDefaultPathArgs extends HostCloneDefaultPathQuery {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostPathsExistArgs extends HostPathsExistRequest {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostPickFolderArgs extends HostPickFolderRequest {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostProviderCliInstallArgs extends HostProviderCliInstallRequest {
  hostId: string;
  onEvent?: (event: HostProviderCliInstallEvent) => void;
}

export interface HostListArgs {
  includeCreating?: boolean;
  type?: HostType;
  signal?: AbortSignal;
}

export interface MachineCreateArgs extends CreateMachineRequest {
  wait?: boolean;
  signal?: AbortSignal;
}

export interface MachineProviderListArgs {
  signal?: AbortSignal;
}

export type HostCreateJoinCodeResult = CreateHostJoinCodeResponse;

export type HostDeleteResult = { ok: true };

export type HostDirectoryResult = HostDirectoryListing;

export type HostDiscoverReposResult = HostDiscoveredReposResponse;

export type HostGetResult = HostGetResponse;

export type HostEnrollmentCommandResult = HostEnrollmentCommandResponse;

export type HostReconnectResult = HostReconnectResponse;

export type HostCloneDefaultPathResult = HostCloneDefaultPathResponse;

export type HostProviderCliInstallResult = HostProviderCliInstallEvent[];

export type HostListResult = Host[];

export type HostPathsExistResult = HostPathsExistResponse;

export type HostPickFolderResult = HostPickFolderResponse;

export type HostProviderCliStatusResult = HostProviderCliStatusResponse;

export type HostRetryUpdateResult = HostRetryUpdateResponse;

export type HostActionResult = HostActionResponse;

export type HostUpdateResult = Host;

export type MachineProviderListResult = SystemMachineProvider[];

export interface HostsArea {
  experimental_housekeeping(
    args: HostGetArgs,
  ): Promise<HostHousekeepingResponse>;
  convertToDirect(hostId: string): Promise<{
    hostId: string;
    providerId: "direct";
    retirementPending: boolean;
  }>;
  experimental_create(args: MachineCreateArgs): Promise<Host>;
  experimental_getEnrollmentCommand(
    args: HostGetArgs,
  ): Promise<HostEnrollmentCommandResult>;
  experimental_reconnect(args: HostReconnectArgs): Promise<HostReconnectResult>;
  /** @deprecated Use experimental_create() and experimental_getEnrollmentCommand() for bootstrap enrollment. */
  createJoinCode(): Promise<HostCreateJoinCodeResult>;
  delete(args: HostDeleteArgs): Promise<HostDeleteResult>;
  experimental_deleteOldServerCopy(
    args: HostActionArgs,
  ): Promise<DeleteOldServerCopyResponse>;
  directory(args: HostDirectoryArgs): Promise<HostDirectoryResult>;
  experimental_discoverRepos(
    args: HostDiscoverReposArgs,
  ): Promise<HostDiscoverReposResult>;
  get(args: HostGetArgs): Promise<HostGetResult>;
  cloneDefaultPath(
    args: HostCloneDefaultPathArgs,
  ): Promise<HostCloneDefaultPathResult>;
  installProviderCli(
    args: HostProviderCliInstallArgs,
  ): Promise<HostProviderCliInstallResult>;
  list(args?: HostListArgs): Promise<HostListResult>;
  experimental_listProviders(
    args?: MachineProviderListArgs,
  ): Promise<MachineProviderListResult>;
  pathsExist(args: HostPathsExistArgs): Promise<HostPathsExistResult>;
  pickFolder(args: HostPickFolderArgs): Promise<HostPickFolderResult>;
  providerCliStatus(args: HostGetArgs): Promise<HostProviderCliStatusResult>;
  experimental_resume(args: HostActionArgs): Promise<Host>;
  experimental_retryCleanup(args: HostActionArgs): Promise<HostActionResult>;
  retryUpdate(args: HostRetryUpdateArgs): Promise<HostRetryUpdateResult>;
  experimental_setAvailability(args: HostSetAvailabilityArgs): Promise<Host>;
  experimental_suspend(args: HostActionArgs): Promise<Host>;
  experimental_reconcile(args: HostActionArgs): Promise<Host>;
  update(args: HostUpdateArgs): Promise<HostUpdateResult>;
}

export function createHostsArea(args: CreateSdkAreaArgs): HostsArea {
  const { transport } = args;

  return {
    experimental_housekeeping: (input) =>
      transport.readJson(
        transport.api.v1.hosts[":id"].housekeeping.$get(
          { param: { id: input.hostId } },
          ...signalRequestArgs(input.signal),
        ),
      ),
    convertToDirect: (hostId) =>
      transport.readJson(
        transport.api.v1.hosts[":id"]["direct-access"].$post({
          param: { id: hostId },
        }),
      ),
    async experimental_create(input) {
      let host = await transport.readJson(
        transport.api.v1.hosts.$post(
          {
            json: {
              machineProviderId: input.machineProviderId,
              inputs: input.inputs,
              ...(input.key === undefined ? {} : { key: input.key }),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );

      if (input.wait === false) return host;

      for (;;) {
        input.signal?.throwIfAborted();

        if (host.lifecycle.phase === "active") return host;

        if (
          host.lifecycle.phase === "removing" ||
          host.lifecycle.phase === "destroyed"
        )
          throw new Error(
            host.lifecycle.message ?? "Machine creation cancelled",
          );
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        host = await this.get({ hostId: host.id, signal: input.signal });
      }
    },
    async experimental_getEnrollmentCommand(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["enrollment-command"].$get(
          {
            param: { id: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_reconnect(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["reconnect-commands"].$post(
          { param: { id: input.hostId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async createJoinCode() {
      return transport.readJson(
        transport.api.v1.hosts["join-codes"].$post({
          json: {},
        }),
      );
    },
    async delete(input) {
      await transport.readVoid(
        transport.api.v1.hosts[":id"].$delete({
          param: { id: input.hostId },
        }),
      );

      return { ok: true };
    },
    async experimental_deleteOldServerCopy(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["old-server-copy"].$delete({
          param: { id: input.hostId },
        }),
      );
    },
    async directory(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].directory.$get(
          {
            param: { id: input.hostId },
            query: { path: input.path },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_discoverRepos(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["discovered-repos"].$get(
          { param: { id: input.hostId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async get(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].$get(
          {
            param: { id: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async cloneDefaultPath(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["clone-default-path"].$get(
          {
            param: { id: input.hostId },
            query: { projectId: input.projectId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async installProviderCli(input) {
      const response = await transport.resolve(
        transport.api.v1.hosts[":id"]["provider-clis"].install.$post({
          param: { id: input.hostId },
          json: {
            provider: input.provider,
            actionKind: input.actionKind,
            ...(input.confirmInterruptingThreads === undefined
              ? {}
              : {
                  confirmInterruptingThreads: input.confirmInterruptingThreads,
                }),
          },
        }),
      );

      const events: HostProviderCliInstallEvent[] = [];

      const consumeLine = (line: string) => {
        if (line.trim().length === 0) return;
        const event = hostProviderCliInstallEventSchema.parse(JSON.parse(line));
        events.push(event);
        input.onEvent?.(event);
      };

      const reader = response.body?.getReader();

      if (reader === undefined) {
        const text: string = await response.text();

        for (const line of text.split(/\r?\n/u)) {
          consumeLine(line);
        }

        return events;
      }

      const decoder = new TextDecoder();
      let pending = "";

      try {
        while (true) {
          const chunk = await reader.read();
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          const lines = pending.split(/\r?\n/u);
          pending = lines.pop() ?? "";

          for (const line of lines) consumeLine(line);

          if (chunk.done) break;
        }

        consumeLine(pending);
      } finally {
        reader.releaseLock();
      }

      return events;
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.hosts.$get(
          {
            query: {
              ...(input?.includeCreating === undefined
                ? {}
                : {
                    includeCreating: input.includeCreating ? "true" : "false",
                  }),
              ...(input?.type === undefined ? {} : { type: input.type }),
            },
          },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async experimental_listProviders(input) {
      const response = await transport.readJson(
        transport.api.v1.system["machine-providers"].$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );

      return response.providers;
    },
    async pathsExist(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].paths.exist.$post(
          {
            param: { id: input.hostId },
            json: { paths: input.paths },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async pickFolder(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["pick-folder"].$post(
          {
            param: { id: input.hostId },
            json: { clientHostId: input.clientHostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async providerCliStatus(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["provider-clis"].status.$get(
          {
            param: { id: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_resume(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].resume.$post({
          param: { id: input.hostId },
        }),
      );
    },
    async experimental_retryCleanup(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["retry-cleanup"].$post({
          param: { id: input.hostId },
        }),
      );
    },
    async retryUpdate(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["retry-update"].$post({
          param: { id: input.hostId },
        }),
      );
    },
    async experimental_reconcile(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].reconcile.$post({
          param: { id: input.hostId },
        }),
      );
    },
    async experimental_setAvailability(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].availability.$patch({
          param: { id: input.hostId },
          json: { availability: input.availability },
        }),
      );
    },
    async experimental_suspend(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].suspend.$post({
          param: { id: input.hostId },
        }),
      );
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].$patch({
          param: { id: input.hostId },
          json: { name: input.name },
        }),
      );
    },
  };
}
