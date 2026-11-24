import type { GitCheckoutRef, Host } from "@omnyo/domain";
import type {
  CreateThreadEnvironmentArgs,
  WorkspaceArgs,
} from "@omnyo/server-contract";
import type { ExperimentalComposerSelection } from "@omnyo/plugin-sdk";
import { providerArgsAsWorkspace } from "@/components/plugin/new-thread-environment-seed";

export type NewChatWorkspace =
  | { kind: "checkout" }
  | { kind: "new-worktree" }
  | { kind: "local-worktree"; path: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "provider"; providerId: string }
  | { kind: "personal" };

export type NewChatMachine =
  | { kind: "host"; hostId: string }
  | { kind: "hostless"; providerId: string }
  | { kind: "unresolved" };

export interface NewChatWhere {
  machine: NewChatMachine;
  workspace: NewChatWorkspace;
}

export type WherePick =
  | { kind: "host"; hostId: string }
  | { kind: "hostless"; providerId: string }
  | {
      kind: "workspace";
      workspace: Exclude<NewChatWorkspace, { kind: "personal" }>;
    };

export interface NewChatDockConfig {
  where: NewChatWhere;
  defaultThreadMachineId: string | null;
  rankedProjectIds: readonly string[];
  select(
    selection: ExperimentalComposerSelection,
  ): Promise<ExperimentalComposerSelection>;
}

export interface EnvironmentHost {
  environmentId: string;
  hostId?: string | null;
}

const UNRESOLVED: NewChatMachine = { kind: "unresolved" };

const DAY_MS = 86_400_000;

const HOUR_MS = 3_600_000;

function workspaceOf(workspace: WorkspaceArgs): NewChatWorkspace {
  switch (workspace.type) {
    case "personal":
      return { kind: "personal" };
    case "managed-worktree":
      return { kind: "new-worktree" };
    case "unmanaged":
      return workspace.path === null
        ? { kind: "checkout" }
        : { kind: "local-worktree", path: workspace.path };
  }
}

function defaultWorkspace(projectless: boolean): NewChatWorkspace {
  return projectless ? { kind: "personal" } : { kind: "checkout" };
}

export function describeWhere(
  environment: CreateThreadEnvironmentArgs | null,
  projectless: boolean,
  environmentHosts: readonly EnvironmentHost[],
): NewChatWhere {
  if (environment === null || environment.type === "project-default") {
    return { machine: UNRESOLVED, workspace: defaultWorkspace(projectless) };
  }

  if (environment.type === "reuse") {
    const hostId = environmentHosts.find(
      (candidate) => candidate.environmentId === environment.environmentId,
    )?.hostId;

    return {
      machine:
        hostId === undefined || hostId === null
          ? UNRESOLVED
          : { kind: "host", hostId },
      workspace: {
        kind: "environment",
        environmentId: environment.environmentId,
      },
    };
  }

  if (environment.type === "host") {
    return {
      machine:
        environment.hostId === undefined
          ? UNRESOLVED
          : { kind: "host", hostId: environment.hostId },
      workspace: workspaceOf(environment.workspace),
    };
  }

  const workspace = providerArgsAsWorkspace(environment);

  return {
    machine: providerMachine(environment, workspace !== null),
    workspace:
      workspace === null
        ? { kind: "provider", providerId: environment.environmentProviderId }
        : workspaceOf(workspace),
  };
}

function providerMachine(
  environment: Extract<CreateThreadEnvironmentArgs, { type: "provider" }>,
  coreWorkspace: boolean,
): NewChatMachine {
  if (environment.machine?.type === "existing") {
    return { kind: "host", hostId: environment.machine.hostId };
  }

  return environment.machine === undefined && coreWorkspace
    ? UNRESOLVED
    : { kind: "hostless", providerId: environment.environmentProviderId };
}

function hostEnvironment(
  hostId: string,
  workspace: Exclude<NewChatWorkspace, { kind: "environment" }>,
): CreateThreadEnvironmentArgs {
  switch (workspace.kind) {
    case "checkout":
      return {
        type: "host",
        hostId,
        workspace: { type: "unmanaged", path: null },
      };
    case "new-worktree":
      return {
        type: "host",
        hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      };
    case "local-worktree":
      return {
        type: "host",
        hostId,
        workspace: { type: "unmanaged", path: workspace.path },
      };
    case "personal":
      return { type: "host", hostId, workspace: { type: "personal" } };
    case "provider":
      return {
        type: "provider",
        environmentProviderId: workspace.providerId,
        machine: { type: "existing", hostId },
        inputs: null,
      };
  }
}

function portableWorkspace(
  workspace: NewChatWorkspace,
): Exclude<NewChatWorkspace, { kind: "environment" }> {
  switch (workspace.kind) {
    case "local-worktree":
    case "environment":
      return { kind: "checkout" };
    case "checkout":
    case "new-worktree":
    case "provider":
    case "personal":
      return workspace;
  }
}

export function wherePickSelection(
  where: NewChatWhere,
  pick: WherePick,
  defaultThreadMachineId: string | null,
): ExperimentalComposerSelection | null {
  if (pick.kind === "hostless") {
    return {
      environment: {
        type: "provider",
        environmentProviderId: pick.providerId,
        inputs: null,
      },
    };
  }

  if (pick.kind === "host") {
    return {
      environment: hostEnvironment(
        pick.hostId,
        portableWorkspace(where.workspace),
      ),
    };
  }

  if (pick.workspace.kind === "environment") {
    return {
      environment: {
        type: "reuse",
        environmentId: pick.workspace.environmentId,
      },
    };
  }

  const hostId =
    where.machine.kind === "host"
      ? where.machine.hostId
      : defaultThreadMachineId;

  return hostId === null
    ? null
    : { environment: hostEnvironment(hostId, pick.workspace) };
}

function offlineFor(lastSeenAt: number, now: number): string {
  const elapsed = Math.max(0, now - lastSeenAt);

  if (elapsed >= DAY_MS) {
    const days = Math.floor(elapsed / DAY_MS);

    return days === 1 ? "a day" : `${days} days`;
  }

  if (elapsed >= HOUR_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);

    return hours === 1 ? "an hour" : `${hours} hours`;
  }

  return "a few minutes";
}

function offlineOthersSentence(others: readonly Host[], now: number): string {
  const [only] = others;

  if (others.length === 1 && only !== undefined) {
    return only.lastSeenAt === null
      ? `The ${only.name} has it too but is offline.`
      : `The ${only.name} has it too but has been offline for ${offlineFor(only.lastSeenAt, now)}.`;
  }

  const names = others.map((host) => `the ${host.name}`);
  const last = names.pop();
  const list = `${names.join(", ")} and ${last}`;

  return `${list.charAt(0).toUpperCase()}${list.slice(1)} have it too but are offline.`;
}

export function describeMachineSwitch({
  projectName,
  defaultHost,
  resolvedHostId,
  hostsWithProject,
  now,
}: {
  projectName: string;
  defaultHost: Host | null;
  resolvedHostId: string | null;
  hostsWithProject: readonly Host[];
  now: number;
}): string | null {
  if (
    defaultHost === null ||
    resolvedHostId === null ||
    resolvedHostId === defaultHost.id ||
    hostsWithProject.some((host) => host.id === defaultHost.id)
  ) {
    return null;
  }

  const resolved = hostsWithProject.find((host) => host.id === resolvedHostId);

  if (resolved === undefined) return null;

  const switched = `${projectName} isn't on the ${defaultHost.name}, so it runs on the ${resolved.name}.`;

  const offlineOthers = hostsWithProject.filter(
    (host) => host.id !== resolved.id && host.status !== "connected",
  );

  return offlineOthers.length === 0
    ? switched
    : `${switched} ${offlineOthersSentence(offlineOthers, now)}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function describeCheckoutBranch(checkout: GitCheckoutRef): {
  label: string;
  title: string | null;
} {
  switch (checkout.kind) {
    case "branch":
      return { label: checkout.branchName, title: null };
    case "unborn":
      return {
        label: checkout.branchName ?? "No branch",
        title: "No commits yet",
      };
    case "detached":
      return {
        label: "Detached",
        title:
          checkout.headSha === null
            ? "Detached HEAD"
            : `Detached at ${shortSha(checkout.headSha)}`,
      };
    case "unknown":
      return { label: "Unknown branch", title: checkout.reason };
  }
}
