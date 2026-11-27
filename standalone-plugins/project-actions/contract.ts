import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";

const text = z.string().trim().min(1).max(120);

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
    "Use an absolute path",
  );

export const MAX_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** A status check must answer quickly; it is killed after this long. */
export const CHECK_TIMEOUT_MS = 10_000;

const argv = z.array(z.string().max(4096)).min(1).max(64);

const base = { id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/), label: text };

// A quick command, run on the action's machine and folder every `intervalMs` while the
// header is visible, that reports what the action manages: its exit status sets the
// button's dot, and the last line it writes to OMNYO_ACTION_STATUS becomes the dot's text.
const checkSchema = z
  .object({
    argv,
    intervalMs: z.number().int().min(2000).max(600_000).default(5000),
  })
  .strict();

export const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("command"),
      hostId: text,
      cwd: absolutePath,
      argv,
      timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).default(60000),
      check: checkSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("url"),
      url: z
        .url()
        .max(4096)
        .refine(
          (value) => ["http:", "https:"].includes(new URL(value).protocol),
          "Only HTTP(S) URLs are supported",
        ),
    })
    .strict(),
]);

export type Action = z.infer<typeof actionSchema>;

export const actionsSchema = z
  .array(actionSchema)
  .max(12)
  .refine(
    (actions) => new Set(actions.map((action) => action.id)).size === actions.length,
    "Action IDs must be unique",
  );

export const configSchema = z.object({
  revision: z.number().int().nonnegative(),
  actions: actionsSchema,
});

export type Config = z.infer<typeof configSchema>;

export const ACTIVITY_MAX_LENGTH = 160;

export function clipText(text: string) {
  return text.length > ACTIVITY_MAX_LENGTH ? `${text.slice(0, ACTIVITY_MAX_LENGTH - 1)}…` : text;
}

const progressSchema = z.object({
  current: z.number().int().positive(),
  total: z.number().int().positive(),
});

export type Progress = z.infer<typeof progressSchema>;

// A running command reports activity only by writing lines to the file named by
// OMNYO_ACTION_STATUS; its stdout and stderr never leave the host.
const activitySchema = z.object({
  text: z.string().max(ACTIVITY_MAX_LENGTH),
  progress: progressSchema.nullable(),
});

export type Activity = z.infer<typeof activitySchema>;

export const runSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "stopping", "succeeded", "failed", "stopped"]),
  detail: z.string(),
  url: z.string().nullable(),
  startedAt: z.number().nullable(),
  activity: activitySchema.nullable(),
});

export type Run = z.infer<typeof runSchema>;

/**
 * A status check's result. Its exit status sets the tone: 0 `on` (running and current),
 * 1 `off` (not running), 2 `attention` (running, but the action would change something,
 * such as loading a newer build); anything else, a timeout or an unreachable machine is
 * `unknown`.
 */
export const stateSchema = z.object({
  id: z.string(),
  tone: z.enum(["on", "off", "attention", "unknown"]),
  text: z.string().max(ACTIVITY_MAX_LENGTH),
  /** When the check that produced this state started, in epoch milliseconds. */
  checkedAt: z.number(),
});

export type State = z.infer<typeof stateSchema>;

const project = { projectId: text };

export const replaceSchema = z.object({
  ...project,
  revision: z.number().int().nonnegative(),
  actions: actionsSchema,
});

export const rpcContract = defineRpcContract({
  list: {
    input: z.object(project),
    output: configSchema.extend({ runs: z.array(runSchema), states: z.array(stateSchema) }),
  },
  replace: { input: replaceSchema, output: configSchema },
  run: { input: z.object({ ...project, id: text }), output: runSchema },
  stop: { input: z.object({ ...project, id: text }), output: runSchema },
});

export const hostContract = {
  execute: {
    input: z.object({ runId: z.string().min(1), action: actionSchema.options[0] }),
    output: z.object({
      exitCode: z.number().nullable(),
      signal: z.string().nullable(),
      stopped: z.boolean(),
    }),
  },
  stop: {
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ stopped: z.boolean() }),
  },
  check: {
    input: z.object({
      cwd: absolutePath,
      argv,
      timeoutMs: z.number().int().min(100).max(CHECK_TIMEOUT_MS),
    }),
    output: z.object({
      exitCode: z.number().nullable(),
      signal: z.string().nullable(),
      activity: activitySchema.nullable(),
      /** Why the command could not start, such as ENOENT for a missing program or folder. */
      startError: z.string().nullable(),
    }),
  },
};

export const hostSignals = {
  activity: { payload: activitySchema.extend({ runId: z.string().min(1) }) },
};
