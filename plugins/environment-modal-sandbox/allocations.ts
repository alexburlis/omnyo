import { errorMessage } from "./error-message.js";
import { createHash } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  ModalOwnershipError,
  readModalOwnershipTagsV1,
  type ModalSandboxClient,
  type ModalSandboxHandle,
} from "./providers/modal/client.js";

const prefix = "allocations/";

const retrySchema = z.object({
  failures: z.number().int().min(0).max(7),
  nextAttemptAt: z.number().finite(),
});

const retryKey = (key: string) => `allocation-retries/${key}`;

const allocationSchema = z
  .object({
    accountIdentity: z.string().min(1),
    appName: z.string().min(1),
    name: z.string().min(1),
    sandboxId: z.string().min(1).nullable(),
    expiresAt: z.number().finite(),
  })
  .strict();

export type ModalAllocation = z.infer<typeof allocationSchema>;

export function modalAllocations(
  api: Pick<PluginApi, "storage" | "log">,
  now: () => number,
) {
  const allocating = new Set<string>();
  const keyForId = (id: string) => `${prefix}sandbox/${id}`;

  const keyForPending = (
    accountIdentity: string,
    appName: string,
    name: string,
  ) =>
    `${prefix}pending/${createHash("sha256")
      .update(JSON.stringify([accountIdentity, appName, name]))
      .digest("hex")}`;

  function readPendingOwner(
    value: unknown,
    expected: Pick<ModalAllocation, "accountIdentity" | "appName" | "name">,
  ) {
    const pending = allocationSchema.parse(value);

    if (
      pending.accountIdentity !== expected.accountIdentity ||
      pending.appName !== expected.appName ||
      pending.name !== expected.name ||
      pending.sandboxId !== null
    )
      throw new ModalOwnershipError(
        "Foreign or malformed pending Modal allocation",
      );

    return pending;
  }

  async function remember(allocation: ModalAllocation & { sandboxId: string }) {
    const key = keyForId(allocation.sandboxId);
    await api.storage.kv.set(key, allocation);

    return key;
  }

  async function remove(key: string) {
    await api.storage.kv.delete(key);
    await api.storage.kv.delete(retryKey(key));
  }

  async function forget(sandboxId: string) {
    await remove(keyForId(sandboxId));
  }

  async function readRetry(key: string) {
    const value = await api.storage.kv.get<unknown>(retryKey(key));

    return value === undefined
      ? { failures: 0, nextAttemptAt: 0 }
      : retrySchema.parse(value);
  }

  return {
    remember,
    forget,
    keys: () => api.storage.kv.list(prefix),
    read: async (key: string) => {
      const value = await api.storage.kv.get<unknown>(key);

      return value === undefined ? null : allocationSchema.parse(value);
    },
    remove,
    async ready(key: string, at: number) {
      return (await readRetry(key)).nextAttemptAt <= at;
    },
    async failed(key: string, at: number) {
      const retry = await readRetry(key);
      await api.storage.kv.set(retryKey(key), {
        failures: Math.min(retry.failures + 1, 7),
        nextAttemptAt:
          at + Math.min(3_600_000, 60_000 * 2 ** Math.min(retry.failures, 6)),
      });
    },
    async succeeded(key: string) {
      if ((await readRetry(key)).failures > 0)
        await api.storage.kv.delete(retryKey(key));
    },
    isAllocating: (key: string) => allocating.has(key),
    wrap(client: ModalSandboxClient): ModalSandboxClient {
      function wrapHandle(sandbox: ModalSandboxHandle): ModalSandboxHandle {
        return {
          ...sandbox,
          async terminate() {
            await sandbox.terminate();

            try {
              if ((await client.fromId(sandbox.sandboxId)) === null)
                await forget(sandbox.sandboxId);
            } catch (error) {
              api.log.warn(
                `Modal stopped ${sandbox.sandboxId}; allocation tracking will retry: ${errorMessage(error)}`,
              );
            }
          },
        };
      }

      return {
        ...client,
        async validateOwnership(appName, name) {
          const accountIdentity = await client.accountIdentity();
          const key = keyForPending(accountIdentity, appName, name);

          if (allocating.has(key))
            throw new ModalOwnershipError(
              "Modal allocation is already pending",
            );
          const value = await api.storage.kv.get<unknown>(key);

          if (value !== undefined) {
            readPendingOwner(value, { accountIdentity, appName, name });

            if ((await client.fromName(appName, name)) === null)
              throw new ModalOwnershipError(
                "Modal allocation outcome is uncertain; retain its pending record for reconciliation",
              );
          }

          await client.validateOwnership(appName, name);
        },

        async create(request) {
          const ownership = readModalOwnershipTagsV1(request.tags);
          const canonicalRequest = { ...request, tags: ownership.tags };

          if (ownership.machineKey === null || ownership.debug)
            return client.create(canonicalRequest);

          if (ownership.machineKey !== request.name)
            throw new ModalOwnershipError(
              "Modal managed name does not match its ownership key",
            );
          const accountIdentity = await client.accountIdentity();

          const key = keyForPending(
            accountIdentity,
            request.appName,
            request.name,
          );

          if (allocating.has(key))
            throw new ModalOwnershipError(
              "Modal allocation is already pending",
            );
          allocating.add(key);

          try {
            const value = await api.storage.kv.get<unknown>(key);

            if (value !== undefined) {
              const pending = readPendingOwner(value, {
                accountIdentity,
                appName: request.appName,
                name: request.name,
              });

              const existing = await client.fromName(
                pending.appName,
                pending.name,
              );

              if (existing === null)
                throw new ModalOwnershipError(
                  "Modal allocation outcome is uncertain; retain its pending record for reconciliation",
                );
              await remember({ ...pending, sandboxId: existing.sandboxId });
              await remove(key);

              return wrapHandle(existing);
            }

            const allocation: ModalAllocation = {
              accountIdentity,
              appName: request.appName,
              name: request.name,
              sandboxId: null,
              expiresAt: now() + request.timeoutMs,
            };

            await api.storage.kv.set(key, allocation);
            const sandbox = await client.create(canonicalRequest);
            await remember({ ...allocation, sandboxId: sandbox.sandboxId });
            await remove(key);

            return wrapHandle(sandbox);
          } finally {
            allocating.delete(key);
          }
        },
        async fromId(id, expectedKey, debug) {
          const sandbox = await client.fromId(id, expectedKey, debug);

          return sandbox === null ? null : wrapHandle(sandbox);
        },
        async fromName(appName, name) {
          const accountIdentity = await client.accountIdentity();
          const key = keyForPending(accountIdentity, appName, name);
          const value = await api.storage.kv.get<unknown>(key);

          const pending =
            value === undefined
              ? null
              : readPendingOwner(value, { accountIdentity, appName, name });

          const sandbox = await client.fromName(appName, name);

          if (sandbox !== null && pending !== null) {
            if (allocating.has(key))
              throw new ModalOwnershipError(
                "Modal allocation is already pending",
              );
            allocating.add(key);

            try {
              await remember({ ...pending, sandboxId: sandbox.sandboxId });
              await remove(key);
            } finally {
              allocating.delete(key);
            }
          }

          return sandbox === null ? null : wrapHandle(sandbox);
        },
        async *listByKey(key) {
          for await (const sandbox of client.listByKey(key))
            yield wrapHandle(sandbox);
        },
      };
    },
  };
}

export type ModalAllocations = ReturnType<typeof modalAllocations>;
