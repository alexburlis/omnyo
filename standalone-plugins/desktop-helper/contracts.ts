import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const nativeProtocol = 1;

const permissionSchema = z.enum(["accessibility", "screen-capture"]);

export const nativeCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }).strict(),
  z.object({ command: z.literal("probe") }).strict(),
  z.object({ command: z.literal("request-permissions"), permission: permissionSchema }).strict(),
  z.object({ command: z.literal("shutdown") }).strict(),
]);

const axSchema = z.object({
  status: z.string().max(100),
  role: z.string().max(100).optional(),
  label: z.string().max(160).optional(),
  pid: z.number().int().optional(),
  code: z.number().int().optional(),
});

export const nativeEventSchema = z.object({
  protocol: z.literal(1),
  id: z.string().max(100).optional(),
  event: z.enum([
    "status",
    "permission",
    "probe",
    "hotkey",
    "cleanup",
    "error",
    "fixture",
    "click",
  ]),
  pid: z.number().int().optional(),
  parentPid: z.number().int().optional(),
  identity: z
    .object({
      verified: z.boolean(),
      bundleId: z.string().optional(),
      teamId: z.string().optional(),
    })
    .optional(),
  console: z
    .object({
      active: z.boolean(),
      uid: z.number().int(),
      consoleUid: z.number().int().optional(),
      reason: z.string().max(100).optional(),
    })
    .optional(),
  os: z.string().max(200).optional(),
  accessibility: z.boolean().optional(),
  screenCapture: z.boolean().optional(),
  panel: z.boolean().optional(),
  hotkey: z.boolean().optional(),
  observation: z.boolean().optional(),
  capturePending: z.boolean().optional(),
  permission: permissionSchema.optional(),
  granted: z.boolean().optional(),
  reason: z.string().max(200).optional(),
  status: z.string().max(100).optional(),
  code: z.number().int().optional(),
  ax: axSchema.optional(),
  windowId: z.number().int().positive().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024)
    .optional(),
  image: z.string().max(1024).optional(),
  monitors: z.number().int().nonnegative().optional(),
  window: z.boolean().optional(),
  count: z.number().int().nonnegative().optional(),
});

export type NativeEvent = z.infer<typeof nativeEventSchema>;

export const nativeResultSchema = z.object({
  workerPid: z.number().int(),
  uid: z.number().int(),
  operation: nativeCommandSchema,
  events: z.array(nativeEventSchema).max(32),
  helperPid: z.number().int().nullable(),
  fixturePid: z.number().int().nullable(),
  helperExited: z.boolean(),
  fixtureExited: z.boolean(),
});

/** The RPC caller names the enrolled Mac that runs the native probe. */
export const nativeRpcInputSchema = z
  .object({ hostId: z.string().min(1).max(100), operation: nativeCommandSchema })
  .strict();

export const hostContract = defineRpcContract({
  native: { input: nativeCommandSchema, output: nativeResultSchema },
});

export const rpcContract = defineRpcContract({
  native: {
    experimental_description:
      "Run the bounded signed Desktop Helper native boundary probe on the capture Mac. Permission requests are explicit; no background observation starts on load.",
    input: nativeRpcInputSchema,
    output: nativeResultSchema,
  },
});
