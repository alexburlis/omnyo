import { z } from "zod";

export const omnyoDesktopServerChoiceSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1),
    active: z.boolean(),
  })
  .strict();

export const omnyoDesktopServerChoicesSchema = z.array(
  omnyoDesktopServerChoiceSchema,
);

export type OmnyoDesktopServerChoice = z.infer<
  typeof omnyoDesktopServerChoiceSchema
>;
