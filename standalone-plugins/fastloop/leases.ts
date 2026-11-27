import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { type SdkBridge } from "./bridge.js";
import {
  bindingSchema,
  idSchema,
  hostSignals,
  type ContextBinding,
  type JsonPayload,
} from "./contracts.js";
import { PayloadError, sha256 } from "./package-payload.js";
import { bindingFingerprint } from "./binding.js";
import { atomicJSON, HostRuntime, noSymlinkDirectory } from "./runtime.js";

const acceptedSchema = z.object({
  runId: idSchema,
  sessionId: idSchema,
  state: z.enum(["accepted", "running", "completed", "cancelled", "interrupted"]),
});

const requestSchema = z.strictObject({ requestId: idSchema, accepted: acceptedSchema.optional() });

const ledgerSchema = z.strictObject({
  schema: z.literal(1),
  binding: bindingSchema,
  clientId: idSchema,
  dataRoot: z.string().min(1).optional(),
  state: z.enum(["active", "released", "interrupted"]),
  requests: z.array(requestSchema).max(1000),
});

type Ledger = z.infer<typeof ledgerSchema>;

type HostContext = ExperimentalHostRpcContext<typeof hostSignals>;

type Lease = {
  bridge: SdkBridge;
  record: Ledger;
  retention: ExperimentalHostWorkerLease;
  closing: boolean;
  monitor: AbortController;
  closePromise?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  monitors: Set<string>;
};

const terminal = (value: JsonPayload): boolean =>
  z.object({ state: z.enum(["completed", "cancelled", "interrupted"]) }).safeParse(value).success;

export class HostLeaseManager {
  readonly faults = new Map<string, string>();
  private readonly leases = new Map<string, Promise<Lease>>();
  private readonly directory: string;
  private recovery?: Promise<void>;
  private disposing?: Promise<void>;
  constructor(private readonly runtime: Pick<HostRuntime, "dataDir" | "openBridge">) {
    this.directory = join(runtime.dataDir, "leases");
  }

  private validateStorage(record: Ledger): void {
    if (
      record.dataRoot &&
      record.dataRoot !==
        join(this.runtime.dataDir, "projects", sha256(Buffer.from(record.binding.canonicalRoot)))
    )
      throw new PayloadError("DATA_ROOT_CONFLICT");
  }

  private async save(record: Ledger): Promise<void> {
    this.validateStorage(record);
    await atomicJSON(join(this.directory, `${record.clientId}.json`), ledgerSchema.parse(record));
  }

  private async reconcileRecord(record: Ledger, bridge: SdkBridge): Promise<void> {
    for (const request of record.requests) {
      if (!request.accepted) {
        const accepted = await bridge.request("submission", { requestId: request.requestId });

        if (accepted !== null) request.accepted = acceptedSchema.parse(accepted);
      }
    }

    await this.save(record);
  }

  private recover(context: HostContext): Promise<void> {
    this.recovery ??= (async () => {
      await noSymlinkDirectory(this.directory);

      for (const name of await readdir(this.directory)) {
        const ledgerBrand = /^(omnyo|bb)-[a-f0-9]{64}\.json$/.exec(name)?.[1];

        if (ledgerBrand === undefined) throw new PayloadError("RUNTIME_LEASE_LEDGER_INVALID");

        const record = ledgerSchema.parse(
          JSON.parse(await readFile(join(this.directory, name), "utf8")),
        );

        if (record.clientId !== `${ledgerBrand}-${bindingFingerprint(record.binding)}`)
          throw new PayloadError("RUNTIME_LEASE_LEDGER_INVALID");

        this.validateStorage(record);

        if (record.state !== "active") continue;

        const bridge = await this.runtime.openBridge({
          projectRoot: record.binding.canonicalRoot,
          clientId: record.clientId,
          dataRoot: record.dataRoot,
          onExit() {},
        });

        try {
          await this.reconcileRecord(record, bridge);
        } finally {
          await bridge.close();
        }

        record.state = "interrupted";
        await this.save(record);

        for (const request of record.requests)
          if (request.accepted)
            await context.experimental_emitSignal("jobChanged", {
              threadId: record.binding.threadId,
              runId: request.accepted.runId,
            });
      }
    })();

    return this.recovery;
  }

  private async get(binding: ContextBinding, context: HostContext): Promise<Lease> {
    if (this.disposing || context.lifecycle.signal.aborted)
      throw new PayloadError("RUNTIME_HOST_DISPOSING");
    await this.recover(context);
    const clientId = `omnyo-${bindingFingerprint(binding)}`;
    let pending = this.leases.get(clientId);

    if (!pending) {
      pending = (async () => {
        const path = join(this.directory, `${clientId}.json`);
        let record: Ledger;

        try {
          record = ledgerSchema.parse(JSON.parse(await readFile(path, "utf8")));

          if (
            record.clientId !== clientId ||
            bindingFingerprint(record.binding) !== bindingFingerprint(binding)
          )
            throw new PayloadError("RUNTIME_LEASE_LEDGER_INVALID");
          this.validateStorage(record);
          record.state = "active";
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          record = {
            schema: 1,
            binding,
            clientId,
            state: "active",
            requests: [],
            dataRoot: join(
              this.runtime.dataDir,
              "projects",
              sha256(Buffer.from(binding.canonicalRoot)),
            ),
          };
        }

        const retention = context.experimental_retainWorker();
        let lease: Lease | undefined;

        try {
          await this.save(record);

          const bridge = await this.runtime.openBridge({
            projectRoot: binding.canonicalRoot,
            clientId,
            dataRoot: record.dataRoot,
            onExit: () => {
              if (lease && !lease.closing) {
                lease.monitor.abort();
                lease.closePromise = this.recoverExited(lease, context);
                void lease.closePromise.catch(() =>
                  this.faults.set(clientId, "RUNTIME_SCOPE_CLEANUP_UNCERTAIN"),
                );
              }
            },
          });

          lease = {
            bridge,
            record,
            retention,
            closing: false,
            monitor: new AbortController(),
            monitors: new Set(),
          };
          context.lifecycle.signal.addEventListener(
            "abort",
            () => {
              void this.close().catch(() =>
                this.faults.set(clientId, "RUNTIME_SCOPE_CLEANUP_UNCERTAIN"),
              );
            },
            { once: true },
          );

          return lease;
        } catch (error) {
          record.state = "interrupted";

          try {
            await this.save(record);
          } catch {
            this.faults.set(clientId, "RUNTIME_LEASE_LEDGER_WRITE_UNCERTAIN");
          }

          await retention.dispose();
          this.leases.delete(clientId);
          throw error;
        }
      })();
      this.leases.set(clientId, pending);
    }

    const lease = await pending;

    if (lease.closing) {
      if (!lease.closePromise) throw new PayloadError("RUNTIME_SCOPE_CLEANUP_UNCERTAIN");
      await lease.closePromise;

      return this.get(binding, context);
    }

    return lease;
  }

  private async recoverExited(lease: Lease, context: HostContext): Promise<void> {
    lease.closing = true;

    if (lease.idleTimer) clearTimeout(lease.idleTimer);

    const bridge = await this.runtime.openBridge({
      projectRoot: lease.record.binding.canonicalRoot,
      clientId: lease.record.clientId,
      dataRoot: lease.record.dataRoot,
      onExit() {},
    });

    try {
      await this.reconcileRecord(lease.record, bridge);
    } finally {
      await bridge.close();
    }

    lease.record.state = "interrupted";
    await this.save(lease.record);

    for (const request of lease.record.requests)
      if (request.accepted)
        await context.experimental_emitSignal("jobChanged", {
          threadId: lease.record.binding.threadId,
          runId: request.accepted.runId,
        });
    await lease.retention.dispose();
    this.leases.delete(lease.record.clientId);
  }

  private expireIdle(lease: Lease): void {
    if (lease.closing || lease.monitors.size) return;

    if (lease.idleTimer) return;
    lease.idleTimer = setTimeout(() => {
      void this.release(lease.record.binding).catch(() =>
        this.faults.set(lease.record.clientId, "RUNTIME_SCOPE_CLEANUP_UNCERTAIN"),
      );
    }, 60000);
  }

  private async monitor(lease: Lease, runId: string, context: HostContext): Promise<void> {
    if (lease.monitors.has(runId)) return;
    lease.monitors.add(runId);
    let after = 0;

    try {
      while (!lease.monitor.signal.aborted) {
        const batch = z
          .object({ nextSequence: z.number().int().nonnegative(), job: z.json() })
          .parse(await lease.bridge.request("events", { runId: runId, after, waitMs: 10000 }));

        after = batch.nextSequence;

        if (terminal(batch.job)) {
          await context.experimental_emitSignal("jobChanged", {
            threadId: lease.record.binding.threadId,
            runId: runId,
          });

          return;
        }
      }
    } catch (error) {
      if (!lease.closing) {
        this.faults.set(
          lease.record.clientId,
          error instanceof PayloadError ? error.code : "RUNTIME_MONITOR_FAILED",
        );
        await context.experimental_emitSignal("jobChanged", {
          threadId: lease.record.binding.threadId,
          runId: runId,
        });
      }
    } finally {
      lease.monitors.delete(runId);
      this.expireIdle(lease);
    }
  }

  async invoke(
    method: "submit" | "submission" | "result" | "events" | "artifact" | "cancel",
    binding: ContextBinding,
    payload: JsonPayload,
    context: HostContext,
  ): Promise<JsonPayload> {
    context.signal.throwIfAborted();
    const lease = await this.get(bindingSchema.parse(binding), context);

    if (method === "submit") {
      if (!lease.record.dataRoot) throw new PayloadError("DATA_ROOT_CONFLICT");

      if (lease.idleTimer) clearTimeout(lease.idleTimer);
      lease.idleTimer = undefined;
      const parsed = z.object({ requestId: idSchema, submission: z.json() }).parse(payload);
      let request = lease.record.requests.find((item) => item.requestId === parsed.requestId);

      if (!request) {
        request = { requestId: parsed.requestId };
        lease.record.requests.push(request);
        await this.save(lease.record);
      }

      let accepted: z.infer<typeof acceptedSchema>;

      try {
        accepted = acceptedSchema.parse(await lease.bridge.request("submit", parsed));
        request.accepted = accepted;
        await this.save(lease.record);
      } catch (error) {
        await this.release(binding);
        throw error;
      }

      if (context.signal.aborted) {
        await this.release(binding);
        throw new PayloadError("RUNTIME_ADMISSION_CANCELLED");
      }

      void this.monitor(lease, accepted.runId, context).catch(() =>
        this.faults.set(lease.record.clientId, "RUNTIME_SIGNAL_FAILED"),
      );

      return accepted;
    }

    const result = await lease.bridge.request(method, payload);

    if (method === "result") {
      if (terminal(result)) this.expireIdle(lease);
      else {
        const { runId } = z.object({ runId: idSchema }).parse(result);
        void this.monitor(lease, runId, context).catch(() =>
          this.faults.set(lease.record.clientId, "RUNTIME_SIGNAL_FAILED"),
        );
      }
    }

    if (method === "submission") {
      if (result === null) this.expireIdle(lease);
      else {
        const accepted = acceptedSchema.parse(result);
        void this.monitor(lease, accepted.runId, context).catch(() =>
          this.faults.set(lease.record.clientId, "RUNTIME_SIGNAL_FAILED"),
        );
      }
    } else if (method !== "result") {
      const { runId } = z.object({ runId: idSchema }).parse(payload);
      void this.monitor(lease, runId, context).catch(() =>
        this.faults.set(lease.record.clientId, "RUNTIME_SIGNAL_FAILED"),
      );
    }

    return result;
  }

  async retainedRead(
    binding: ContextBinding,
    method: "result" | "artifact",
    payload: JsonPayload,
  ): Promise<JsonPayload> {
    const clientId = `omnyo-${bindingFingerprint(binding)}`;

    const record = ledgerSchema.parse(
      JSON.parse(await readFile(join(this.directory, `${clientId}.json`), "utf8")),
    );

    if (
      record.clientId !== clientId ||
      bindingFingerprint(record.binding) !== bindingFingerprint(binding)
    )
      throw new PayloadError("RUNTIME_LEASE_LEDGER_INVALID");
    this.validateStorage(record);
    const { runId } = z.object({ runId: idSchema }).parse(payload);

    if (!record.requests.some((request) => request.accepted?.runId === runId))
      throw new PayloadError("RUN_NOT_OWNED");

    if (this.leases.has(clientId)) throw new PayloadError("ARCHIVE_COORDINATOR_ACTIVE");

    if (!record.dataRoot) throw new PayloadError("ARCHIVE_STORAGE_DESCRIPTOR_REQUIRED");

    const bridge = await this.runtime.openBridge({
      projectRoot: binding.canonicalRoot,
      clientId,
      dataRoot: record.dataRoot,
      archive: true,
      onExit() {},
    });

    try {
      return await bridge.request(method, payload);
    } finally {
      await bridge.close();
    }
  }

  async release(binding: ContextBinding, context?: HostContext): Promise<JsonPayload> {
    if (context) await this.recover(context);
    const id = `omnyo-${bindingFingerprint(binding)}`;
    const pending = this.leases.get(id);

    if (!pending) return { released: true };
    const lease = await pending;
    lease.closePromise ??= (async () => {
      lease.closing = true;

      if (lease.idleTimer) clearTimeout(lease.idleTimer);
      lease.monitor.abort();
      await lease.bridge.close();
      lease.record.state = "released";
      await this.save(lease.record);
      await lease.retention.dispose();
      this.leases.delete(id);
    })();
    await lease.closePromise;

    return { released: true };
  }

  close(): Promise<void> {
    this.disposing ??= (async () => {
      for (const pending of this.leases.values())
        await this.release((await pending).record.binding);
    })();

    return this.disposing;
  }
}
