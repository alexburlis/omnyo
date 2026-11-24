import { createStorage } from "./storage.js";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { storageRpc } from "./contract.js";
import { createService } from "./service.js";
import { registerCli } from "./cli.js";
import { managedRpc } from "./managed-contract.js";
import { createManagedService } from "./managed-service.js";
import { registerManagedAgent } from "./managed-agent.js";
import { housekeepingRpc } from "./housekeeping-contract.js";
import { createHousekeepingService } from "./housekeeping-service.js";

import { registerWorktrees, type WorktreeAccess } from "./worktrees/server.js";

const ARCHIVE_CLEANUP_RAN_AT_KEY = "archiveStorageCleanupRanAt";

const ARCHIVE_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

export default function plugin(api: PluginApi) {
  const service = createService(api);
  const managed = createManagedService(api);
  registerManagedAgent(api, managed);

  const housekeeping = createHousekeepingService(api, {
    reconcileManaged: () => managed.reconcile(),
  });

  api.rpc.register(housekeepingRpc, {
    housekeepingStatus: () => housekeeping.status(),
    housekeepingRun: (input) => housekeeping.run(input),
    housekeepingPreview: (input) => housekeeping.preview(input),
    housekeepingAdapterPreview: (input) => housekeeping.adapterPreview(input),
    housekeepingAdapterAdopt: (input) => housekeeping.adapterAdopt(input),
    housekeepingAdapterRemove: (input) => housekeeping.adapterRemove(input),
  });
  api.background.schedule("housekeeping", "* * * * *", () =>
    housekeeping.reconcile(),
  );
  api.background.service("housekeeping-recovery", {
    async start(signal) {
      if (signal.aborted) return;
      const recover = () => housekeeping.reconcile();

      const unsubscribeHost = api.sdk.subscribe({
        event: "host:changed",
        callback: async (event) => {
          if (event.changes.includes("host-connected")) await recover();
        },
      });

      const unsubscribeConnection = api.sdk.subscribe({
        event: "realtime:connection",
        callback: async (event) => {
          if (event.state === "connected" && event.reconnected) await recover();
        },
      });

      try {
        await recover();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        unsubscribeHost();
        unsubscribeConnection();
      }
    },
  });
  api.rpc.register(managedRpc, {
    managedState: () => managed.state(),
    managedRequest: (input, context) =>
      managed.request(input, context.experimental_signal),
  });

  for (const event of [
    "thread.archived",
    "thread.deleted",
    "thread.unarchived",
  ] as const)
    api.events.on(event, async ({ thread }) => {
      await managed.lifecycle(event, thread);
    });
  api.background.schedule("managed-scratch-cleanup", "0 * * * *", async () => {
    await managed.reconcile();
  });
  api.background.service("managed-scratch-recovery", {
    async start(signal) {
      if (signal.aborted) return;
      const recover = () => managed.reconcile(signal);

      const unsubscribeHost = api.sdk.subscribe({
        event: "host:changed",
        callback: async (event) => {
          if (event.changes.includes("host-connected")) await recover();
        },
      });

      const unsubscribeConnection = api.sdk.subscribe({
        event: "realtime:connection",
        callback: async (event) => {
          if (event.state === "connected" && event.reconnected) await recover();
        },
      });

      try {
        await recover();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        unsubscribeHost();
        unsubscribeConnection();
      }
    },
  });

  const devCleanupEnabled = async () =>
    (await service.state()).policy.deleteDevDataOnCheckoutRemoval;

  const worktreeAccess: WorktreeAccess = {
    scan: (hostId) => worktrees.scan(hostId),
    removeFolders: (hostId, items) => worktrees.removeFolders(hostId, items),
  };

  const storage = createStorage(api, devCleanupEnabled, worktreeAccess);

  const worktrees = registerWorktrees(api, (hostId, paths) =>
    storage.forgetExternalWorktrees(hostId, paths),
  );

  api.events.on("experimental_environment.removed", ({ removal }) =>
    removal.hostId === null
      ? undefined
      : storage.cleanDevelopmentStorage(removal.hostId),
  );
  api.background.schedule(
    "development-storage-cleanup",
    "0 * * * *",
    storage.reconcileDevelopmentStorage,
  );
  api.background.service("development-storage-recovery", {
    async start(signal) {
      if (signal.aborted) return;

      const unsubscribe = api.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected"))
            void (event.id === undefined
              ? storage.reconcileDevelopmentStorage()
              : storage.reconcileHostDevelopmentStorage(event.id));

          if (
            event.changes.includes("host-connected") ||
            event.changes.includes("host-disconnected")
          )
            api.realtime.publish("changed", null);
        },
      });

      const unsubscribeConnection = api.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected)
            void storage.reconcileDevelopmentStorage();
        },
      });

      try {
        await storage.reconcileDevelopmentStorage();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        unsubscribe();
        unsubscribeConnection();
      }
    },
  });

  const cleanupEnabled = async () =>
    (await service.state()).policy.deleteStorageOnArchive;

  api.events.on("thread.archived", async ({ thread }) => {
    if (
      thread.archivedAt === null ||
      thread.pinnedAt !== null ||
      thread.shelvedAt !== null ||
      !(await cleanupEnabled())
    )
      return;
    storage.queueArchivedStorage(thread.id, thread.archivedAt);
  });

  for (const event of ["thread.unarchived", "thread.deleted"] as const)
    api.events.on(event, ({ thread }) =>
      storage.cancelArchivedStorage(thread.id),
    );
  api.background.schedule("archive-storage-cleanup", "0 * * * *", async () => {
    const ranAt = await api.storage.kv.get(ARCHIVE_CLEANUP_RAN_AT_KEY);

    if (
      typeof ranAt === "number" &&
      Date.now() - ranAt < ARCHIVE_CLEANUP_INTERVAL_MS
    )
      return;
    await api.storage.kv.set(ARCHIVE_CLEANUP_RAN_AT_KEY, Date.now());
    await storage.clearPendingArchives(cleanupEnabled);
  });
  api.rpc.register(storageRpc, {
    startEntryCleanup: storage.startEntryCleanup,
    entryCleanup: storage.entryCleanup,
    startCleanup: storage.startCleanup,
    hosts: () => storage.hosts(),
    host: storage.host,
    scanHost: storage.scanHost,
    scanAll: () => storage.scanAll(),
    removeOrphans: (input) => storage.removeOrphans(input),
    clearLargeFiles: storage.clearLargeFiles,
    startClearLargeFiles: storage.startClearLargeFiles,
    retryWorktreeCleanup: (input) => storage.retryWorktreeCleanup(input),
    clearThread: storage.clearThread,
    clearArchivedFiles: storage.clearArchivedFiles,
    startClearArchivedFiles: storage.startClearArchivedFiles,
    removeDevInstances: (input) => storage.removeDevInstances(input),
    removeExternalWorktrees: (input) => storage.removeExternalWorktrees(input),
    startRemoveExternalWorktree: storage.startRemoveExternalWorktree,
    state: () => service.state(),
    preview: (policy) => service.preview(policy),
    configure: (policy) => service.configure(policy),
  });
  registerCli(api, service, storage, managed, housekeeping, worktrees);
  api.background.schedule("retention", "0 * * * *", () => service.sweep());
}
