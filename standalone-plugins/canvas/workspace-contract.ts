import { z } from "zod";
import { boardAddressSchema } from "./board-contract";
import {
  sourceCredentialInputSchema,
  sourceInputSchema,
  sourceListOutputSchema,
  sourceStateSchema,
  datasetPushInputSchema,
} from "./source-contract";

const thread = boardAddressSchema;

const identified = thread.safeExtend({ id: z.string().min(1).max(40) });

export const renderReportSchema = z
  .object({
    nodeId: z.string().min(1).max(40),
    sectionId: z
      .string()
      .regex(/^sec_[a-z0-9_-]+$/u)
      .optional(),
    nodeRevision: z.number().int().nonnegative(),
    sourceRevision: z.number().int().nonnegative().nullable().default(null),
    boardRevision: z.number().int().nonnegative(),
    capturedAt: z.number().finite().nonnegative(),
    mode: z.enum(["board", "outline"]),
    zoom: z.number().finite().positive(),
    view: z.string().max(40),
    bounds: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
    }),
    text: z.string().max(4000),
    issues: z.array(z.string().max(180)).max(30),
    ready: z.boolean(),
  })
  .strict();

export type RenderReport = z.infer<typeof renderReportSchema>;

export const renderVerificationSchema = z.object({
  report: renderReportSchema.nullable(),
  current: z.boolean(),
  issues: z.array(z.string()),
});

export type RenderVerification = z.infer<typeof renderVerificationSchema>;

export const workspaceRpc = {
  "render.report": {
    input: thread.safeExtend({ reports: z.array(renderReportSchema).max(200) }),
    output: z.object({ accepted: z.number().int() }),
  },
  "node.verify": { input: identified, output: renderVerificationSchema },
  "source.list": { input: thread, output: sourceListOutputSchema },
  "source.put": {
    input: thread.safeExtend({ source: sourceInputSchema }),
    output: sourceStateSchema,
  },
  "source.refresh": { input: identified, output: sourceStateSchema },
  "source.pause": {
    input: identified.extend({ paused: z.boolean() }),
    output: sourceStateSchema,
  },
  "source.push": {
    input: thread.safeExtend(datasetPushInputSchema.shape),
    output: sourceStateSchema,
  },
  "source.credential": {
    input: thread.safeExtend(sourceCredentialInputSchema.shape),
    output: z.object({ slot: z.string(), configured: z.boolean() }),
  },
};
