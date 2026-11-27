import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { layoutTraceSchema, storedLayoutTraceSchema } from "./diagnostics-contract.ts";
import {
  tagDescriptionSchema,
  tagIconSchema,
  tagIdSchema,
  tagLabelSchema,
  tagPatchSchema,
  tagRecordSchema,
  tagSchema,
} from "./tags.ts";

const tagsOutput = z.object({ tags: z.array(tagSchema) });

export const rpcContract = defineRpcContract({
  "diagnostics.record": {
    input: z.object({ trace: layoutTraceSchema }).strict(),
    output: z.object({ stored: z.literal(true) }),
  },
  "diagnostics.list": {
    input: z.object({}).strict(),
    output: z.object({ traces: z.array(storedLayoutTraceSchema).max(8) }),
  },
  status: {
    input: z.object({}),
    output: z.object({ activatedAt: z.number(), liveChats: z.number(), withTag: z.number() }),
  },
  "tags.list": { input: z.object({}), output: tagsOutput },
  "tag.set": {
    input: z.object({ threadId: z.string().min(1), tagId: z.string().min(1).nullable() }),
    output: tagRecordSchema,
  },
  "tag.suggest": {
    input: z.object({ threadId: z.string().min(1), tagId: z.string().min(1).nullable() }),
    output: z.object({ applied: z.boolean() }),
  },
  "tags.add": {
    input: z.object({
      id: tagIdSchema,
      label: tagLabelSchema,
      icon: tagIconSchema,
      description: tagDescriptionSchema.default(""),
    }),
    output: tagsOutput,
  },
  "tags.update": {
    input: z.object({ id: z.string().min(1), patch: tagPatchSchema }),
    output: tagsOutput,
  },
  "tags.remove": { input: z.object({ id: z.string().min(1) }), output: tagsOutput },
  "tags.move": {
    input: z.object({ id: z.string().min(1), index: z.number().int().nonnegative() }),
    output: tagsOutput,
  },
});
