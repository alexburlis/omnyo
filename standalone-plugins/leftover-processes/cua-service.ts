import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  cuaConsumerAction,
  cuaKeepAction,
  cuaReconcileAction,
  cuaRegistration,
  type CuaConsumerAction,
  type CuaInventory,
  type CuaResource,
  type CuaRuntimeConfig,
  type CuaStopInput,
  type CuaStopResult,
} from "./cua-contract";
import {
  cuaBootstrapHold,
  cuaResourceView,
  cuaStopHold,
  isCuaReleaseDue,
  sameCuaRuntime,
} from "./cua-policy";
import type { CuaStore } from "./cua-store";

export interface CuaHost {
  inspect(hostId: string, config?: CuaRuntimeConfig): Promise<CuaInventory>;
  stop(hostId: string, input: CuaStopInput): Promise<CuaStopResult>;
  reconcile(hostId: string, vm: CuaResource["vm"]): Promise<"running" | "stopped" | "unknown">;
}

export function createCuaService({
  store,
  host,
  ownerStatus,
  now = Date.now,
}: {
  store: CuaStore;
  host: CuaHost;
  ownerStatus: (ownerThreadId: string) => Promise<"finished" | "active" | "unknown">;
  now?: () => number;
}) {
  let queue: Promise<void> = Promise.resolve();
  let recovered = false;

  function exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const result = queue.then(async () => {
      if (!recovered) {
        for (const resource of store.list()) {
          if (resource.transition.kind === "stopping")
            store.save({
              ...resource,
              transition: {
                kind: "uncertain",
                requestedAt: resource.transition.requestedAt,
                reason:
                  "Housekeeping restarted during a shutdown. Reconcile the resource before retrying.",
              },
            });
        }

        recovered = true;
      }

      return work();
    });

    queue = result.then(
      () => {},
      () => {},
    );

    return result;
  }

  function requireResource(id: string): CuaResource {
    const resource = store.get(id);

    if (resource === null) throw new Error("The Cua resource is not registered.");

    return resource;
  }

  function requireStable(resource: CuaResource): void {
    if (resource.transition.kind !== "stable")
      throw new Error(
        "The Cua resource is stopping, stopped, or has an uncertain shutdown outcome.",
      );
  }

  function requireOwner(resource: CuaResource, ownerThreadId: string): void {
    if (resource.ownerThreadId !== ownerThreadId)
      throw new Error("Only the registered owner can change this Cua resource.");
  }

  function save(resource: CuaResource) {
    store.save(resource);

    return cuaResourceView(resource, now());
  }

  function action(input: CuaConsumerAction, acquire: boolean) {
    const checked = cuaConsumerAction.parse(input);
    const allowResume = acquire && store.get(checked.resourceId)?.transition.kind === "stopped";

    return exclusive(async () => {
      const resource = requireResource(checked.resourceId);

      if (allowResume && resource.transition.kind === "stopped") {
        requireOwner(resource, checked.ownerThreadId);

        if (resource.ownership !== "managed")
          throw new Error("Only a previously managed resource can be reacquired after shutdown.");
        const inspection = await host.inspect(resource.hostId, resource.config);

        const sandbox = inspection.sandboxes.find(
          (candidate) =>
            candidate.name === resource.sandbox.name &&
            candidate.containerId === resource.sandbox.containerId &&
            candidate.createdAt === resource.sandbox.createdAt,
        );

        if (sandbox === undefined)
          throw new Error("The original Cua sandbox identity could not be verified after resume.");

        if (
          inspection.vm === null ||
          (inspection.vm.pid === resource.vm.pid &&
            inspection.vm.startedAt === resource.vm.startedAt)
        )
          throw new Error(
            "A stopped Cua resource must be resumed into a verified new virtual machine instance.",
          );
        const hold = cuaBootstrapHold(sandbox);

        if (hold !== null) throw new Error(hold);

        return save({
          ...resource,
          vm: inspection.vm,
          sandbox,
          consumers: [
            { id: checked.consumerId, ownerThreadId: checked.ownerThreadId, acquiredAt: now() },
          ],
          idleSince: null,
          lastHoldReason: null,
          lastObserved: { at: now(), memory: inspection.memory },
          transition: { kind: "stable" },
        });
      }

      requireStable(resource);
      const existing = resource.consumers.find((item) => item.id === checked.consumerId);

      if (existing !== undefined && existing.ownerThreadId !== checked.ownerThreadId)
        throw new Error("The Cua consumer belongs to another owner.");

      if (acquire) {
        const inspection = await host.inspect(resource.hostId, resource.config);

        if (
          inspection.vm?.pid !== resource.vm.pid ||
          inspection.vm.startedAt !== resource.vm.startedAt
        )
          throw new Error("The Cua virtual machine identity changed.");

        if (
          !inspection.sandboxes.some(
            (sandbox) =>
              sandbox.name === resource.sandbox.name &&
              sandbox.containerId === resource.sandbox.containerId &&
              sandbox.createdAt === resource.sandbox.createdAt,
          )
        )
          throw new Error("The Cua sandbox identity changed.");

        if (existing !== undefined) return cuaResourceView(resource, now());

        return save({
          ...resource,
          consumers: [
            ...resource.consumers,
            { id: checked.consumerId, ownerThreadId: checked.ownerThreadId, acquiredAt: now() },
          ],
          idleSince: null,
          lastHoldReason: null,
          lastObserved: { at: now(), memory: inspection.memory },
        });
      }

      if (existing === undefined) return cuaResourceView(resource, now());
      const consumers = resource.consumers.filter((item) => item.id !== checked.consumerId);

      return save({
        ...resource,
        consumers,
        idleSince: consumers.length === 0 ? now() : null,
        lastHoldReason: null,
      });
    });
  }

  return {
    register(input: z.input<typeof cuaRegistration>) {
      const checked = cuaRegistration.parse(input);

      return exclusive(async () => {
        const observation = await host.inspect(checked.hostId);
        const sandbox = observation.sandboxes.find((item) => item.name === checked.sandboxName);

        if (sandbox === undefined || observation.vm === null)
          throw new Error(
            "The Cua sandbox and virtual machine must both have a verified running identity.",
          );
        const age = now() - Date.parse(sandbox.createdAt);

        if (checked.ownership === "managed" && (age < 0 || age > 120_000))
          throw new Error(
            "Only a sandbox created within the past two minutes can be registered as managed. Older sandboxes remain observed only.",
          );

        const bootstrapHold = checked.ownership === "managed" ? cuaBootstrapHold(sandbox) : null;

        if (bootstrapHold !== null) throw new Error(bootstrapHold);

        if (
          store
            .list(checked.hostId)
            .some(
              (item) =>
                item.config.home === observation.config.home &&
                item.sandbox.name === sandbox.name &&
                item.transition.kind !== "stopped",
            )
        )
          throw new Error("This Cua sandbox already has a resource owner.");
        const timestamp = now();

        return save({
          id: randomUUID(),
          hostId: checked.hostId,
          ownerThreadId: checked.ownerThreadId,
          ownership: checked.ownership,
          config: observation.config,
          vm: observation.vm,
          sandbox,
          consumers: [
            {
              id: checked.initialConsumerId,
              ownerThreadId: checked.ownerThreadId,
              acquiredAt: timestamp,
            },
          ],
          keepRequested: false,
          idleGraceMs: checked.idleGraceMs,
          idleSince: null,
          lastHoldReason: null,
          lastObserved: { at: timestamp, memory: observation.memory },
          transition: { kind: "stable" },
          registeredAt: timestamp,
        });
      });
    },
    acquire(input: CuaConsumerAction) {
      return action(input, true);
    },
    release(input: CuaConsumerAction) {
      return action(input, false);
    },
    keep(input: z.infer<typeof cuaKeepAction>) {
      const checked = cuaKeepAction.parse(input);

      return exclusive(() => {
        const resource = requireResource(checked.resourceId);
        requireStable(resource);
        requireOwner(resource, checked.ownerThreadId);

        if (resource.keepRequested === checked.keep) return cuaResourceView(resource, now());

        return save({
          ...resource,
          keepRequested: checked.keep,
          idleSince: resource.consumers.length === 0 ? now() : null,
          lastHoldReason: null,
        });
      });
    },
    list(input: { hostId?: string } = {}) {
      return exclusive(() => ({
        resources: store.list(input.hostId).map((resource) => cuaResourceView(resource, now())),
      }));
    },
    observe(input: { hostId: string }) {
      return exclusive(() => host.inspect(input.hostId));
    },
    reconcile(input: z.infer<typeof cuaReconcileAction>) {
      const checked = cuaReconcileAction.parse(input);

      return exclusive(async () => {
        const resource = requireResource(checked.resourceId);
        requireOwner(resource, checked.ownerThreadId);

        if (resource.transition.kind !== "uncertain" && resource.transition.kind !== "stopping")
          return cuaResourceView(resource, now());
        const outcome = await host.reconcile(resource.hostId, resource.vm);

        if (outcome === "unknown") return cuaResourceView(resource, now());

        for (const related of store
          .list(resource.hostId)
          .filter(
            (item) =>
              sameCuaRuntime(resource, item) &&
              item.vm.pid === resource.vm.pid &&
              item.vm.startedAt === resource.vm.startedAt &&
              (item.transition.kind === "uncertain" || item.transition.kind === "stopping"),
          )) {
          save({
            ...related,
            transition:
              outcome === "stopped" ? { kind: "stopped", completedAt: now() } : { kind: "stable" },
            idleSince: now(),
            lastHoldReason: null,
          });
        }

        return cuaResourceView(requireResource(resource.id), now());
      });
    },
    sweep({ allowStop }: { allowStop: boolean }) {
      return exclusive(async () => {
        const outcomes: Array<{ resourceId: string; result: CuaStopResult }> = [];

        for (const resource of store.list()) {
          if (resource.transition.kind !== "stable" || resource.consumers.length === 0) continue;
          const consumers = [];

          for (const consumer of resource.consumers) {
            let status: "finished" | "active" | "unknown";

            try {
              status = await ownerStatus(consumer.ownerThreadId);
            } catch {
              status = "unknown";
            }

            if (status !== "finished") consumers.push(consumer);
          }

          if (consumers.length !== resource.consumers.length)
            save({
              ...resource,
              consumers,
              idleSince: consumers.length === 0 ? now() : null,
              lastHoldReason: null,
            });
        }

        if (!allowStop) return { outcomes };
        const visited = new Set<string>();

        for (const resource of store.list()) {
          const runtimeKey = `${resource.hostId}:${resource.config.home}`;

          if (visited.has(runtimeKey) || !isCuaReleaseDue(resource, now())) continue;
          visited.add(runtimeKey);

          const related = store
            .list(resource.hostId)
            .filter(
              (candidate) =>
                sameCuaRuntime(resource, candidate) && candidate.transition.kind !== "stopped",
            );

          if (
            !related.every(
              (candidate) =>
                isCuaReleaseDue(candidate, now()) &&
                candidate.vm.pid === resource.vm.pid &&
                candidate.vm.startedAt === resource.vm.startedAt,
            )
          ) {
            save({
              ...resource,
              lastHoldReason:
                "Another registered sandbox or consumer retains the shared virtual machine.",
            });
            continue;
          }

          let inspection: CuaInventory;

          try {
            inspection = await host.inspect(resource.hostId, resource.config);
          } catch {
            for (const candidate of related)
              save({ ...candidate, lastHoldReason: "Cua inspection failed before shutdown." });
            continue;
          }

          const observedAt = now();

          const stopInput = {
            config: resource.config,
            vm: resource.vm,
            sandboxes: related.map((candidate) => candidate.sandbox),
          };

          const hold = cuaStopHold(stopInput, inspection);

          if (hold !== null) {
            for (const candidate of related)
              save({
                ...candidate,
                lastHoldReason: hold,
                lastObserved: { at: observedAt, memory: inspection.memory },
              });
            continue;
          }

          const requestedAt = now();

          for (const candidate of related)
            save({
              ...candidate,
              transition: { kind: "stopping", requestedAt },
              lastHoldReason: null,
              lastObserved: { at: observedAt, memory: inspection.memory },
            });
          let result: CuaStopResult;

          try {
            result = await host.stop(resource.hostId, stopInput);
          } catch {
            result = {
              kind: "uncertain",
              reason:
                "The host did not return a verified shutdown outcome. Reconcile before retrying.",
            };
          }

          for (const candidate of related) {
            const transition: CuaResource["transition"] =
              result.kind === "stopped"
                ? { kind: "stopped", completedAt: now() }
                : result.kind === "held"
                  ? { kind: "stable" }
                  : { kind: "uncertain", requestedAt, reason: result.reason };

            save({
              ...candidate,
              transition,
              lastHoldReason: result.kind === "held" ? result.reason : null,
              lastObserved: { at: observedAt, memory: inspection.memory },
            });
            outcomes.push({ resourceId: candidate.id, result });
          }
        }

        return { outcomes };
      });
    },
    settled() {
      return queue;
    },
  };
}

export type CuaService = ReturnType<typeof createCuaService>;
