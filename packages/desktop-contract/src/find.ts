import { z } from "zod";

export const OMNYO_DESKTOP_MAX_FIND_TEXT_LENGTH = 1024;

export const OMNYO_DESKTOP_MAX_FIND_TOP_OFFSET = 400;

export const omnyoDesktopWindowFindRequestSchema = z
  .object({
    topOffset: z.number().int().min(0).max(OMNYO_DESKTOP_MAX_FIND_TOP_OFFSET),
  })
  .strict();

export type OmnyoDesktopWindowFindRequest = z.infer<
  typeof omnyoDesktopWindowFindRequestSchema
>;
