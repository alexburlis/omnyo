import { z } from "zod";

export const managedPreviewLaunchSchema = z
  .object({
    id: z.string().regex(/^prv_[a-zA-Z0-9_-]{8,80}$/u),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    cwd: z.string().min(1).max(16_384),
    argv: z.array(z.string().max(16_384)).min(1).max(256),
    protocol: z.enum(["http:", "https:"]),
    hostname: z.enum(["127.0.0.1", "::1"]),
    port: z.number().int().min(1).max(65_535),
    readinessPath: z
      .string()
      .max(16_384)
      .regex(/^\/(?!\/)[^\r\n#]*$/u),
  })
  .strict();

export type ManagedPreviewLaunch = z.infer<typeof managedPreviewLaunchSchema>;

export const managedPreviewStatusSchema = z
  .object({
    state: z.enum([
      "online",
      "stopped",
      "starting",
      "conflict",
      "error",
      "unknown",
    ]),
    checkedAt: z.number().int().nonnegative(),
    detail: z.string().max(500).nullable(),
    runId: z.string().min(1).nullable(),
  })
  .strict();

export type ManagedPreviewStatus = z.infer<typeof managedPreviewStatusSchema>;
