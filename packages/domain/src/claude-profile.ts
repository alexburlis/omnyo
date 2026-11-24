import { z } from "zod";

export const claudeProfileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unprofiled") }).strict(),
  z
    .object({
      kind: z.literal("profile"),
      profileId: z.uuid(),
    })
    .strict(),
]);

export type ClaudeProfileSelection = z.infer<
  typeof claudeProfileSelectionSchema
>;

export const claudeProfileBindingSchema = z
  .object({ profileId: z.uuid(), hostId: z.string().min(1) })
  .strict();

export type ClaudeProfileBinding = z.infer<typeof claudeProfileBindingSchema>;
