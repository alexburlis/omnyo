import { z } from "zod";

export const threadOriginKindValues = ["fork", "handoff"] as const;

export const threadOriginKindSchema = z.enum(threadOriginKindValues);

export type ThreadOriginKind = z.infer<typeof threadOriginKindSchema>;
