import { z } from "zod";
import { tagSchema } from "./tags.ts";

export const CHANGED_CHANNEL = "chat-topics-changed";

export const changedPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("threads"), threadIds: z.array(z.string()) }),
  z.object({ kind: z.literal("tags"), tags: z.array(tagSchema) }),
]);

export type ChangedPayload = z.input<typeof changedPayloadSchema>;
