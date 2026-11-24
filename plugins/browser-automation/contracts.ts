import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const idSchema = z.string().min(1).max(160);

export const sessionIdSchema = z.string().uuid();

export const sessionSchema = z
  .object({
    id: sessionIdSchema,
    threadId: idSchema,
    hostId: idSchema,
    backend: z.enum(["desktop", "local"]),
    state: z.enum(["ready", "stopped", "closed"]),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();

export type Session = z.infer<typeof sessionSchema>;

export const selectionSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("local"), hostId: idSchema }).strict(),
  z
    .object({
      backend: z.literal("desktop"),
      hostId: idSchema,
      instanceId: idSchema,
      tabId: idSchema.optional(),
    })
    .strict(),
]);

export const openSchema = z
  .object({ threadId: idSchema, selection: selectionSchema })
  .strict();

export const ownedSchema = z
  .object({ threadId: idSchema, sessionId: sessionIdSchema })
  .strict();

export const runSchema = ownedSchema.extend({
  script: z.string().min(1).max(128_000),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
});

export const screenshotSchema = ownedSchema.extend({
  page: z.string().min(1).max(120).default("main"),
});

export const imageSchema = z
  .object({
    path: z.string().min(1),
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const outputSchema = z
  .object({
    text: z.string().max(160_000),
    images: z.array(imageSchema).max(4),
    exitCode: z.number().int(),
  })
  .strict();

export type RunOutput = z.infer<typeof outputSchema>;

export const previewFrameSchema = z
  .object({
    sequence: z.number().int().positive(),
    targetId: idSchema,
    mimeType: z.literal("image/jpeg"),
    data: z.string().min(1).max(700_000),
    width: z.number().positive(),
    height: z.number().positive(),
    url: z.string().max(2_000),
    title: z.string().max(300),
  })
  .strict();

export type PreviewFrame = z.infer<typeof previewFrameSchema>;

export const previewSizeSchema = z.enum(["thumbnail", "full"]);

export type PreviewSize = z.infer<typeof previewSizeSchema>;

export const previewSchema = ownedSchema.extend({
  afterSequence: z.number().int().nonnegative().default(0),
  size: previewSizeSchema.default("thumbnail"),
});

export const previewOutputSchema = z
  .object({ session: sessionSchema, frame: previewFrameSchema.nullable() })
  .strict();

export type PreviewOutput = z.infer<typeof previewOutputSchema>;

export const viewportPresetSchema = z.enum([
  "phone",
  "tablet",
  "desktop",
  "original",
]);

export const nativeViewportSchema = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
    deviceScaleFactor: z.number().positive().optional(),
    isMobile: z.boolean().optional(),
    hasTouch: z.boolean().optional(),
    isLandscape: z.boolean().optional(),
  })
  .strict()
  .nullable();

export type NativeViewport = z.infer<typeof nativeViewportSchema>;

export const viewportSchema = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
    scrollX: z.number(),
    scrollY: z.number(),
    dpr: z.number().positive(),
    scale: z.number().positive(),
  })
  .strict();

export const visualElementSchema = z
  .object({
    id: idSchema,
    selector: z.string().max(400),
    text: z.string().max(240),
    tag: z.string().max(40),
    rect: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict(),
    styles: z.record(z.string(), z.string().max(160)),
  })
  .strict();

export const visualObservationSchema = z
  .object({
    id: sessionIdSchema,
    targetId: idSchema,
    documentId: sessionIdSchema,
    url: z.string().max(2000),
    title: z.string().max(300),
    viewport: viewportSchema,
    elements: z.array(visualElementSchema).max(512),
  })
  .strict();

export const visualImageSchema = z
  .object({
    path: z.string().min(1),
    hostId: idSchema,
    mimeType: z.literal("image/jpeg"),
    data: z.string().min(1).max(700000),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const targetSchema = ownedSchema.extend({ targetId: idSchema });

export const observeSchema = targetSchema;

export const inspectSchema = targetSchema.extend({
  observationId: sessionIdSchema,
  elementId: idSchema,
});

export const viewportRequestSchema = targetSchema.extend({
  preset: viewportPresetSchema,
});

export const observationOutputSchema = z
  .object({ observation: visualObservationSchema, image: visualImageSchema })
  .strict();

export const inspectOutputSchema = z
  .object({
    observation: visualObservationSchema.omit({ elements: true }),
    element: visualElementSchema,
    image: visualImageSchema,
  })
  .strict();

export type VisualElement = z.infer<typeof visualElementSchema>;

export type VisualObservation = z.infer<typeof visualObservationSchema>;

export type VisualImage = z.infer<typeof visualImageSchema>;

export type ViewportPreset = z.infer<typeof viewportPresetSchema>;

export const rpcContract = defineRpcContract({
  open: { input: openSchema, output: sessionSchema },
  list: {
    input: z.object({ threadId: idSchema }).strict(),
    output: z.array(sessionSchema).max(64),
  },
  run: { input: runSchema, output: outputSchema },
  pages: { input: ownedSchema, output: outputSchema },
  screenshot: { input: screenshotSchema, output: outputSchema },
  preview: { input: previewSchema, output: previewOutputSchema },
  observe: { input: observeSchema, output: observationOutputSchema },
  inspect: { input: inspectSchema, output: inspectOutputSchema },
  viewport: {
    input: viewportRequestSchema,
    output: z
      .object({ preset: viewportPresetSchema, viewport: viewportSchema })
      .strict(),
  },
  stop: { input: ownedSchema, output: sessionSchema },
  close: { input: ownedSchema, output: sessionSchema },
});

export const runtimeStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      version: z.string(),
      source: z.enum(["release", "developer-artifact"]),
    })
    .strict(),
  z.object({ status: z.literal("installing"), detail: z.string() }).strict(),
]);

export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const hostContract = defineRpcContract({
  prepare: { input: z.object({}).strict(), output: runtimeStateSchema },
  open: {
    input: z
      .object({
        sessionId: sessionIdSchema,
        connectionUrl: z.string().url().optional(),
        expiresAt: z.number().int(),
        idleTimeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.null(),
  },
  run: {
    input: z
      .object({
        sessionId: sessionIdSchema,
        script: z.string().min(1).max(128_000),
        timeoutMs: z.number().int().min(1000).max(120_000),
      })
      .strict(),
    output: outputSchema,
  },
  preview: {
    input: z
      .object({
        sessionId: sessionIdSchema,
        afterSequence: z.number().int().nonnegative(),
        waitMs: z.number().int().min(0).max(10_000),
        size: previewSizeSchema,
      })
      .strict(),
    output: z.object({ frame: previewFrameSchema.nullable() }).strict(),
  },
  close: {
    input: z.object({ sessionId: sessionIdSchema }).strict(),
    output: z.null(),
  },
});
