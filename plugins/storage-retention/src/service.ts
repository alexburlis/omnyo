import { readThreads } from "./sdk-data.js";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { policySchema, runSchema, type Policy, type Run } from "./contract.js";
import { selectCandidates } from "./policy.js";
import { hostStorageContract } from "./host-contract.js";

const DEFAULT_POLICY: Policy = {
  archiveAfterDays: null,
  deleteAfterDays: null,
  deleteStorageOnArchive: false,
  deleteDevDataOnCheckoutRemoval: false,
};

const BATCH_LIMIT = 50;

export function createService(api: PluginApi) {
  const worker = api.hosts.experimental_client({
    contract: hostStorageContract,
  });

  let disposed = false;
  let running = false;
  api.onDispose(() => {
    disposed = true;
  });

  function requireActive() {
    if (disposed) throw new Error("Storage & retention plugin is disabled.");
  }

  async function readPolicy() {
    const stored = await api.storage.kv.get("policy");

    return stored === null || stored === undefined
      ? DEFAULT_POLICY
      : policySchema.parse(stored);
  }

  async function state() {
    const [policy, lastRun] = await Promise.all([
      readPolicy(),
      api.storage.kv.get("lastRun"),
    ]);

    return {
      policy,
      lastRun: lastRun == null ? null : runSchema.parse(lastRun),
    };
  }

  async function retainsStorage(memberIds: readonly string[]) {
    const byHost = new Map<string, string[]>();

    for (const threadId of memberIds) {
      const location = await api.sdk.threads.storageLocation({ threadId });
      const names = byHost.get(location.hostId) ?? [];
      names.push(threadId);
      byHost.set(location.hostId, names);
    }

    for (const [hostId, names] of byHost) {
      const host = await api.sdk.hosts.get({ hostId });

      if (host.threadStorageRootPath === null)
        throw new Error(
          "Retention cannot inspect this machine's thread storage",
        );

      const inspected = await worker.call(
        "retainedEntries",
        { rootPath: host.threadStorageRootPath, names },
        { hostId },
      );

      if (inspected.retained.length > 0) return true;
    }

    return false;
  }

  async function candidates(policy: Policy) {
    const threads = await readThreads(api);
    const result = selectCandidates(threads, policy, Date.now());
    const deletions: typeof result.delete = [];

    for (const group of result.delete) {
      try {
        if (!(await retainsStorage(group.memberIds))) deletions.push(group);
      } catch (error) {
        api.log.warn(
          `Kept ${group.rootId}: its storage could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { archive: result.archive, delete: deletions };
  }

  async function preview(policy: Policy) {
    requireActive();
    const result = await candidates(policy);

    const count = (groups: typeof result.archive) =>
      new Set(groups.flatMap((group) => group.memberIds)).size;

    return {
      archiveCount: count(result.archive),
      deleteCount: count(result.delete),
    };
  }

  async function configure(policy: Policy) {
    requireActive();
    await api.storage.kv.set("policy", policySchema.parse(policy));
    api.realtime.publish("policy-changed", null);

    return state();
  }

  async function sweep() {
    if (running || disposed) return;
    running = true;

    try {
      const policy = await readPolicy();

      if (policy.archiveAfterDays === null && policy.deleteAfterDays === null)
        return;
      const selected = await candidates(policy);

      const run: Run = {
        ranAt: Date.now(),
        archivedCount: 0,
        deletedCount: 0,
        failedCount: 0,
      };

      for (const action of ["archive", "delete"] as const) {
        for (const candidate of selected[action].slice(0, BATCH_LIMIT)) {
          if (disposed) return;
          const current = await readPolicy();

          if (disposed) return;

          if (
            current.archiveAfterDays !== policy.archiveAfterDays ||
            current.deleteAfterDays !== policy.deleteAfterDays
          )
            break;

          try {
            const fresh = selectCandidates(
              await readThreads(api),
              current,
              Date.now(),
            )[action].find((entry) => entry.rootId === candidate.rootId);

            if (disposed) return;

            if (fresh === undefined) continue;

            if (action === "delete" && (await retainsStorage(fresh.memberIds)))
              continue;

            if (action === "archive") {
              const result = await api.sdk.threads.archive({
                threadId: candidate.rootId,
              });

              run.archivedCount += result.archivedThreadIds.length;
            } else {
              await api.sdk.threads.delete({
                threadId: candidate.rootId,
                childThreadsConfirmed: true,
              });
              run.deletedCount += fresh.memberIds.length;
            }
          } catch (error) {
            run.failedCount++;
            api.log.warn(
              `Could not ${action} ${candidate.rootId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      if (!disposed) {
        await api.storage.kv.set("lastRun", run);
        api.realtime.publish("changed", null);
      }
    } finally {
      running = false;
    }
  }

  return { state, preview, configure, sweep };
}

export type Service = ReturnType<typeof createService>;
