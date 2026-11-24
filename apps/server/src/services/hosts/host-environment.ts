import { getAppSettings, getHost } from "@omnyo/db";
import { resolveUserMachineEnvironment } from "../machines/environment-settings.js";
import type { AppDeps } from "../../types.js";
import type { HostDaemonContributedEnvEntry } from "@omnyo/host-daemon-contract";
import {
  githubGitConfiguration,
  resolveGitCredentials,
} from "../machines/git-credentials.js";
import { readPrimaryHostIdFromDataDir } from "./primary-host.js";

type HostEnvironmentContext = { hostId: string; projectId: string | null };

export async function resolveHostEnvironment(
  deps: Pick<AppDeps, "db" | "vault"> & {
    config: Pick<AppDeps["config"], "dataDir">;
  },
  context: HostEnvironmentContext,
): Promise<HostDaemonContributedEnvEntry[]> {
  const host = getHost(deps.db, context.hostId);

  if (!host || host.destroyedAt !== null) return [];

  const primaryHostId = readPrimaryHostIdFromDataDir({
    dataDir: deps.config.dataDir,
  });

  const [builtIn, global, project] = await Promise.all([
    primaryHostId !== context.hostId &&
    getAppSettings(deps.db).machineGitCredentialsEnabled
      ? resolveGitCredentials()
      : Promise.resolve<HostDaemonContributedEnvEntry[]>([]),
    resolveUserMachineEnvironment(deps.db, deps.vault),
    context.projectId === null
      ? []
      : resolveUserMachineEnvironment(deps.db, deps.vault, context.projectId),
  ]);

  const user = mergeHostAndProviderEnvironment(global, project);

  if (!builtIn.length && user.some((entry) => entry.name === "GH_TOKEN"))
    builtIn.push(...githubGitConfiguration());

  return mergeHostAndProviderEnvironment(builtIn, user);
}

export function mergeHostAndProviderEnvironment(
  host: readonly HostDaemonContributedEnvEntry[],
  provider: readonly HostDaemonContributedEnvEntry[],
): HostDaemonContributedEnvEntry[] {
  const providerNames = new Set(provider.map((entry) => entry.name));

  return [
    ...host.filter((entry) => !providerNames.has(entry.name)),
    ...provider,
  ];
}
