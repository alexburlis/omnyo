import { z } from "zod";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

const absolutePath = z
  .string()
  .min(2)
  .max(4096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"));

export const cuaRuntimeConfig = z.object({
  cuaExecutable: absolutePath,
  colimaExecutable: absolutePath,
  dockerExecutable: absolutePath,
  home: absolutePath,
});

export type CuaRuntimeConfig = z.infer<typeof cuaRuntimeConfig>;

export const cuaMemory = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("footprint"), bytes: z.number().nonnegative() }),
  z.object({ kind: z.literal("unavailable") }),
]);

export const cuaVmIdentity = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1).max(64),
});

export const cuaGuestProcess = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1).max(64),
  executable: z.string().min(1).max(256),
});

export const cuaSandboxIdentity = z.object({
  name,
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
  processes: z.array(cuaGuestProcess).max(1024),
});

export type CuaSandboxIdentity = z.infer<typeof cuaSandboxIdentity>;

export const cuaContainer = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name,
  kind: z.enum(["sandbox", "helper", "unknown"]),
  publishedPorts: z.array(z.number().int().min(1).max(65535)).max(32),
});

export const cuaInventory = z.object({
  config: cuaRuntimeConfig,
  vm: cuaVmIdentity.nullable(),
  sandboxes: z.array(cuaSandboxIdentity).max(256),
  containers: z.array(cuaContainer).max(256),
  activeClientPorts: z.array(z.number().int().min(1).max(65535)).max(128),
  memory: cuaMemory,
});

export type CuaInventory = z.infer<typeof cuaInventory>;

export const cuaConsumer = z.object({
  id: name,
  ownerThreadId: name,
  acquiredAt: z.number().int().nonnegative(),
});

export const cuaResource = z.object({
  id: z.string().uuid(),
  hostId: name,
  ownerThreadId: name,
  ownership: z.enum(["managed", "observed"]),
  config: cuaRuntimeConfig,
  vm: cuaVmIdentity,
  sandbox: cuaSandboxIdentity,
  consumers: z.array(cuaConsumer).max(256),
  keepRequested: z.boolean(),
  idleGraceMs: z.number().int().min(60_000).max(86_400_000),
  idleSince: z.number().int().nonnegative().nullable(),
  lastHoldReason: z.string().nullable(),
  lastObserved: z.object({ at: z.number().int().nonnegative(), memory: cuaMemory }),
  transition: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("stable") }),
    z.object({ kind: z.literal("stopping"), requestedAt: z.number().int().nonnegative() }),
    z.object({ kind: z.literal("stopped"), completedAt: z.number().int().nonnegative() }),
    z.object({
      kind: z.literal("uncertain"),
      requestedAt: z.number().int().nonnegative(),
      reason: z.string(),
    }),
  ]),
  registeredAt: z.number().int().nonnegative(),
});

export type CuaResource = z.infer<typeof cuaResource>;

export const cuaResourceView = cuaResource.extend({
  retentionReason: z.enum([
    "observed-only",
    "consumer-active",
    "kept",
    "idle-grace",
    "ready",
    "blocked",
    "stopping",
    "stopped",
    "uncertain",
  ]),
  nextStopAt: z.number().int().nonnegative().nullable(),
});

export type CuaResourceView = z.infer<typeof cuaResourceView>;

export const cuaRegistration = z.object({
  hostId: name,
  ownerThreadId: name,
  initialConsumerId: name,
  ownership: z.enum(["managed", "observed"]).default("observed"),
  sandboxName: name,
  idleGraceMs: z.number().int().min(60_000).max(86_400_000).default(300_000),
});

export type CuaRegistration = z.infer<typeof cuaRegistration>;

export const cuaConsumerAction = z.object({
  resourceId: z.string().uuid(),
  consumerId: name,
  ownerThreadId: name,
});

export type CuaConsumerAction = z.infer<typeof cuaConsumerAction>;

export const cuaKeepAction = z.object({
  resourceId: z.string().uuid(),
  ownerThreadId: name,
  keep: z.boolean(),
});

export const cuaReconcileAction = z.object({ resourceId: z.string().uuid(), ownerThreadId: name });

export const cuaStopInput = z.object({
  config: cuaRuntimeConfig,
  vm: cuaVmIdentity,
  sandboxes: z.array(cuaSandboxIdentity).min(1).max(256),
});

export type CuaStopInput = z.infer<typeof cuaStopInput>;

export const cuaStopResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stopped") }),
  z.object({ kind: z.literal("held"), reason: z.string() }),
  z.object({ kind: z.literal("uncertain"), reason: z.string() }),
]);

export type CuaStopResult = z.infer<typeof cuaStopResult>;

export const cuaHostContract = {
  cuaInspect: { input: z.object({ config: cuaRuntimeConfig.optional() }), output: cuaInventory },
  cuaStop: { input: cuaStopInput, output: cuaStopResult },
  cuaReconcile: {
    input: z.object({ vm: cuaVmIdentity }),
    output: z.enum(["running", "stopped", "unknown"]),
  },
} as const;

export const cuaRpcContract = {
  cuaRegister: { input: cuaRegistration, output: cuaResourceView },
  cuaAcquire: { input: cuaConsumerAction, output: cuaResourceView },
  cuaRelease: { input: cuaConsumerAction, output: cuaResourceView },
  cuaKeep: { input: cuaKeepAction, output: cuaResourceView },
  cuaReconcile: { input: cuaReconcileAction, output: cuaResourceView },
  cuaList: {
    input: z.object({ hostId: name.optional() }),
    output: z.object({ resources: z.array(cuaResourceView) }),
  },
  cuaObserve: { input: z.object({ hostId: name }), output: cuaInventory },
} as const;
