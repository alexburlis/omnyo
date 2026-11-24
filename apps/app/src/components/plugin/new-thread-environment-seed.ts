import { z } from "zod";
import {
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
  GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
} from "@omnyo/client-core";
import {
  gitBranchSelectionSchema,
  type EnvironmentMachineSelection,
  type JsonValue,
} from "@omnyo/domain";
import {
  unmanagedBranchSpecSchema,
  type CreateThreadEnvironmentArgs,
  type ProviderEnvironmentArgs,
  type WorkspaceArgs,
} from "@omnyo/server-contract";
import {
  encodeReuseValue,
  encodeProviderValue,
} from "@/components/pickers/environment-picker-value";

interface NewThreadEnvironmentSeed {
  selectionValue: string;
  providerMachine: EnvironmentMachineSelection | null;
  providerHostId: string | null;
  providerInputs: JsonValue | null;
  appliedInputs: JsonValue | undefined;
}

interface WorkspaceProvider {
  environmentProviderId: string;
  inputs: JsonValue | null;
}

function workspaceProvider(workspace: WorkspaceArgs): WorkspaceProvider {
  switch (workspace.type) {
    case "personal":
      return {
        environmentProviderId: PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
        inputs: null,
      };
    case "managed-worktree":
      return {
        environmentProviderId: GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
        inputs: { branch: workspace.baseBranch },
      };
    case "unmanaged":
      return {
        environmentProviderId: PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
        inputs: {
          ...(workspace.path === null ? {} : { path: workspace.path }),
          ...(workspace.branch === undefined
            ? {}
            : { branch: workspace.branch }),
        },
      };
  }
}

const DEFAULT_WORKSPACES: readonly WorkspaceArgs[] = [
  { type: "unmanaged", path: null },
  { type: "managed-worktree", baseBranch: { kind: "default" } },
];

export const CORE_WORKSPACE_DEFAULT_INPUTS: ReadonlyMap<string, JsonValue> =
  new Map(
    DEFAULT_WORKSPACES.map((workspace) => {
      const { environmentProviderId, inputs } = workspaceProvider(workspace);

      return [environmentProviderId, inputs ?? {}];
    }),
  );

function workspaceAsProviderSugar(
  hostId: string,
  workspace: WorkspaceArgs,
): ProviderEnvironmentArgs {
  return {
    type: "provider",
    machine: { type: "existing", hostId },
    ...workspaceProvider(workspace),
  };
}

const PROVIDER_INPUTS_AS_WORKSPACE: ReadonlyMap<
  string,
  z.ZodType<WorkspaceArgs>
> = new Map<string, z.ZodType<WorkspaceArgs>>([
  [
    PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
    z.null().transform((): WorkspaceArgs => ({ type: "personal" })),
  ],
  [
    GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
    z
      .object({ branch: gitBranchSelectionSchema })
      .strict()
      .transform(({ branch }): WorkspaceArgs => ({
        type: "managed-worktree",
        baseBranch: branch,
      })),
  ],
  [
    PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    z
      .object({
        path: z.string().min(1).optional(),
        branch: unmanagedBranchSpecSchema.optional(),
      })
      .strict()
      .transform(({ path, branch }): WorkspaceArgs => ({
        type: "unmanaged",
        path: path ?? null,
        ...(branch === undefined ? {} : { branch }),
      })),
  ],
]);

export function providerArgsAsWorkspace(
  args: ProviderEnvironmentArgs,
): WorkspaceArgs | null {
  const parsed = PROVIDER_INPUTS_AS_WORKSPACE.get(
    args.environmentProviderId,
  )?.safeParse(args.inputs);

  return parsed?.success === true ? parsed.data : null;
}

export function newThreadEnvironmentArgsToSeed(
  environment: CreateThreadEnvironmentArgs,
): NewThreadEnvironmentSeed | null {
  if (environment.type === "project-default") {
    return null;
  }

  if (environment.type === "provider") {
    return {
      selectionValue: encodeProviderValue(environment.environmentProviderId),
      providerMachine: environment.machine ?? null,
      providerHostId:
        environment.machine?.type === "existing"
          ? environment.machine.hostId
          : null,
      providerInputs: environment.inputs,
      appliedInputs: undefined,
    };
  }

  if (environment.type === "reuse") {
    return {
      selectionValue: encodeReuseValue(environment.environmentId),
      providerMachine: null,
      providerHostId: null,
      providerInputs: null,
      appliedInputs: undefined,
    };
  }

  if (environment.hostId === undefined) {
    return null;
  }

  const sugar = workspaceAsProviderSugar(
    environment.hostId,
    environment.workspace,
  );

  const seed = newThreadEnvironmentArgsToSeed(sugar);

  return seed === null
    ? null
    : { ...seed, appliedInputs: sugar.inputs ?? undefined };
}
