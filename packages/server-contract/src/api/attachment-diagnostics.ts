import { z } from "zod";

const byteCountSchema = z
  .number()
  .int()
  .min(0)
  .max(1024 * 1024 * 1024);

export const attachmentDiagnosticSchema = z
  .object({
    occurredAt: z.number().int().min(0).max(8_640_000_000_000_000),
    clientBundle: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,96}\.js$/u)
      .nullable(),
    userAgentFamily: z.enum([
      "desktop",
      "bb-desktop",
      "ios",
      "android",
      "chrome",
      "safari",
      "firefox",
      "other",
    ]),
    cause: z.enum(["empty_before_upload", "empty_on_server"]),
    source: z.enum(["paste", "other"]),
    mimeType: z
      .string()
      .regex(/^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/u)
      .nullable(),
    extension: z
      .string()
      .regex(/^[a-z0-9]{1,16}$/u)
      .nullable(),
    sizeAtUpload: byteCountSchema,
    sizeAtPaste: byteCountSchema.nullable(),
    readableBytes: byteCountSchema.nullable(),
    readError: z
      .enum(["not_readable", "not_found", "aborted", "other"])
      .nullable(),
    msSincePaste: z.number().int().min(0).max(86_400_000).nullable(),
    msSinceLastModified: z.number().int().min(0).max(86_400_000).nullable(),
    clipboardTypes: z
      .array(z.string().regex(/^[A-Za-z0-9.+/_-]{1,64}$/u))
      .max(16)
      .nullable(),
    pastedFileCount: z.number().int().min(0).max(1000).nullable(),
    nativeResolver: z.boolean().nullable(),
    nativePath: z.boolean().nullable(),
    replayed: z.boolean().nullable(),
  })
  .strict();

export type AttachmentDiagnostic = z.infer<typeof attachmentDiagnosticSchema>;
