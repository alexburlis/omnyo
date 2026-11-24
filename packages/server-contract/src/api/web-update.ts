import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const filePath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/u)
  .refine(
    (value) =>
      !value.split("/").some((part) => part === "." || part === "..") &&
      !["web-build.json", ".upload.json", ".generation-owner.json"].includes(
        value,
      ),
  );

export const webBuildSchema = z
  .object({
    schema: z.literal(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    compatibilityHash: digest,
    files: z
      .array(
        z
          .object({
            path: filePath,
            size: z
              .number()
              .int()
              .nonnegative()
              .max(32 * 1024 ** 2),
            sha256: digest,
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict()
  .refine(
    (build) =>
      new Set(build.files.map((file) => file.path)).size ===
        build.files.length &&
      build.files.some((file) => file.path === "index.html") &&
      build.files.reduce((size, file) => size + file.size, 0) <=
        256 * 1024 ** 2,
  );

export type WebBuild = z.infer<typeof webBuildSchema>;

export const webUpdateBeginSchema = z
  .object({ build: webBuildSchema, expectedActive: digest.nullable() })
  .strict();

export type WebUpdateBegin = z.infer<typeof webUpdateBeginSchema>;

export const webUpdateUploadSchema = z
  .object({
    uploadId: z.string().uuid(),
    path: filePath,
    content: z.string().max(45 * 1024 ** 2),
  })
  .strict();

export type WebUpdateUpload = z.infer<typeof webUpdateUploadSchema>;

export const webUpdateApplySchema = z
  .object({ uploadId: z.string().uuid(), expectedActive: digest.nullable() })
  .strict();

export type WebUpdateApply = z.infer<typeof webUpdateApplySchema>;

export const webUpdateAbortSchema = z
  .object({ uploadId: z.string().uuid() })
  .strict();

export type WebUpdateAbort = z.infer<typeof webUpdateAbortSchema>;

export const webUpdateRollbackSchema = z
  .object({ expectedActive: digest.nullable() })
  .strict();

export type WebUpdateRollback = z.infer<typeof webUpdateRollbackSchema>;

export const webUpdateIdentitySchema = z
  .object({ id: digest, sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u) })
  .strict();

export type WebUpdateIdentity = z.infer<typeof webUpdateIdentitySchema>;

export interface WebUpdateStatus {
  supported: boolean;
  packagedSourceCommit: string | null;
  compatibilityHash: string | null;
  active: WebUpdateIdentity | null;
  previous: WebUpdateIdentity | null;
  inactiveReason: string | null;
}
