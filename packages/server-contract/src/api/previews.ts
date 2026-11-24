import { z } from "zod";
import { managedPreviewStatusSchema } from "@omnyo/host-daemon-contract";

export const previewRegisterRequestSchema = z
  .object({
    threadId: z.string().min(1),
    url: z.string().url().max(4096),
    argv: z
      .array(z.string().max(10000))
      .min(1)
      .max(256)
      .refine(
        (argv) => argv[0]?.trim().length,
        "The launch command must not be empty",
      ),
    cwd: z.string().min(1).max(4096).optional(),
    readinessPath: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^\/(?!\/)[^\r\n#]*$/u)
      .optional(),
  })
  .strict();

export type PreviewRegisterRequest = z.infer<
  typeof previewRegisterRequestSchema
>;

export const previewBindingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  environmentId: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  url: z.string(),
  remoteUrl: z.string(),
  createdAt: z.number(),
});

export type PreviewBinding = z.infer<typeof previewBindingSchema>;

export const previewListQuerySchema = z
  .object({ threadId: z.string().min(1) })
  .strict();

export type PreviewListQuery = z.infer<typeof previewListQuerySchema>;

export const previewListResponseSchema = z.object({
  previews: z.array(previewBindingSchema),
  sourceHost: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export type PreviewListResponse = z.infer<typeof previewListResponseSchema>;

export const previewStatusSchema = managedPreviewStatusSchema.extend({
  state: z.enum([
    "online",
    "stopped",
    "starting",
    "conflict",
    "error",
    "unknown",
    "host-offline",
  ]),
});

export type PreviewStatus = z.infer<typeof previewStatusSchema>;

export const previewRestartRequestSchema = z
  .object({ requestId: z.string().min(8).max(128) })
  .strict();

export type PreviewRestartRequest = z.infer<typeof previewRestartRequestSchema>;
