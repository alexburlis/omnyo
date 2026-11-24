import { z } from "zod";

export const injectedSkillMetadataSchema = z
  .object({
    name: z
      .string()
      .max(64)
      .regex(
        /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u,
        "Skill name must use lowercase letters, numbers, and single hyphens",
      ),
    description: z
      .string()
      .max(1024)
      .refine((value) => value.trim().length > 0, {
        message: "Skill description must be non-empty",
      }),
  })
  .passthrough();
