import { z } from "zod";

export const workflowImportReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("share"),
      shareId: z.string().regex(/^[a-f0-9]{32}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      filename: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[^/\\]+\.omnyoworkflow$/i),
      text: z
        .string()
        .max(256 * 1024)
        .refine(
          (text) => new TextEncoder().encode(text).byteLength <= 256 * 1024,
        ),
    })
    .strict(),
]);

export type WorkflowImportReference = z.infer<
  typeof workflowImportReferenceSchema
>;
