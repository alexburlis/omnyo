import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import {
  hostContract,
  hostSignals,
  ownerMetadata,
  type OwnerMetadata,
} from "./host-contract";
import {
  rpcContract,
  reclaimResult,
  savedRecord,
  sidebarRepository,
  type CleanupOutcome,
} from "./contract";
import {
  planCleanup,
  type CleanupItem,
  type CleanupResult,
} from "./cleanup-plan";
import { applyCleanup, key, type CleanupTarget } from "./saved-scan";

export { rpcContract } from "./contract";

type WorktreeInventory = Pick<
  z.output<(typeof hostContract)["inventory"]["output"]>,
  "entries" | "issues"
>;

export type WorktreeAccess = {
  scan(hostId: string): Promise<WorktreeInventory>;
  removeFolders(hostId: string, items: CleanupItem[]): Promise<CleanupResult>;
};

const historyImport = defineRpcContract({
  importWorktreeHistory: {
    input: savedRecord,
    output: z.object({ snapshot: z.boolean(), receipt: z.boolean() }),
  },
});

export function registerWorktrees(
  api: PluginApi,
  forgetExternal: (hostId: string, paths: string[]) => void,
) {
  const lifetime = new AbortController();
  const db = api.storage.database();

  const row = db
    .prepare<{ id: number }, { payload: string; imported: number }>(
      "SELECT payload, imported FROM saved_scan WHERE id = @id",
    )
    .get({ id: 1 });

  let record = row
    ? savedRecord.parse(JSON.parse(row.payload))
    : savedRecord.parse({ snapshot: null, lastError: null });

  let historyImported = row?.imported === 1;

  let scanFlight: Promise<void> | null = null;
  let startedAt: string | null = null;
  let cleaning = false;
  const confirmations = new Map<string, CleanupTarget>();
  let ownerHostId: string | null = null;

  const host = api.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  const subscriptions = [
    host.experimental_onSignal("git-changed", (event) => {
      if (event.hostId === ownerHostId)
        api.realtime.publish("git-changed", event.payload);
    }),
    host.experimental_onSignal("cleanup-progress", (event) => {
      if (event.hostId === ownerHostId)
        api.realtime.publish("cleanup-progress", event.payload);
    }),
  ];

  api.onDispose(async () => {
    lifetime.abort();

    for (const dispose of subscriptions) dispose();
    await Promise.allSettled([scanFlight, ...inventoryFlights.values()]);
  });

  async function primaryHost() {
    const { primaryHostId } = await api.sdk.system.config();

    if (!primaryHostId)
      throw new Error("The machine running Omnyo is not connected yet");

    return primaryHostId;
  }

  async function envelope<T>(request: T, selectedHostId?: string) {
    const [projects, { hostId, environments }, threadPages] = await Promise.all(
      [
        api.sdk.projects.list({ includePersonal: true }),
        (async () => {
          const hostId = selectedHostId ?? (await primaryHost());
          const result = [];

          for (let offset = 0; ; offset += 100) {
            const page = await api.sdk.environments.list({
              hostId,
              limit: 100,
              offset,
            });

            result.push(...page);

            if (page.length < 100) return { hostId, environments: result };
          }
        })(),
        Promise.all(
          [false, true].map(async (archived) => {
            const result = [];

            for (let offset = 0; ; offset += 200) {
              const page = await api.sdk.threads.list({
                archived,
                includeHidden: true,
                limit: 200,
                offset,
                signal: lifetime.signal,
              });

              result.push(
                ...page.filter(
                  (thread) =>
                    !archived ||
                    thread.pinnedAt != null ||
                    thread.shelvedAt != null,
                ),
              );

              if (page.length < 200) return result;
            }
          }),
        ),
      ],
    );

    if (selectedHostId === undefined) ownerHostId = hostId;

    return {
      request,
      metadata: ownerMetadata.parse({
        hostId,
        chatTargets: [
          ...new Set(
            threadPages
              .flat()
              .flatMap((thread) => [
                thread.id,
                ...(thread.environmentHostId === hostId
                  ? [
                      thread.environmentBranchName,
                      thread.environmentPath,
                    ].filter((target): target is string => target != null)
                  : []),
              ]),
          ),
        ],
        projects: projects.map((project) => ({
          ...project,
          repositories:
            (selectedHostId === undefined
              ? record.snapshot?.entries
              : undefined
            )
              ?.filter((entry) => entry.projectId === project.id)
              .map((entry) => entry.path) ?? [],
        })),
        environments,
      }),
    };
  }

  const options = (input: { metadata: { hostId: string } }) => ({
    hostId: input.metadata.hostId,
    signal: lifetime.signal,
    timeoutMs: 300_000,
  });

  function publish() {
    if (!lifetime.signal.aborted) api.realtime.publish("scan-changed", {});
  }

  function save(next = record, imported = historyImported) {
    lifetime.signal.throwIfAborted();
    db.prepare(
      "INSERT INTO saved_scan (id, payload, imported) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, imported = excluded.imported",
    ).run(JSON.stringify(next), Number(imported));
    record = next;
    historyImported = imported;
    publish();
  }

  function state() {
    const next = new Date(Date.now());
    next.setHours(next.getHours() + 3 - (next.getHours() % 3), 0, 0, 0);

    return {
      ...record,
      scanning: scanFlight !== null,
      startedAt,
      nextScanAt: next.toISOString(),
    };
  }

  function snapshot() {
    if (!record.snapshot)
      throw new Error(
        "The first automatic scan is still pending. Use Rescan to try now.",
      );

    return record.snapshot;
  }

  const inventoryFlights = new Map<
    string,
    Promise<z.output<(typeof hostContract)["inventory"]["output"]>>
  >();

  function readInventory(hostId: string) {
    const existing = inventoryFlights.get(hostId);

    if (existing) return existing;

    const flight = (async () => {
      const input = await envelope(null, hostId);

      return host.call("inventory", input, options(input));
    })().finally(() => {
      if (inventoryFlights.get(hostId) === flight)
        inventoryFlights.delete(hostId);
    });

    inventoryFlights.set(hostId, flight);

    return flight;
  }

  async function scan(hostId: string): Promise<WorktreeInventory> {
    const { primaryHostId } = await api.sdk.system.config();

    if (hostId !== primaryHostId) return readInventory(hostId);
    await refresh();

    return snapshot();
  }

  function refresh() {
    if (scanFlight) return scanFlight;

    if (cleaning)
      return Promise.reject(
        new Error("Cleanup is running. Rescan when it finishes."),
      );
    const start = Date.now();
    startedAt = new Date(start).toISOString();
    scanFlight = (async () => {
      try {
        const hostId = await primaryHost();
        ownerHostId = hostId;
        const result = await readInventory(hostId);
        lifetime.signal.throwIfAborted();
        record = {
          ...record,
          snapshot: {
            ...result,
            id: randomUUID(),
            durationMs: Math.max(0, Date.now() - start),
            items: planCleanup(
              result.entries.flatMap((entry) =>
                entry.repo
                  ? [
                      {
                        projectId: entry.projectId,
                        projectName: entry.projectName,
                        repo: entry.repo,
                      },
                    ]
                  : [],
              ),
            ),
          },
          lastError: null,
        };
        save();
      } catch (error) {
        if (!lifetime.signal.aborted) {
          record = {
            ...record,
            lastError: `Scan failed: ${error instanceof Error ? error.message : String(error)}. Showing the last saved scan.`,
          };
          save();
        }

        throw error;
      } finally {
        scanFlight = null;
        startedAt = null;
        publish();
      }
    })();
    publish();

    return scanFlight;
  }

  function requestScan() {
    if (cleaning)
      throw new Error("Cleanup is running. Rescan when it finishes.");
    void refresh().catch((error) => {
      if (!lifetime.signal.aborted)
        api.log.warn(error instanceof Error ? error.message : String(error));
    });

    return state();
  }

  api.background.schedule("scan", "0 */3 * * *", () => refresh());
  api.background.service("initial-scan", {
    async start(signal) {
      const abort = () => lifetime.abort();
      signal.addEventListener("abort", abort, { once: true });

      try {
        if (
          !record.snapshot ||
          Date.now() - Date.parse(record.snapshot.scannedAt) >=
            3 * 60 * 60 * 1000
        )
          await refresh();
      } catch (error) {
        if (!lifetime.signal.aborted)
          api.log.warn(error instanceof Error ? error.message : String(error));
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });

  function updateCleanup(
    result: Parameters<typeof applyCleanup>[1],
    lastCleanup: CleanupOutcome | null,
  ) {
    record = {
      ...record,
      snapshot: record.snapshot && applyCleanup(record.snapshot, result),
      lastCleanup,
    };
    save();

    if (ownerHostId)
      forgetExternal(
        ownerHostId,
        result.removed.flatMap((item) =>
          item.kind === "folder" ? [item.target] : [],
        ),
      );
  }

  async function cleanSaved(snapshotId: string) {
    if (cleaning || scanFlight)
      throw new Error(
        "A scan or cleanup is already running. Try again when it finishes.",
      );
    const current = snapshot();

    if (snapshotId !== current.id)
      throw new Error(
        "The saved scan changed. Use the latest scan before cleaning.",
      );

    if (!current.items.length)
      throw new Error("No safe items remain in this scan.");
    cleaning = true;

    try {
      const input = await envelope({ token: snapshotId, items: current.items });
      const result = await host.call("cleanSaved", input, options(input));

      updateCleanup(result, {
        ...result,
        finishedAt: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      record = {
        ...record,
        lastError:
          "Cleanup interrupted. Rescan to check the latest state before trying again.",
      };
      updateCleanup(
        {
          removed: [],
          skipped: current.items.map((item) => ({
            ...item,
            reason: "Cleanup interrupted. Rescan before trying again.",
          })),
        },
        null,
      );
      throw error;
    } finally {
      cleaning = false;
    }
  }

  async function oneMutation<
    T extends { removed: boolean; freedBytes?: number | null },
  >(
    token: string,
    mutate: (input: {
      request: { token: string };
      metadata: OwnerMetadata;
    }) => Promise<T>,
  ) {
    if (cleaning || scanFlight)
      throw new Error(
        "A scan or cleanup is already running. Try again when it finishes.",
      );
    cleaning = true;
    const item = confirmations.get(token);
    confirmations.delete(token);

    try {
      const result = await mutate(await envelope({ token }));

      if (result.removed && item) {
        const saved = record.snapshot?.items.find(
          (candidate) => key(candidate) === key(item),
        );

        updateCleanup(
          { removed: [item], skipped: [] },
          saved
            ? {
                removed: [{ ...saved, freedBytes: result.freedBytes ?? null }],
                skipped: [],
                finishedAt: new Date().toISOString(),
              }
            : null,
        );
      }

      return result;
    } finally {
      cleaning = false;
    }
  }

  async function removeFolders(
    hostId: string,
    items: CleanupItem[],
  ): Promise<CleanupResult> {
    if (items.some((item) => item.kind !== "folder"))
      throw new Error("Storage cleanup only accepts working folders.");

    const { primaryHostId } = await api.sdk.system.config();
    const primary = hostId === primaryHostId;

    if (primary && (cleaning || scanFlight))
      throw new Error(
        "A scan or cleanup is already running. Try again when it finishes.",
      );

    if (primary) {
      ownerHostId = hostId;
      cleaning = true;
    }

    try {
      const input = await envelope({ token: randomUUID(), items }, hostId);
      const result = await host.call("cleanSaved", input, options(input));

      if (primary)
        updateCleanup(result, {
          ...result,
          finishedAt: new Date().toISOString(),
        });

      return result;
    } finally {
      if (primary) cleaning = false;
    }
  }

  api.rpc.register(
    historyImport,
    {
      importWorktreeHistory: (previous) => {
        if (historyImported) return { snapshot: false, receipt: false };

        const importSnapshot =
          record.snapshot === null && previous.snapshot !== null;

        const importReceipt =
          record.lastCleanup === null && previous.lastCleanup !== null;

        const snapshot = importSnapshot ? previous.snapshot : record.snapshot;

        save(
          {
            ...record,
            snapshot:
              snapshot &&
              (importSnapshot ? { ...snapshot, items: [] } : snapshot),
            lastError: importSnapshot ? previous.lastError : record.lastError,
            lastCleanup: importReceipt
              ? previous.lastCleanup
              : record.lastCleanup,
          },
          true,
        );

        return { snapshot: importSnapshot, receipt: importReceipt };
      },
    },
    { experimental_discoverable: true },
  );

  const reclaims = new Map<string, { admitted: boolean; cancelled: boolean }>();

  api.rpc.register(rpcContract, {
    hostInventory: async ({ hostId }) => readInventory(hostId),
    cancelReclaim: async ({ hostId }) => {
      const operation = reclaims.get(hostId);

      if (!operation) return { cancelled: false };
      operation.cancelled = true;

      if (!operation.admitted) return { cancelled: true };

      return api.sdk.plugins.callRpc({
        pluginId: "environment-git-worktree",
        method: "cancelWorktreeStorage",
        input: { hostId },
        outputSchema: z.object({ cancelled: z.boolean() }),
      });
    },
    reclaimSpace: async ({
      hostId,
      worktrees,
    }): Promise<z.infer<typeof reclaimResult>> => {
      if (reclaims.has(hostId))
        throw new Error("Space reclaim is already running on this machine.");
      const operation = { admitted: false, cancelled: false };
      reclaims.set(hostId, operation);

      try {
        const inventory = await readInventory(hostId);

        const resolved = new Map<
          string,
          { sourcePath: string; path: string }
        >();

        const skippedWorktrees: z.infer<
          typeof reclaimResult
        >["skippedWorktrees"] = [];

        for (const selected of worktrees) {
          const entry = inventory.entries.find(
            (candidate) =>
              candidate.projectId === selected.projectId &&
              candidate.path === selected.repo,
          );

          const tree = entry?.repo?.worktrees.find(
            (candidate) => candidate.path === selected.path,
          );

          const reason =
            !entry?.repo || !tree
              ? "This worktree is no longer in the selected machine's inventory."
              : selected.path === entry.path
                ? "The primary checkout cannot be reclaimed."
                : tree.error || tree.missing || tree.bare || tree.locked
                  ? "This worktree is locked or unavailable. Rescan before reclaiming space."
                  : null;

          if (reason) skippedWorktrees.push({ path: selected.path, reason });
          else
            resolved.set(selected.path, {
              sourcePath: selected.repo,
              path: selected.path,
            });
        }

        if (operation.cancelled)
          return {
            status: "cancelled",
            sharedFiles: 0,
            privateBytesReleased: 0,
            skippedFiles: 0,
            skippedWorktrees,
          };

        operation.admitted = true;

        const result = await api.sdk.plugins.callRpc({
          pluginId: "environment-git-worktree",
          method: "reclaimWorktreeStorage",
          input: { hostId, worktrees: [...resolved.values()] },
          outputSchema: reclaimResult,
        });

        return {
          ...result,
          skippedWorktrees: [...skippedWorktrees, ...result.skippedWorktrees],
        };
      } finally {
        reclaims.delete(hostId);
      }
    },
    savedScan: () => state(),
    rescan: () => requestScan(),
    cleanSaved: ({ snapshotId }) => cleanSaved(snapshotId),
    catalog: () => {
      const scan = snapshot();

      const projects = [
        ...new Set(scan.entries.map((entry) => entry.projectId)),
      ].map((id) => ({
        id,
        name: scan.entries.find((entry) => entry.projectId === id)!.projectName,
        repos: scan.entries
          .filter((entry) => entry.projectId === id)
          .map((entry) => entry.path),
      }));

      return { projects, errors: scan.issues };
    },
    sidebar: ({ projectIds }) => {
      const scan = snapshot();

      return {
        projects: [...new Set(projectIds)].map((id) => ({
          id,
          repos: scan.entries.flatMap((entry) =>
            entry.projectId === id && entry.repo
              ? [sidebarRepository.parse(entry.repo)]
              : [],
          ),
          errors: [
            ...scan.issues,
            ...scan.entries.flatMap((entry) =>
              entry.projectId === id && entry.error ? [entry.error] : [],
            ),
          ],
        })),
        checkedAt: scan.scannedAt,
      };
    },
    cleanupSummary: () => {
      const scan = snapshot();
      const folders = scan.items.filter((item) => item.kind === "folder");

      return {
        folders: folders.length,
        estimatedBytes: folders.reduce(
          (sum, item) => sum + (item.estimatedBytes ?? 0),
          0,
        ),
        unknownFolders: folders.filter((item) => item.estimatedBytes === null)
          .length,
        checkedAt: scan.scannedAt,
        issues: [
          ...scan.issues,
          ...scan.entries.flatMap((entry) =>
            entry.error ? [entry.error] : [],
          ),
        ],
      };
    },
    inspect: async (request) => {
      const input = await envelope(request);

      return host.call("inspect", input, options(input));
    },
    storage: async (request) => {
      const input = await envelope(request);

      return host.call("storage", input, options(input));
    },
    projects: async (request) => {
      const input = await envelope(request);

      return host.call("projects", input, options(input));
    },
    inventory: async () => {
      await refresh();

      return snapshot();
    },
    scan: async (request) => {
      const input = await envelope(request);

      return host.call("scan", input, options(input));
    },
    files: async ({ hostId, ...request }) => {
      const input = await envelope(request, hostId);

      return host.call("files", input, options(input));
    },
    diff: async ({ hostId, ...request }) => {
      const input = await envelope(request, hostId);

      return host.call("diff", input, options(input));
    },
    prepare: async (request) => {
      const input = await envelope(request);
      const result = await host.call("prepare", input, options(input));
      confirmations.set(result.token, {
        projectId: request.projectId,
        repo: request.repo,
        kind: "folder",
        target: result.path,
      });

      return result;
    },
    prepareBranch: async (request) => {
      const input = await envelope(request);
      const result = await host.call("prepareBranch", input, options(input));
      confirmations.set(result.token, {
        projectId: request.projectId,
        repo: request.repo,
        kind: "branch",
        target: result.branch,
      });

      return result;
    },
    deleteBranch: ({ token }) =>
      oneMutation(token, (input) =>
        host.call("deleteBranch", input, options(input)),
      ),
    prepareAll: async (request) => {
      const input = await envelope(request);

      return host.call("prepareAll", input, options(input));
    },
    cleanupAll: async (request) => {
      if (cleaning || scanFlight)
        throw new Error("A scan or cleanup is already running");
      cleaning = true;

      try {
        const input = await envelope(request);
        const result = await host.call("cleanupAll", input, options(input));
        updateCleanup(result, {
          ...result,
          finishedAt: new Date().toISOString(),
        });

        return result;
      } finally {
        cleaning = false;
      }
    },
    purge: ({ token }) =>
      oneMutation(token, (input) => host.call("purge", input, options(input))),
  });

  function status(projectId?: string) {
    const current = state();

    if (!projectId || !current.snapshot) return current;
    const snapshot = current.snapshot;

    return {
      ...current,
      snapshot: {
        ...snapshot,
        entries: snapshot.entries.filter(
          (entry) => entry.projectId === projectId,
        ),
        items: snapshot.items.filter((item) => item.projectId === projectId),
        missingInactiveEnvironments:
          snapshot.missingInactiveEnvironments?.filter(
            (entry) => entry.projectId === projectId,
          ),
      },
    };
  }

  return { scan, removeFolders, status, requestScan, cleanSaved };
}

export type Worktrees = ReturnType<typeof registerWorktrees>;
