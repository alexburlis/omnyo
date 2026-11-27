import { cliCommand, PluginCliError, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { idSchema, type JsonPayload } from "./contracts.js";
import {
  type Caller,
  type Selectors,
  parseRequirementsJSON,
  selectCallerContext,
  RoutingError,
} from "./routing.js";
import { changeSchema, runSchema, verifySchema, submitSchema } from "./requests.js";

export interface CommandPort {
  submit(
    caller: Caller,
    selectors: Selectors,
    submission: z.infer<typeof submitSchema>,
    requestId: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<JsonPayload>;
  read(
    method: "result" | "events" | "cancel",
    caller: Caller,
    selectors: Selectors,
    payload: JsonPayload,
    signal: AbortSignal,
  ): Promise<JsonPayload>;
}

const waiting = { requestId: idSchema, waitMs: z.number().int().min(0).max(3000).default(1000) };

const runInput = z.strictObject({ ...waiting, request: runSchema });

const verifyInput = z.strictObject({ ...waiting, request: verifySchema });

const handleInput = z.strictObject({ runId: idSchema });

const owner = (context: Parameters<Parameters<typeof cliCommand>[0]["run"]>[1]): Caller => ({
  kind: "owner",
  surface: "cli",
  inherited: context,
});

function parseCli<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RoutingError)
      throw new PluginCliError(error.message, { code: error.code.toLowerCase() });

    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new PluginCliError("Invalid FastLoop request", { code: "request_invalid" });
    throw error;
  }
}

function cliSelectors(
  context: Parameters<Parameters<typeof cliCommand>[0]["run"]>[1],
  threadId?: string,
): Selectors {
  try {
    return selectCallerContext(owner(context), { threadId });
  } catch (error) {
    if (error instanceof RoutingError)
      throw new PluginCliError(error.message, { code: error.code.toLowerCase() });
    throw error;
  }
}

export function registerTools(api: PluginApi, port: CommandPort): void {
  api.agents.registerTool({
    name: "fastloop_run",
    description:
      "Run bounded browser navigation or exploration in this thread's current workspace. Return canonical evidence or an owned asynchronous handle. Use a unique requestId and preserve it for an explicit retry.",
    parameters: runInput,
    execute: (input, context) =>
      port
        .submit(
          { kind: "native_tool", context },
          {},
          { kind: "run", request: input.request },
          input.requestId,
          input.waitMs,
          context.signal,
        )
        .then((value) => JSON.stringify(value)),
  });
  api.agents.registerTool({
    name: "fastloop_verify",
    description:
      "Verify explicit required functional or visual requirements. Recheck after an edit using the original sessionId/previousRunId and explicit change context; preserve every check's meaning.",
    parameters: verifyInput,
    execute: (input, context) =>
      port
        .submit(
          { kind: "native_tool", context },
          {},
          { kind: "verify", request: input.request },
          input.requestId,
          input.waitMs,
          context.signal,
        )
        .then((value) => JSON.stringify(value)),
  });
  api.agents.registerTool({
    name: "fastloop_result",
    description: "Read this thread's canonical owned run result and evidence references.",
    parameters: handleInput,
    execute: (input, context) =>
      port
        .read("result", { kind: "native_tool", context }, {}, input, context.signal)
        .then((value) => JSON.stringify(value)),
  });
  api.agents.registerTool({
    name: "fastloop_cancel",
    description:
      "Cancel this thread's owned FastLoop run. Cancellation does not undo an already dispatched effect.",
    parameters: handleInput,
    execute: (input, context) =>
      port
        .read("cancel", { kind: "native_tool", context }, {}, input, context.signal)
        .then((value) => JSON.stringify(value)),
  });
  api.agents.configure(() => ({
    tools: ["fastloop_run", "fastloop_verify", "fastloop_result", "fastloop_cancel"],
    skills: ["fastloop"],
    instructions:
      "Use FastLoop's native tools for browser work in this Omnyo thread. Do not also submit the same job through MCP or CLI. Use the FastLoop panel for evidence. A completed exploration is not a passing verification. Supply an explicit change after editing and retain the prior session/check scope.",
  }));
}

function exitCode(value: JsonPayload): number {
  const job = z
    .object({
      state: z.string(),
      result: z.object({ verdict: z.string(), completion: z.string() }).optional(),
    })
    .safeParse(value);

  if (!job.success || !job.data.result) return 0;

  if (job.data.result.verdict === "CANCELLED") return 130;

  if (job.data.result.verdict === "FAILED") return 1;

  return job.data.result.verdict === "PASSED" &&
    job.data.result.completion === "objective_completed"
    ? 0
    : 2;
}

const commonOptions = {
  thread: { type: "string", description: "Owner-selected thread" },
  "request-id": {
    type: "string",
    required: true,
    description: "Unique stable idempotency identifier",
  },
  url: { type: "string", required: true, description: "Explicit browser URL" },
  goal: { type: "string", required: true, description: "Caller-owned goal" },
  session: { type: "string", description: "Original owned browser session" },
  "previous-run": { type: "string", description: "Original owned run for a recheck" },
  "wait-ms": {
    type: "integer",
    min: 0,
    max: 3000,
    default: 1000,
    description: "Bounded foreground wait",
  },
} satisfies Parameters<typeof cliCommand>[0]["options"];

export function browserCommands(port: CommandPort) {
  return {
    run: cliCommand({
      summary: "Navigate or explore in an owned browser session",
      options: {
        ...commonOptions,
        mode: {
          type: "enum",
          values: ["navigate", "explore"],
          required: true,
          description: "Explicit run mode",
        },
      },
      async run({ options }, context) {
        const request = parseCli(() =>
          runSchema.parse({
            url: options.url,
            goal: options.goal,
            mode: options.mode,
            sessionId: options.session,
            previousRunId: options["previous-run"],
          }),
        );

        const result = await port.submit(
          owner(context),
          cliSelectors(context, options.thread),
          { kind: "run", request },
          options["request-id"],
          options["wait-ms"],
          AbortSignal.timeout(14000),
        );

        return { exitCode: exitCode(result), stdout: JSON.stringify(result) };
      },
    }),
    verify: cliCommand({
      summary: "Verify bounded inline requirements, including an explicit edit context for recheck",
      options: {
        ...commonOptions,
        "requirements-json": {
          type: "string",
          required: true,
          stdin: true,
          description:
            "One compact non-secret JSON line up to16KiB; --requirements-json-stdin reads on the invoking machine",
        },
        "change-json": {
          type: "string",
          description:
            "Explicit non-secret ChangeContext JSON: changeId/files/baseRef/buildId/optional bounded patch",
        },
      },
      async run({ options }, context) {
        const request = parseCli(() =>
          verifySchema.parse({
            url: options.url,
            goal: options.goal,
            sessionId: options.session,
            previousRunId: options["previous-run"],
            requirements: parseRequirementsJSON(options["requirements-json"]),
            change: options["change-json"]
              ? changeSchema.parse(JSON.parse(options["change-json"]))
              : undefined,
          }),
        );

        const result = await port.submit(
          owner(context),
          cliSelectors(context, options.thread),
          { kind: "verify", request },
          options["request-id"],
          options["wait-ms"],
          AbortSignal.timeout(14000),
        );

        return { exitCode: exitCode(result), stdout: JSON.stringify(result) };
      },
    }),
    result: cliCommand({
      summary: "Read the canonical owned result",
      options: {
        thread: { type: "string", description: "Owner-selected thread" },
        run: { type: "string", required: true, description: "Owned run ID" },
      },
      async run({ options }, context) {
        const result = await port.read(
          "result",
          owner(context),
          cliSelectors(context, options.thread),
          { runId: options.run },
          AbortSignal.timeout(14000),
        );

        return { exitCode: exitCode(result), stdout: JSON.stringify(result) };
      },
    }),
    events: cliCommand({
      summary: "Read bounded ordered run events",
      options: {
        thread: { type: "string", description: "Owner-selected thread" },
        run: { type: "string", required: true, description: "Owned run ID" },
        after: {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          default: 0,
          description: "After sequence",
        },
        "wait-ms": {
          type: "integer",
          min: 0,
          max: 10000,
          default: 0,
          description: "Bounded event wait",
        },
      },
      async run({ options }, context) {
        const result = await port.read(
          "events",
          owner(context),
          cliSelectors(context, options.thread),
          { runId: options.run, after: options.after, waitMs: options["wait-ms"] },
          AbortSignal.timeout(14000),
        );

        return { exitCode: 0, stdout: JSON.stringify(result) };
      },
    }),
    cancel: cliCommand({
      summary: "Cancel one owned run without claiming effects were undone",
      options: {
        thread: { type: "string", description: "Owner-selected thread" },
        run: { type: "string", required: true, description: "Owned run ID" },
      },
      async run({ options }, context) {
        const result = await port.read(
          "cancel",
          owner(context),
          cliSelectors(context, options.thread),
          { runId: options.run },
          AbortSignal.timeout(14000),
        );

        return { exitCode: 0, stdout: JSON.stringify(result) };
      },
    }),
  };
}
