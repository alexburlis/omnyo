import {
  listDefaultLocalProjectSourcesOnHost,
  setProjectGitRemoteUrl,
} from "@omnyo/db";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { isServerMoveFrozen } from "../server-move/freeze-state.js";

const INSPECT_TIMEOUT_MS = 10_000;

export function installProjectRemoteSync(deps: LoggedWorkSessionDeps): {
  stop(): void;
} {
  const pendingHosts = new Set<string>();
  const runningHosts = new Set<string>();
  let stopped = false;

  async function syncHost(hostId: string): Promise<void> {
    for (const source of listDefaultLocalProjectSourcesOnHost(
      deps.db,
      hostId,
    )) {
      if (stopped || isServerMoveFrozen(deps.db)) return;

      try {
        const inspection = await callHostRetryableOnlineRpc(deps, {
          hostId,
          timeoutMs: INSPECT_TIMEOUT_MS,
          command: { type: "project.inspect", path: source.path },
        });

        if (
          !stopped &&
          inspection.gitRemoteUrl !== null &&
          inspection.gitRemoteUrl !== source.gitRemoteUrl
        ) {
          setProjectGitRemoteUrl(
            deps.db,
            deps.hub,
            source.projectId,
            inspection.gitRemoteUrl,
          );
        }
      } catch (error) {
        deps.logger.warn(
          { err: error, hostId, projectId: source.projectId },
          "Unable to refresh the project's Git remote",
        );
      }
    }
  }

  async function run(hostId: string): Promise<void> {
    runningHosts.add(hostId);

    try {
      while (!stopped && pendingHosts.delete(hostId)) await syncHost(hostId);
    } finally {
      runningHosts.delete(hostId);
    }
  }

  function request(hostId: string): void {
    if (stopped) return;
    pendingHosts.add(hostId);

    if (!runningHosts.has(hostId)) void run(hostId);
  }

  const unsubscribe = deps.hub.onChangedMessage((message) => {
    if (
      message.entity === "host" &&
      message.id &&
      message.changes.includes("host-connected")
    ) {
      request(message.id);
    }
  });

  for (const hostId of deps.hub.listConnectedHostIds()) request(hostId);

  return {
    stop() {
      stopped = true;
      unsubscribe();
      pendingHosts.clear();
    },
  };
}
