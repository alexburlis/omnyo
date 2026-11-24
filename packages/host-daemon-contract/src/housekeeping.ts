import { retainedProviderSessionSchema } from "@omnyo/domain";
import { z } from "zod";

export const memoryPressureSampleSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    level: z.enum(["normal", "warning", "critical"]),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["unsupported-platform", "read-failed", "invalid-result"]),
  }),
]);

export type MemoryPressureSample = z.infer<typeof memoryPressureSampleSchema>;

export const hostHousekeepingStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-run") }),
  z.object({
    status: z.literal("complete"),
    checkedAt: z.number().nonnegative(),
    memoryPressure: memoryPressureSampleSchema,
    idleGraceMs: z.number().nonnegative(),
    reapedSessions: z.array(
      z.object({
        environmentId: z.string(),
        threadId: z.string(),
        providerId: z.string(),
        idleForMs: z.number().nonnegative(),
      }),
    ),
    retainedSessions: z.array(
      retainedProviderSessionSchema.extend({
        environmentId: z.string(),
        memory: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("observed"),
            source: z.literal("rss"),
            bytes: z.number().nonnegative(),
          }),
          z.object({ status: z.literal("unavailable") }),
        ]),
      }),
    ),
  }),
  z.object({
    status: z.literal("failed"),
    checkedAt: z.number().nonnegative(),
    memoryPressure: memoryPressureSampleSchema,
    idleGraceMs: z.number().nonnegative(),
  }),
]);

export type HostHousekeepingStatus = z.infer<
  typeof hostHousekeepingStatusSchema
>;
