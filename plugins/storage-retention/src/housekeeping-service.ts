import { randomUUID } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  defaultHousekeepingBudget,
  housekeepingHostContract,
  housekeepingHostSignals,
  housekeepingHostStateSchema,
  type HousekeepingAdapterPreview,
  type HousekeepingBudget,
  type HousekeepingHostState,
  type HousekeepingRun,
  type HousekeepingStage,
  type HousekeepingSource,
} from "./housekeeping-contract.js";

const KEY = "housekeeping.hosts.v1";

const FAILURES_KEY = "housekeeping.failures.v1";

const INTERVAL = 60 * 60_000;

const recordsSchema = z.array(housekeepingHostStateSchema).max(1000);

const failuresSchema = z
  .array(z.object({ hostId: z.string(), message: z.string() }).strict())
  .max(1000);

function stage(
  name: string,
  state: HousekeepingStage["state"],
  reason: string | null = null,
  items: number | null = 0,
  bytes: number | null = 0,
): HousekeepingStage {
  return { name, state, reason, items, bytes };
}

export function createHousekeepingService(
  api: PluginApi,
  options: { reconcileManaged: () => Promise<unknown>; now?: () => number },
) {
  const worker = api.hosts.experimental_client({
    contract: housekeepingHostContract,
    experimental_signals: housekeepingHostSignals,
  });

  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const pendingStarts = new Map<string, Promise<HousekeepingHostState>>();
  let disposed = false;

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(() => {
      if (disposed) throw new Error("Storage & retention is disabled.");

      return operation();
    });

    queue = result.catch(() => undefined);

    return result;
  }

  function changed() {
    api.realtime.publish("housekeeping-changed", null);
  }

  async function records() {
    return recordsSchema.parse((await api.storage.kv.get(KEY)) ?? []);
  }

  async function failures() {
    return failuresSchema.parse((await api.storage.kv.get(FAILURES_KEY)) ?? []);
  }

  async function recordFailure(hostId: string, message: string | null) {
    const previous = await failures();
    const next = previous.filter((entry) => entry.hostId !== hostId);

    if (message !== null) next.push({ hostId, message });

    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      await api.storage.kv.set(FAILURES_KEY, next);
      changed();
    }

    if (message !== null) {
      const item = await local(hostId);

      if (item.currentRun !== null && item.currentRun.reason !== message) {
        item.currentRun = {
          ...item.currentRun,
          state: "held",
          reason: message,
        };
        await save(item);
      }
    }
  }

  async function save(item: HousekeepingHostState) {
    const stored = await records();
    const index = stored.findIndex((value) => value.hostId === item.hostId);

    if (index < 0) stored.push(item);
    else stored[index] = item;
    const before = await api.storage.kv.get(KEY);

    if (JSON.stringify(before) !== JSON.stringify(stored)) {
      await api.storage.kv.set(KEY, stored);
      changed();
    }
  }

  async function local(hostId: string): Promise<HousekeepingHostState> {
    return (
      (await records()).find((item) => item.hostId === hostId) ?? {
        hostId,
        registration: null,
        currentRun: null,
        lastRun: null,
        nextRunAt: null,
      }
    );
  }

  async function finish(
    item: HousekeepingHostState,
    hostRun: HousekeepingRun,
  ): Promise<HousekeepingHostState> {
    const previous = item.currentRun;

    if (previous === null || previous.id !== hostRun.id) return item;

    let run: HousekeepingRun = {
      ...hostRun,
      reserved:
        previous.stages.some(
          (entry) => entry.name === "unused-plugin-artifacts",
        ) &&
        (previous.reserved.items > 0 || previous.reserved.bytes > 0)
          ? previous.reserved
          : hostRun.reserved,
      stages: [
        ...hostRun.stages,
        ...previous.stages.filter(
          (entry) =>
            entry.name === "managed-scratch" ||
            entry.name === "unused-plugin-artifacts",
        ),
      ],
    };

    if (
      (previous.reserved.items > 0 || previous.reserved.bytes > 0) &&
      previous.stages.some((entry) => entry.name === "unused-plugin-artifacts")
    )
      run = {
        ...run,
        state: "held",
        reason:
          "The coordinator cleanup outcome is uncertain. Its budget reservation remains held without replay.",
      };

    if (
      run.state === "planned" ||
      run.state === "running" ||
      run.reserved.items > 0 ||
      run.reserved.bytes > 0 ||
      run.stages.some(
        (entry) =>
          entry.state === "running" &&
          entry.name !== "managed-scratch" &&
          entry.name !== "unused-plugin-artifacts",
      )
    ) {
      item.currentRun = run;
      await save(item);

      return item;
    }

    for (const name of ["managed-scratch", "unused-plugin-artifacts"]) {
      const existing = run.stages.find((entry) => entry.name === name);

      if (existing !== undefined) {
        if (existing.state === "running")
          run = {
            ...run,
            state: "held",
            reason:
              "A coordinator stage has an uncertain result and was not replayed.",
            stages: run.stages.map((entry) =>
              entry.name === name
                ? {
                    ...entry,
                    state: "held",
                    reason:
                      "The previous coordinator stopped before its receipt.",
                  }
                : entry,
            ),
          };
        continue;
      }

      run = { ...run, stages: [...run.stages, stage(name, "running")] };
      item.currentRun = run;
      await save(item);
      let outcome: HousekeepingStage;

      try {
        if (name === "managed-scratch") {
          if (run.mode === "preview")
            outcome = stage(
              name,
              "deferred",
              "Managed scratch is inspected through its existing managed status. Preview does not reconcile or remove it.",
            );
          else {
            await options.reconcileManaged();
            outcome = stage(name, "complete");
          }
        } else {
          const otherOwner = (await records()).some(
            (entry) =>
              entry.hostId !== item.hostId &&
              entry.currentRun !== null &&
              entry.currentRun.stages.some(
                (value) => value.name === "unused-plugin-artifacts",
              ) &&
              (entry.currentRun.reserved.items > 0 ||
                entry.currentRun.reserved.bytes > 0),
          );

          const usedItems = run.stages.reduce(
            (total, entry) => total + (entry.items ?? 0),
            0,
          );

          const usedBytes = run.stages.reduce(
            (total, entry) => total + (entry.bytes ?? 0),
            0,
          );

          const maxItems = Math.max(0, run.budget.maxItems - usedItems);
          const maxBytes = Math.max(0, run.budget.maxBytes - usedBytes);

          if (otherOwner)
            outcome = stage(
              name,
              "held",
              "Another maintenance run holds an unresolved coordinator cache cleanup reservation.",
            );
          else if (
            maxItems === 0 ||
            maxBytes === 0 ||
            now() - run.startedAt >= run.budget.budgetSeconds * 1000
          )
            outcome = stage(
              name,
              "deferred",
              "The run budget is exhausted before this stage.",
            );
          else {
            const preview = await api.sdk.plugins.experimental_pruneCache({
              dryRun: true,
              maxItems,
              maxBytes,
            });

            if (
              preview.budget?.maxItems !== maxItems ||
              preview.budget.maxBytes !== maxBytes
            )
              outcome = stage(
                name,
                "held",
                "Coordinator update required for bounded plugin cache cleanup.",
              );
            else {
              if (run.mode === "apply") {
                run = {
                  ...run,
                  reserved: { items: maxItems, bytes: maxBytes },
                };
                item.currentRun = run;
                await save(item);
              }

              const result =
                run.mode === "preview"
                  ? preview
                  : await api.sdk.plugins.experimental_pruneCache({
                      dryRun: false,
                      maxItems,
                      maxBytes,
                    });

              if (
                result.budget?.maxItems !== maxItems ||
                result.budget.maxBytes !== maxBytes
              )
                throw new Error("The bounded cleanup receipt is uncertain.");
              run = { ...run, reserved: { items: 0, bytes: 0 } };
              outcome = stage(
                name,
                "complete",
                null,
                result.removed.length,
                result.bytes,
              );
            }
          }
        }
      } catch {
        outcome = stage(
          name,
          "held",
          "This maintenance stage could not produce a verified terminal receipt.",
        );
      }

      run = {
        ...run,
        stages: run.stages.map((entry) =>
          entry.name === name ? outcome : entry,
        ),
      };
      item.currentRun = run;
      await save(item);

      if (run.reserved.items > 0 || run.reserved.bytes > 0) {
        item.currentRun = {
          ...run,
          state: "held",
          reason:
            "The coordinator cleanup outcome is uncertain. Its budget reservation remains held without replay.",
        };
        await save(item);

        return item;
      }
    }

    if (
      run.stages.some(
        (entry) => entry.state === "held" || entry.state === "failed",
      )
    )
      run = {
        ...run,
        state: "held",
        reason: run.reason ?? "One or more maintenance stages remain held.",
      };
    run = { ...run, finishedAt: now() };
    item.lastRun = run;
    item.currentRun = null;

    if (run.mode === "apply") item.nextRunAt = now() + INTERVAL;
    await save(item);

    return item;
  }

  async function refresh(hostId: string) {
    const item = await local(hostId);
    const host = await worker.call("housekeepingHostState", null, { hostId });
    item.registration = host.registration;
    await recordFailure(hostId, null);

    if (item.currentRun !== null) {
      const run = await worker.call(
        "housekeepingHostRun",
        { id: item.currentRun.id },
        { hostId },
      );

      return finish(item, run);
    }

    if (host.currentRun !== null) item.currentRun = host.currentRun;

    if (host.lastRun !== null && item.lastRun?.id !== host.lastRun.id)
      item.lastRun = host.lastRun;
    await save(item);

    return item;
  }

  async function start(
    hostId: string,
    budget: HousekeepingBudget,
    mode: "preview" | "apply",
  ) {
    const item = await refresh(hostId);

    if (item.currentRun !== null) return item;

    const run: HousekeepingRun = {
      id: randomUUID(),
      mode,
      state: "planned",
      startedAt: now(),
      finishedAt: null,
      registrationRevision: item.registration?.revision ?? null,
      bindingsDigest: item.registration?.bindingsDigest ?? null,
      budget,
      reserved: { items: 0, bytes: 0 },
      stages: [],
      reason: null,
    };

    item.currentRun = run;
    await save(item);

    try {
      await worker.call("housekeepingHostStart", { run }, { hostId });
    } catch {
      item.currentRun = {
        ...run,
        state: "held",
        reason:
          "The host launch response is uncertain. Status will reconcile this exact run without replay.",
      };
      await save(item);
    }

    return item;
  }

  const unsubscribe = worker.experimental_onSignal("changed", (event) => {
    if (disposed) return;
    void serial(async () => {
      try {
        await refresh(event.hostId);
      } catch {
        await recordFailure(
          event.hostId,
          "The host maintenance receipt could not be inspected. The existing run and reservations remain held without replay.",
        );
      }
    });
  });

  api.onDispose(() => {
    disposed = true;
    unsubscribe();
  });

  function requestStart(
    input: { hostId: string; budget: HousekeepingBudget },
    mode: "apply" | "preview",
  ) {
    const pending = pendingStarts.get(input.hostId);

    if (pending !== undefined) return pending;
    const operation = serial(() => start(input.hostId, input.budget, mode));
    pendingStarts.set(input.hostId, operation);
    void operation
      .finally(() => {
        if (pendingStarts.get(input.hostId) === operation)
          pendingStarts.delete(input.hostId);
      })
      .catch(() => undefined);

    return operation;
  }

  return {
    status: () =>
      serial(async () => {
        const stored = await records();
        const connected = await api.sdk.hosts.list();

        const ids = [
          ...new Set([
            ...stored.map((item) => item.hostId),
            ...connected.map((item) => item.id),
          ]),
        ];

        const hosts: HousekeepingHostState[] = [];

        for (const hostId of ids) {
          try {
            hosts.push(await refresh(hostId));
          } catch {
            hosts.push(await local(hostId));
            await recordFailure(
              hostId,
              "The host could not be inspected. Existing run ownership and reservations remain held without replay.",
            );
          }
        }

        return { hosts, failures: await failures() };
      }),
    run: (input: { hostId: string; budget: HousekeepingBudget }) =>
      requestStart(input, "apply"),
    preview: (input: { hostId: string; budget: HousekeepingBudget }) =>
      requestStart(input, "preview"),
    adapterPreview: (
      input: HousekeepingSource & { hostId: string },
    ): Promise<HousekeepingAdapterPreview> =>
      serial(async () => {
        const { hostId, ...source } = input;

        return {
          hostId,
          ...(await worker.call("housekeepingHostAdapterPreview", source, {
            hostId,
          })),
        };
      }),
    adapterAdopt: (input: {
      hostId: string;
      revision: number;
      previewDigest: string;
    }) =>
      serial(async () => {
        const { hostId, ...confirmation } = input;
        await worker.call("housekeepingHostAdapterAdopt", confirmation, {
          hostId,
        });
        const item = await refresh(hostId);
        item.nextRunAt = now() + INTERVAL;
        await save(item);

        return item;
      }),
    adapterRemove: (input: {
      hostId: string;
      revision: number;
      previewDigest: string;
    }) =>
      serial(async () => {
        const { hostId, ...confirmation } = input;
        await worker.call("housekeepingHostAdapterRemove", confirmation, {
          hostId,
        });

        return refresh(hostId);
      }),
    reconcile: () =>
      serial(async () => {
        let connected;

        try {
          connected = await api.sdk.hosts.list();
          await recordFailure("coordinator", null);
        } catch {
          await recordFailure(
            "coordinator",
            "The current host directory is unavailable. Maintenance discovery remains held.",
          );

          return;
        }

        const online = new Set(
          connected
            .filter(
              (host) =>
                host.status === "connected" && host.type === "persistent",
            )
            .map((host) => host.id),
        );

        for (const hostId of online) {
          const item = await local(hostId);

          if (item.nextRunAt === null) {
            item.nextRunAt = now();
            await save(item);
          }
        }

        const stored = await records();

        for (const item of stored) {
          if (
            item.currentRun === null &&
            (item.nextRunAt === null || item.nextRunAt > now())
          )
            continue;

          if (!online.has(item.hostId)) {
            await recordFailure(
              item.hostId,
              "The maintenance host is offline. Its existing run and reservations remain held until reconnect.",
            );
            continue;
          }

          try {
            const current = await refresh(item.hostId);

            if (
              current.currentRun === null &&
              current.nextRunAt !== null &&
              current.nextRunAt <= now()
            )
              await start(
                item.hostId,
                { ...defaultHousekeepingBudget },
                "apply",
              );
          } catch {
            await recordFailure(
              item.hostId,
              "The host maintenance receipt could not be inspected. The existing run and reservations remain held without replay.",
            );
          }
        }
      }),
  };
}

export type HousekeepingService = ReturnType<typeof createHousekeepingService>;
