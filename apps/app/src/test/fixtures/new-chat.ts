import {
  findLocalPathProjectSourceForHost,
  type Host,
  type ProjectKind,
  type ProjectSource,
} from "@omnyo/domain";
import type { SystemEnvironmentProvider } from "@omnyo/server-contract";
import { makeHost } from "@omnyo/test-helpers/domain-fixtures";

export interface NewChatFixtureProject {
  id: string;
  name: string;
  kind: ProjectKind;
  sources: readonly ProjectSource[];
}

export const NEW_CHAT_NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

export const NEW_CHAT_HOST_IDS = {
  macPro: "host_macpro",
  rtx5080: "host_5080",
  macAir: "host_macair",
  rtx3090: "host_3090",
  vps: "host_vps",
} as const;

type NewChatHostKey = keyof typeof NEW_CHAT_HOST_IDS;

const NEW_CHAT_HOST_NAMES: Record<NewChatHostKey, string> = {
  macPro: "Mac Pro",
  rtx5080: "5080",
  macAir: "Mac Air",
  rtx3090: "3090",
  vps: "omnyo-vps",
};

const NEW_CHAT_HOST_ORDER: readonly NewChatHostKey[] = [
  "rtx5080",
  "macPro",
  "macAir",
  "rtx3090",
  "vps",
];

export function makeNewChatHosts(
  overrides: Partial<Record<NewChatHostKey, Partial<Host>>> = {},
): Host[] {
  return NEW_CHAT_HOST_ORDER.map((key) =>
    makeHost({
      id: NEW_CHAT_HOST_IDS[key],
      name: NEW_CHAT_HOST_NAMES[key],
      lastSeenAt: NEW_CHAT_NOW,
      ...overrides[key],
    }),
  );
}

function newChatSource(
  projectId: string,
  hostKey: NewChatHostKey,
  isDefault: boolean,
): ProjectSource {
  return {
    id: `src_${projectId}_${hostKey}`,
    projectId,
    type: "local_path",
    hostId: NEW_CHAT_HOST_IDS[hostKey],
    path: `/Users/developer/projects/${projectId}`,
    isDefault,
    createdAt: 0,
    updatedAt: 0,
  };
}

function newChatProject(
  name: string,
  hosts: readonly NewChatHostKey[] = ["macPro"],
  defaultHost: NewChatHostKey | null = hosts[0] ?? null,
): NewChatFixtureProject {
  const id = `proj_${name.replace(/[^a-z0-9]/giu, "").toLowerCase()}`;

  return {
    id,
    name,
    kind: "standard",
    sources: hosts.map((hostKey) =>
      newChatSource(id, hostKey, hostKey === defaultHost),
    ),
  };
}

export const NEW_CHAT_PROJECTS: readonly NewChatFixtureProject[] = [
  newChatProject("gameslike"),
  newChatProject("omnyo-private"),
  newChatProject("alexos-prod"),
  newChatProject("paraspeech"),
  newChatProject("glassyui.com"),
  newChatProject("hardware"),
  newChatProject("sledge"),
  newChatProject("Stratoclash", ["rtx3090", "rtx5080"], "rtx5080"),
  newChatProject("personal-agent"),
  newChatProject("live-cargo", ["macPro", "macAir"]),
  newChatProject("mailwerk"),
  newChatProject("physicscrafter", ["macPro", "rtx5080", "rtx3090"]),
  newChatProject("spacecrafter"),
  newChatProject("codewert-landing"),
  newChatProject("prim-2d"),
  newChatProject("prim", ["rtx3090"], null),
];

export function newChatProjectNamed(name: string): NewChatFixtureProject {
  const project = NEW_CHAT_PROJECTS.find(
    (candidate) => candidate.name === name,
  );

  if (project === undefined) throw new Error(`Unknown fixture ${name}`);

  return project;
}

function environmentProvider(
  overrides: Partial<SystemEnvironmentProvider> &
    Pick<SystemEnvironmentProvider, "id" | "displayName">,
): SystemEnvironmentProvider {
  return {
    machineProviderId: null,
    description: null,
    icon: "Laptop",
    logoUrl: null,
    pluginId: `environment-${overrides.id}`,
    acceptsEmptyInputs: true,
    machineAvailability: {},
    availability: null,
    requires: {
      projectCheckout: true,
      gitCheckout: false,
      gitRemote: false,
      projectless: false,
    },
    inputs: null,
    ...overrides,
  };
}

const BRANCH_INPUTS_SCHEMA = { type: "object" };

export const NEW_CHAT_CHECKOUT_PROVIDER = environmentProvider({
  id: "project-checkout",
  displayName: "Project checkout",
  pluginId: "environment-project-checkout",
  inputs: BRANCH_INPUTS_SCHEMA,
});

export const NEW_CHAT_WORKTREE_PROVIDER = environmentProvider({
  id: "git-worktree",
  displayName: "Worktree",
  icon: "FolderGit",
  pluginId: "environment-git-worktree",
  inputs: BRANCH_INPUTS_SCHEMA,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
});

export const NEW_CHAT_SENTRY_WORKTREE_PROVIDER = environmentProvider({
  id: "sentry-worktree",
  displayName: "Sentry worktree",
  pluginId: "sentry",
  inputs: BRANCH_INPUTS_SCHEMA,
  acceptsEmptyInputs: false,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
});

export const NEW_CHAT_SENTRY_PROJECT_PROVIDER = environmentProvider({
  id: "sentry-project",
  displayName: "Sentry project",
  pluginId: "sentry",
  inputs: BRANCH_INPUTS_SCHEMA,
  acceptsEmptyInputs: false,
});

export const NEW_CHAT_PERSONAL_PROVIDER = environmentProvider({
  id: "personal-workspace",
  displayName: "Personal workspace",
  icon: "Folder",
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: true,
  },
});

export const NEW_CHAT_MODAL_PROVIDER = environmentProvider({
  id: "modal-sandbox",
  displayName: "Modal sandbox",
  icon: "Cloud",
  pluginId: "environment-modal-sandbox",
  machineProviderId: "modal-sandbox",
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: true,
    projectless: false,
  },
});

export const NEW_CHAT_ENVIRONMENT_PROVIDERS: readonly SystemEnvironmentProvider[] =
  [
    NEW_CHAT_CHECKOUT_PROVIDER,
    NEW_CHAT_WORKTREE_PROVIDER,
    NEW_CHAT_SENTRY_WORKTREE_PROVIDER,
    NEW_CHAT_SENTRY_PROJECT_PROVIDER,
    NEW_CHAT_PERSONAL_PROVIDER,
  ];

export const NEW_CHAT_INPUTS_CONTROL_PROVIDER_IDS: ReadonlySet<string> =
  new Set([NEW_CHAT_CHECKOUT_PROVIDER.id, NEW_CHAT_WORKTREE_PROVIDER.id]);

export function newChatProvidersByHostId({
  hosts,
  sources,
  providers = NEW_CHAT_ENVIRONMENT_PROVIDERS,
  projectless = false,
}: {
  hosts: readonly Host[];
  sources: readonly ProjectSource[];
  providers?: readonly SystemEnvironmentProvider[];
  projectless?: boolean;
}): ReadonlyMap<string, readonly SystemEnvironmentProvider[]> {
  return new Map(
    hosts.map((host) => [
      host.id,
      providers.filter(
        (provider) =>
          provider.machineProviderId === null &&
          provider.requires.projectless === projectless &&
          (!(
            provider.requires.projectCheckout || provider.requires.gitCheckout
          ) ||
            findLocalPathProjectSourceForHost(sources, host.id) !== undefined),
      ),
    ]),
  );
}
