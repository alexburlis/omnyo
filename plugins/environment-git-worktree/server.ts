import { randomUUID } from "node:crypto";
import {
  defineRpcContract,
  type PluginApi,
  type JsonValue,
} from "@omnyo/plugin-sdk";
import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderCreateResult,
  PluginEnvironmentProviderProgress,
} from "@omnyo/plugin-sdk/environment-provider";
import { reportHostProgress } from "omnyo-environment-provider-host/progress";
import { z } from "zod";
import {
  discoveredWorktreeSchema,
  storageSharingResultSchema,
  storageWorktreeSchema,
  worktreeBaseBranchSchema,
  worktreeHostContract,
  worktreeHostSignals,
  type WorktreeBaseBranch,
  type StorageSharingResult,
} from "./contract.js";
import { GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const CREATE_TIMEOUT_MS = 15 * 60 * 1000;

const REMOVE_TIMEOUT_MS = 15 * 60 * 1000;

export const worktreeInputsSchema = z
  .union([
    z
      .object({
        kind: z.literal("existing"),
        path: z.string().min(1),
      })
      .strict(),
    z
      .object({
        branch: worktreeBaseBranchSchema.default({ kind: "default" }),
      })
      .strict(),
  ])
  .default({ branch: { kind: "default" } });

export type WorktreeInputs = z.infer<typeof worktreeInputsSchema>;

type WorktreeOperation = Pick<
  PluginEnvironmentProviderCreateContext<{ gitCheckout: true }>,
  | "attempt"
  | "experimental_claimPath"
  | "host"
  | "pathKey"
  | "projectCheckout"
  | "report"
  | "signal"
>;

export const worktreeRpcContract = defineRpcContract({
  reclaimWorktreeStorage: {
    input: z
      .object({
        hostId: z.string().min(1),
        worktrees: z.array(storageWorktreeSchema).max(256),
      })
      .strict(),
    output: storageSharingResultSchema,
  },
  cancelWorktreeStorage: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
  previewMissingRegistrationCleanup: {
    input: z
      .object({
        environmentId: z.string().min(1),
        sourcePath: z.string().min(1),
        ref: z.string().min(1),
      })
      .strict(),
    output: z.object({
      token: z.string(),
      path: z.string(),
      ref: z.string(),
      head: z.string(),
      fileCount: z.number(),
      bytes: z.number(),
    }),
  },
  confirmMissingRegistrationCleanup: {
    input: z
      .object({ token: z.string(), hookStopped: z.literal(true) })
      .strict(),
    output: z.object({
      state: z.literal("requested"),
      environmentId: z.string(),
      path: z.string(),
    }),
  },
  defaultBaseBranch: {
    input: z
      .object({
        projectId: z.string().min(1),
        hostId: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.object({ branch: z.string().min(1).nullable() }).strict(),
  },
  listExistingWorktrees: {
    input: z
      .object({
        projectId: z.string().min(1),
        hostId: z.string().min(1),
      })
      .strict(),
    output: z.object({ worktrees: z.array(discoveredWorktreeSchema) }).strict(),
  },
});

const ADOPTED_RESOURCE = { adopted: true } as const;

function isAdoptedResource(resource: JsonValue | null): boolean {
  return (
    typeof resource === "object" &&
    resource !== null &&
    !Array.isArray(resource) &&
    resource.adopted === true
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function worktreePlugin(api: PluginApi): Promise<void> {
  const settings = api.settings.define({
    shareWorktreeStorage: {
      type: "boolean",
      label: "Share disk space between worktrees",
      description:
        "On APFS, identical files share disk space until you edit them.",
      default: true,
    },
  });

  const host = api.hosts.experimental_client({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
  });

  const reports = new Map<string, PluginEnvironmentProviderProgress>();

  const sharingOperations = new Map<
    string,
    { hostId: string; kind: "create" | "reclaim" }
  >();

  async function cancelSharing(operationId: string, hostId: string) {
    return host.call("cancelStorageSharing", { operationId }, { hostId });
  }

  settings.onChange((next) => {
    if (next.shareWorktreeStorage) return;
    void Promise.all(
      [...sharingOperations].map(([operationId, { hostId }]) =>
        cancelSharing(operationId, hostId),
      ),
    ).catch((error: unknown) => {
      api.log.warn(`Could not stop storage sharing: ${errorMessage(error)}`);
    });
  });

  type Recovery = {
    environmentId: string;
    input: z.input<
      typeof worktreeHostContract.inspectMissingRegistration.input
    >;
    proof: z.output<
      typeof worktreeHostContract.inspectMissingRegistration.output
    >;
    hostId: string;
    expires: number;
  };

  const previews = new Map<string, Recovery>();
  const approved = new Map<string, Recovery>();

  async function requireNoChats(environmentId: string) {
    const pages = await Promise.all(
      [false, true].map((archived) =>
        api.sdk.threads.list({
          environmentId,
          archived,
          includeHidden: true,
          limit: 1,
        }),
      ),
    );

    if (pages.some((page) => page.length > 0))
      throw new Error("The worktree still belongs to a chat.");
  }

  async function recoverableEnvironment(
    environmentId: string,
    sourcePath: string,
  ) {
    const environment = await api.sdk.environments.get({ environmentId });

    if (
      !environment.managed ||
      environment.environmentProviderId !==
        GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID ||
      !environment.path ||
      !environment.environmentProviderInstanceKey ||
      environment.hostLifecycle !== "active" ||
      environment.lifecycle.phase !== "teardown" ||
      environment.lifecycle.teardown?.status !== "failed"
    ) {
      throw new Error("Select a managed worktree with failed teardown.");
    }

    const [project] = await Promise.all([
      api.sdk.projects.get({ projectId: environment.projectId }),
      requireNoChats(environmentId),
    ]);

    if (
      !project.sources.some(
        (source) =>
          source.type === "local_path" &&
          source.hostId === environment.hostId &&
          source.path === sourcePath,
      )
    ) {
      throw new Error(
        "Use a configured project repository on the worktree's machine.",
      );
    }

    return {
      hostId: environment.hostId,
      path: environment.path,
      pathKey: environment.environmentProviderInstanceKey,
    };
  }

  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);

    if (report !== undefined) reportHostProgress(report, event.payload);
  });

  async function adoptExistingWorktree(
    context: WorktreeOperation,
    path: string,
  ): Promise<PluginEnvironmentProviderCreateResult> {
    const resolved = await host.call(
      "resolveExistingWorktree",
      { sourcePath: context.projectCheckout.path, path },
      {
        hostId: context.host.id,
        signal: context.signal,
        timeoutMs: CREATE_TIMEOUT_MS,
      },
    );

    if (resolved.status === "failed") {
      return { status: "failed", message: resolved.message };
    }

    if (!(await context.experimental_claimPath(resolved.path))) {
      return {
        status: "failed",
        message: `${resolved.path} is already in use by another environment.`,
      };
    }

    return {
      status: "created",
      path: resolved.path,
      ownsPath: false,
      resource: ADOPTED_RESOURCE,
    };
  }

  async function createManagedWorktree(
    context: WorktreeOperation,
    branch: {
      branchName: string;
      baseBranch: WorktreeBaseBranch;
      branchMode: "reset" | "reuse-existing";
    },
  ): Promise<PluginEnvironmentProviderCreateResult> {
    const operationId = `create#${context.pathKey}#${context.attempt}`;
    reports.set(operationId, context.report);

    try {
      const { shareWorktreeStorage } = await settings.get();

      if (shareWorktreeStorage)
        sharingOperations.set(operationId, {
          hostId: context.host.id,
          kind: "create",
        });

      const result = await host.call(
        "create",
        {
          operationId,
          sourcePath: context.projectCheckout.path,
          pathKey: context.pathKey,
          shareWorktreeStorage,
          ...branch,
        },
        {
          hostId: context.host.id,
          signal: context.signal,
          timeoutMs: CREATE_TIMEOUT_MS,
        },
      );

      if (result.status === "failed") {
        return { status: "failed", message: result.message };
      }

      return {
        status: "created",
        path: result.path,
        ownsPath: true,
        ...(result.baseBranch === null
          ? {}
          : { mergeBaseBranch: result.baseBranch }),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;

      return { status: "failed", message: errorMessage(error) };
    } finally {
      reports.delete(operationId);
      sharingOperations.delete(operationId);
    }
  }

  api.experimental_environments.register({
    id: GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
    displayName: "Worktree",
    description: "Create an isolated Git worktree for your changes.",
    icon: "FolderGit",
    requires: { gitCheckout: true },
    inputs: worktreeInputsSchema,
    policy: { pathKeys: "per-attempt" },
    experimental_existingPath: (inputs) =>
      "kind" in inputs ? inputs.path : null,
    async create(context) {
      if ("kind" in context.inputs) {
        return adoptExistingWorktree(context, context.inputs.path);
      }

      return createManagedWorktree(context, {
        branchName: context.suggestedBranchName,
        baseBranch: context.inputs.branch,
        branchMode: "reset",
      });
    },
    async restore(context) {
      if ("kind" in context.inputs) {
        return adoptExistingWorktree(context, context.inputs.path);
      }

      const branchName = context.previous.environment.branchName;

      if (branchName === null) {
        return {
          status: "failed",
          message:
            "The removed worktree had no branch checked out, so there is no branch to restore it on.",
        };
      }

      return createManagedWorktree(context, {
        branchName,
        baseBranch: context.inputs.branch,
        branchMode: "reuse-existing",
      });
    },
    async remove(context) {
      if (isAdoptedResource(context.resource)) {
        return { status: "removed" };
      }

      if (context.hostId === null) {
        return { status: "failed", message: "The worktree machine is unknown" };
      }

      const operationId = `remove#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);

      try {
        const recovery = approved.get(context.pathKey);

        if (recovery) {
          approved.delete(context.pathKey);

          if (
            Date.now() >= recovery.expires ||
            context.environment?.id !== recovery.environmentId ||
            context.hostId !== recovery.hostId ||
            context.path !== recovery.input.path
          ) {
            throw new Error(
              "The approved worktree changed or the review expired.",
            );
          }

          await requireNoChats(recovery.environmentId);
        }

        const result = await host.call(
          "remove",
          {
            operationId,
            pathKey: context.pathKey,
            path: context.path,
            ...(recovery
              ? {
                  recovery: {
                    sourcePath: recovery.input.sourcePath,
                    ref: recovery.input.ref,
                    proof: recovery.proof,
                  },
                }
              : {}),
          },
          {
            hostId: context.hostId,
            signal: context.signal,
            timeoutMs: REMOVE_TIMEOUT_MS,
          },
        );

        return result;
      } catch (error) {
        if (context.signal.aborted) throw error;

        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },
  });

  api.rpc.register(worktreeRpcContract, {
    async reclaimWorktreeStorage({ hostId, worktrees }, context) {
      if (
        context.experimental_caller.kind !== "plugin" ||
        context.experimental_caller.pluginId !== "omnyo--storage-retention"
      )
        throw new Error("Only Storage Retention can reclaim worktree storage.");

      const empty: StorageSharingResult = {
        status: "completed",
        sharedFiles: 0,
        privateBytesReleased: 0,
        skippedFiles: 0,
        skippedWorktrees: [],
      };

      if (!(await settings.get()).shareWorktreeStorage)
        return {
          ...empty,
          status: "disabled" as const,
          skippedWorktrees: worktrees.map(({ path }) => ({
            path,
            reason: "Worktree storage sharing is switched off.",
          })),
        };

      if (
        [...sharingOperations.values()].some(
          (operation) =>
            operation.hostId === hostId && operation.kind === "reclaim",
        )
      )
        throw new Error("Storage sharing is already running on this machine.");

      const operationId = `reclaim#${randomUUID()}`;
      sharingOperations.set(operationId, { hostId, kind: "reclaim" });

      try {
        const [projects, environments, threadPages] = await Promise.all([
          api.sdk.projects.list({ includePersonal: true }),
          (async () => {
            const result = [];

            for (let offset = 0; ; offset += 100) {
              const page = await api.sdk.environments.list({
                hostId,
                offset,
                limit: 100,
              });

              result.push(...page);

              if (page.length < 100) return result;
            }
          })(),
          Promise.all(
            [false, true].map(async (archived) => {
              const result = [];

              for (let offset = 0; ; offset += 200) {
                const page = await api.sdk.threads.list({
                  archived,
                  includeHidden: true,
                  offset,
                  limit: 200,
                });

                result.push(...page);

                if (page.length < 200) return result;
              }
            }),
          ),
        ]);

        const sources = new Set(
          projects.flatMap((project) =>
            project.sources
              .filter(
                (source) =>
                  source.type === "local_path" && source.hostId === hostId,
              )
              .map((source) => source.path),
          ),
        );

        const protectedPaths = new Set([
          ...environments
            .filter(
              (environment) =>
                environment.hostLifecycle !== "removed" &&
                environment.status !== "destroyed",
            )
            .map((environment) => environment.path),
          ...threadPages
            .flat()
            .filter(
              (thread) =>
                thread.environmentHostId === hostId &&
                ["pending", "starting", "active", "stopping"].includes(
                  thread.status,
                ),
            )
            .map((thread) => thread.environmentPath),
        ]);

        const seen = new Set<string>();

        const eligible = worktrees.filter((worktree) => {
          const reason = !sources.has(worktree.sourcePath)
            ? "The source is not a configured repository on this machine."
            : sources.has(worktree.path)
              ? "A configured project checkout cannot be reclaimed."
              : protectedPaths.has(worktree.path)
                ? "The worktree belongs to an active environment or thread."
                : seen.has(worktree.path)
                  ? "The worktree was selected more than once."
                  : null;

          seen.add(worktree.path);

          if (!reason) return true;
          empty.skippedWorktrees.push({ path: worktree.path, reason });

          return false;
        });

        if (!(await settings.get()).shareWorktreeStorage)
          return { ...empty, status: "disabled" as const };

        if (eligible.length === 0) return empty;

        const cancel = () => {
          void cancelSharing(operationId, hostId).catch((error: unknown) => {
            api.log.warn(
              `Could not cancel storage sharing: ${errorMessage(error)}`,
            );
          });
        };

        context.experimental_signal.addEventListener("abort", cancel, {
          once: true,
        });

        if (context.experimental_signal.aborted) cancel();

        try {
          const result = await host.call(
            "reclaimWorktreeStorage",
            {
              operationId,
              worktrees: eligible,
              protectedPaths: [...protectedPaths].filter(
                (path): path is string => path !== null,
              ),
            },
            { hostId, timeoutMs: CREATE_TIMEOUT_MS },
          );

          return {
            ...result,
            skippedWorktrees: [
              ...empty.skippedWorktrees,
              ...result.skippedWorktrees,
            ],
          };
        } finally {
          context.experimental_signal.removeEventListener("abort", cancel);
        }
      } finally {
        sharingOperations.delete(operationId);
      }
    },
    async cancelWorktreeStorage({ hostId }, context) {
      if (
        context.experimental_caller.kind !== "plugin" ||
        context.experimental_caller.pluginId !== "omnyo--storage-retention"
      )
        throw new Error(
          "Only Storage Retention can cancel worktree storage sharing.",
        );

      const operations = [...sharingOperations].filter(
        ([, operation]) =>
          operation.hostId === hostId && operation.kind === "reclaim",
      );

      await Promise.all(
        operations.map(([operationId]) => cancelSharing(operationId, hostId)),
      );

      return { cancelled: operations.length > 0 };
    },
    async previewMissingRegistrationCleanup(
      { environmentId, sourcePath, ref },
      context,
    ) {
      const caller = context.experimental_caller;

      if (
        caller.kind !== "plugin" ||
        caller.pluginId !== "omnyo--storage-retention"
      )
        throw new Error(
          "Only Storage Retention can review broken worktree folders.",
        );

      const environment = await recoverableEnvironment(
        environmentId,
        sourcePath,
      );

      const { hostId, path, pathKey } = environment;
      const input = { sourcePath, path, pathKey, ref };

      const proof = await host.call("inspectMissingRegistration", input, {
        hostId,
        signal: context.experimental_signal,
        timeoutMs: 120_000,
      });

      for (const [token, preview] of previews)
        if (Date.now() >= preview.expires) previews.delete(token);

      if (previews.size >= 64)
        throw new Error(
          "Too many outstanding worktree reviews. Let an earlier review expire.",
        );
      const token = randomUUID();
      previews.set(token, {
        environmentId,
        hostId,
        input,
        proof,
        expires: Date.now() + 5 * 60_000,
      });

      return {
        token,
        path,
        ref,
        head: proof.head,
        fileCount: proof.fileCount,
        bytes: proof.bytes,
      };
    },
    async confirmMissingRegistrationCleanup({ token }, context) {
      const caller = context.experimental_caller;

      if (
        caller.kind !== "plugin" ||
        caller.pluginId !== "omnyo--storage-retention"
      )
        throw new Error(
          "Only Storage Retention can confirm broken worktree cleanup.",
        );
      const recovery = previews.get(token);
      previews.delete(token);

      if (!recovery || Date.now() >= recovery.expires)
        throw new Error("The worktree review expired. Preview it again.");
      const { environmentId, input } = recovery;

      const environment = await recoverableEnvironment(
        environmentId,
        input.sourcePath,
      );

      if (
        environment.hostId !== recovery.hostId ||
        environment.path !== input.path ||
        environment.pathKey !== input.pathKey
      )
        throw new Error("The worktree changed. Preview it again.");
      const pending = approved.get(input.pathKey);

      if (pending && Date.now() < pending.expires)
        throw new Error("Cleanup for this worktree was already requested.");
      approved.set(input.pathKey, recovery);

      try {
        await api.sdk.environments.experimental_cleanup({
          environmentId,
          hookStopped: true,
        });
      } catch (error) {
        if (approved.get(input.pathKey) === recovery)
          approved.delete(input.pathKey);
        throw error;
      }

      return { state: "requested", environmentId, path: input.path } as const;
    },
    async defaultBaseBranch({ projectId, hostId }) {
      const project = await api.sdk.projects.get({ projectId });

      const sources = project.sources.filter(
        (source) => source.type === "local_path",
      );

      const source =
        hostId === null
          ? (sources.find((source) => source.isDefault) ?? sources[0])
          : sources.find((source) => source.hostId === hostId);

      if (source === undefined) return { branch: null };

      return host.call(
        "defaultBaseBranch",
        { sourcePath: source.path },
        { hostId: source.hostId },
      );
    },
    async listExistingWorktrees({ projectId, hostId }) {
      const project = await api.sdk.projects.get({ projectId });

      const source = project.sources.find(
        (candidate) =>
          candidate.hostId === hostId && candidate.type === "local_path",
      );

      if (source === undefined) return { worktrees: [] };

      return host.call(
        "listWorktrees",
        { sourcePath: source.path },
        { hostId },
      );
    },
  });
}
