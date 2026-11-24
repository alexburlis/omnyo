import { z } from "zod";
import { OMNYO_DESKTOP_MAX_FIND_TEXT_LENGTH } from "@omnyo/desktop-contract";

export const OMNYO_DESKTOP_FIND_BAR_QUERY_CHANNEL =
  "omnyo-desktop:find-bar:query";

export const OMNYO_DESKTOP_FIND_BAR_STEP_CHANNEL =
  "omnyo-desktop:find-bar:step";

export const OMNYO_DESKTOP_FIND_BAR_CLOSE_CHANNEL =
  "omnyo-desktop:find-bar:close";

export const OMNYO_DESKTOP_FIND_BAR_RESULT_CHANNEL =
  "omnyo-desktop:find-bar:result";

export const OMNYO_DESKTOP_FIND_BAR_ACTIVATE_CHANNEL =
  "omnyo-desktop:find-bar:activate";

export const findBarQueryRequestSchema = z
  .object({
    text: z.string().max(OMNYO_DESKTOP_MAX_FIND_TEXT_LENGTH),
  })
  .strict();

export type FindBarQueryRequest = z.infer<typeof findBarQueryRequestSchema>;

export const findBarStepRequestSchema = z
  .object({
    forward: z.boolean(),
  })
  .strict();

export type FindBarStepRequest = z.infer<typeof findBarStepRequestSchema>;

export const findBarResultSchema = z
  .object({
    activeMatchOrdinal: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
  })
  .strict();

export type FindBarResult = z.infer<typeof findBarResultSchema>;
