import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  automationScriptInterpreterSchema,
  AUTOMATION_SCRIPT_TIMEOUT_MAX_MS,
} from "./rpc-types.js";
import {
  AUTOMATION_SCRIPT_MAX_LENGTH,
  AUTOMATION_SCRIPT_FILE_MAX_LENGTH,
  AUTOMATION_SCRIPT_WORKING_DIRECTORY_MAX_LENGTH,
  isPrintableWorkingDirectoryPath,
} from "./limits.js";

const storedSegment = z
  .string()
  .min(1)
  .max(AUTOMATION_SCRIPT_FILE_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9._-]+$/u)
  .refine((value) => value !== "." && value !== "..");

export const automationScriptHostContract = defineRpcContract({
  executeStoredScript: {
    input: z
      .object({
        automationId: storedSegment,
        runId: z.string().min(1),
        projectId: z.string().min(1),
        scriptFile: storedSegment,
        content: z.string().min(1).max(AUTOMATION_SCRIPT_MAX_LENGTH),
        interpreter: automationScriptInterpreterSchema,
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(AUTOMATION_SCRIPT_TIMEOUT_MAX_MS),
        env: z.record(z.string(), z.string()),
        serverUrl: z.url(),
        workingDirectory: z.discriminatedUnion("type", [
          z.object({ type: z.literal("automation-storage") }).strict(),
          z
            .object({
              type: z.literal("path"),
              path: z
                .string()
                .min(1)
                .max(AUTOMATION_SCRIPT_WORKING_DIRECTORY_MAX_LENGTH)
                .refine(isPrintableWorkingDirectoryPath),
            })
            .strict(),
        ]),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().int().nullable(),
        output: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
      })
      .strict(),
  },
});
