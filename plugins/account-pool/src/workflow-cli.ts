import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { withNativeWorkflowAccount } from "./native-workflow-eligibility.js";
import {
  workflowRequest,
  workflowResponse,
  WorkflowResponseFailure,
} from "./workflow-transport.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  NativeSession,
  PREDICTION_POOL_MODEL_PROVIDER,
} from "./prediction-native.js";
import {
  CLAUDE_WORKFLOW_UNAVAILABLE,
  WORKFLOW_SYSTEM_PROMPT,
  workflowHostContract,
} from "./workflow-contract.js";

const hostInput = workflowHostContract.workflowModelComplete.input;

type Input = z.infer<typeof hostInput>;

type RoutedInput = Omit<Input, "route"> & {
  route: { kind: "pool"; baseUrl: string; capability: string };
};

const started = z.object({
  thread: z.object({ id: z.string() }),
  model: z.string(),
  modelProvider: z.string(),
});

const itemEvent = z.object({
  threadId: z.string(),
  item: z.object({ type: z.string(), text: z.string().optional() }),
});

const completion = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.string() }),
});

async function codexText(
  input: RoutedInput,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const session = await NativeSession.open(
    process.env.OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND?.trim() || "codex",
    directory,
    signal,
    input.route,
    directory,
    "workflow",
  );

  try {
    const thread = await session.request(
      "thread/start",
      {
        model: input.model,
        modelProvider: PREDICTION_POOL_MODEL_PROVIDER,
        cwd: directory,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: WORKFLOW_SYSTEM_PROMPT,
        config: {
          "agents.enabled": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
          "features.goals": false,
          "features.skip_host_skill_discovery": true,
          "features.hooks": false,
          "features.apps": false,
          "features.skill_search": false,
          "features.enable_mcp_apps": false,
          project_doc_max_bytes: 0,
          "features.shell_tool": false,
          "features.apply_patch_freeform": false,
          "tools.experimental_request_user_input.enabled": false,
          "tools.update_plan.enabled": false,
          web_search: "disabled",
        },
      },
      started,
    );

    if (
      thread.model !== input.model ||
      thread.modelProvider !== PREDICTION_POOL_MODEL_PROVIDER
    )
      throw new Error("Workflow CLI changed the selected model or route.");
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;

    const done = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });

    void done.catch(() => {});
    let output = "";
    const abort = () => reject(new Error("Workflow request cancelled."));
    signal.addEventListener("abort", abort, { once: true });

    const unsubscribe = session.onNotification(({ method, params }) => {
      if (method === "item/started" || method === "item/completed") {
        const parsed = itemEvent.safeParse(params);

        if (parsed.success && parsed.data.threadId === thread.thread.id) {
          if (
            !["agentMessage", "userMessage", "reasoning"].includes(
              parsed.data.item.type,
            )
          ) {
            reject(new Error("Workflow CLI attempted a non-text operation."));
            throw new Error("Workflow CLI attempted a non-text operation.");
          }

          if (
            method === "item/completed" &&
            parsed.data.item.type === "agentMessage"
          ) {
            output += parsed.data.item.text ?? "";

            if (Buffer.byteLength(output, "utf8") > input.maxOutputBytes) {
              reject(new Error("Workflow output exceeded its limit."));
              throw new Error("Workflow output exceeded its limit.");
            }
          }
        }
      }

      if (method === "turn/completed") {
        const parsed = completion.safeParse(params);

        if (parsed.success && parsed.data.threadId === thread.thread.id) {
          if (parsed.data.turn.status === "completed" && output.trim())
            resolve(output);
          else
            reject(new Error("Workflow CLI did not complete text generation."));
        }
      }
    });

    try {
      await session.request(
        "turn/start",
        {
          threadId: thread.thread.id,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
          effort: "low",
          environments: [],
        },
        z.object({ turn: z.object({ id: z.string() }) }),
      );

      return await done;
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    }
  } finally {
    await session.close();
  }
}

type WorkflowStage =
  | "route"
  | "request"
  | "allowance"
  | "connection"
  | "provider"
  | "response"
  | "cli";

class WorkflowExecutionFailure extends Error {
  constructor(
    stage: WorkflowStage,
    status?: number,
    parameter?: string,
    responseReason?: string,
  ) {
    super(
      `Workflow text failed at ${stage}${status === undefined ? "" : ` (HTTP ${status}${parameter ? `; parameter=${parameter}` : ""}${responseReason ? `; ${responseReason}` : ""})`}.`,
    );
  }
}

async function providerFailure(
  response: Response,
): Promise<WorkflowExecutionFailure> {
  const value: unknown = await response.json().catch(() => null);

  const detail = z
    .object({
      error: z.object({
        param: z
          .enum([
            "instructions",
            "input",
            "model",
            "tools",
            "tool_choice",
            "store",
            "include",
            "reasoning",
            "text",
            "parallel_tool_calls",
            "max_output_tokens",
          ])
          .nullish(),
      }),
    })
    .safeParse(value);

  return new WorkflowExecutionFailure(
    "provider",
    response.status,
    detail.success ? (detail.data.error.param ?? undefined) : undefined,
  );
}

async function nativeText(
  input: Input,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const capability = randomBytes(32).toString("base64url");
  let used = false;
  let failure: WorkflowExecutionFailure | undefined;

  const server = createServer(async (request, response) => {
    let stage: WorkflowStage = "route";

    try {
      if (
        request.method !== "POST" ||
        request.url?.split("?")[0] !== "/v1/responses" ||
        request.headers["x-omnyo-workflow-token"] !== capability ||
        used
      )
        throw new Error("Workflow route is unavailable.");
      used = true;
      const chunks: Buffer[] = [];
      let bytes = 0;

      for await (const chunk of request) {
        bytes += chunk.length;

        if (bytes > 2 * 1024 * 1024)
          throw new Error("Workflow input is too large.");
        chunks.push(chunk);
      }

      const headers = new Headers();

      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(",") : value);

      stage = "request";

      const body = await workflowRequest(
        new Request(`http://127.0.0.1${request.url}`, {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
        }),
        input,
      );

      for (const name of [
        "authorization",
        "x-api-key",
        "x-omnyo-workflow-token",
        "content-length",
        "content-encoding",
        "host",
      ])
        headers.delete(name);
      stage = "allowance";
      await withNativeWorkflowAccount(signal, async (account) => {
        for (const [name, value] of account.headers) headers.set(name, value);

        stage = "connection";

        const upstream = await fetch(account.url, {
          method: "POST",
          headers,
          body,
          signal,
          redirect: "error",
        });

        if (!upstream.ok) {
          failure ??= await providerFailure(upstream);
          throw failure;
        }

        stage = "response";

        const filtered = await workflowResponse(upstream, input, signal).catch(
          (error) => {
            failure ??= new WorkflowExecutionFailure(
              "response",
              upstream.status,
              undefined,
              error instanceof WorkflowResponseFailure
                ? `${error.code}${error.eventType ? `; event=${error.eventType}` : ""}${error.mime ? `; mime=${error.mime}` : ""}${error.payload ? `; payload=${error.payload}` : ""}${error.providerCode ? `; code=${error.providerCode}` : ""}`
                : "event_shape",
            );
            throw error;
          },
        );

        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(Buffer.from(await filtered.arrayBuffer()));
      });
    } catch (error) {
      failure ??=
        error instanceof WorkflowExecutionFailure
          ? error
          : new WorkflowExecutionFailure(stage);
      response.writeHead(403, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            type: "permission_error",
            message: "Workflow text request was not accepted.",
          },
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();

    if (address === null || typeof address === "string")
      throw new Error("Workflow route could not start.");

    const routed: RoutedInput = {
      ...input,
      route: {
        kind: "pool",
        capability,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
    };

    try {
      return await codexText(routed, directory, signal);
    } catch (error) {
      throw failure ?? error;
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

export async function completeWorkflowCli(
  raw: Input,
  parentSignal: AbortSignal,
) {
  const input = hostInput.parse(raw);

  if (input.providerId === "claude-code")
    return {
      ok: false as const,
      attemptId: input.attemptId,
      code: "allowance_unavailable" as const,
      message: CLAUDE_WORKFLOW_UNAVAILABLE,
    };

  const signal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(input.timeoutMs),
  ]);

  let directory: string | undefined;

  try {
    signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), "omnyo-workflow-text-"));

    const text = await (input.route.kind === "native"
      ? nativeText(input, directory, signal)
      : codexText({ ...input, route: input.route }, directory, signal));

    if (!text.trim() || Buffer.byteLength(text, "utf8") > input.maxOutputBytes)
      throw new Error("Invalid workflow output.");

    return { ok: true as const, attemptId: input.attemptId, text };
  } catch (error) {
    return {
      ok: false as const,
      attemptId: input.attemptId,
      code: parentSignal.aborted
        ? ("cancelled" as const)
        : signal.aborted
          ? ("timeout" as const)
          : ("request_failed" as const),
      message:
        error instanceof WorkflowExecutionFailure
          ? error.message
          : "The selected CLI could not complete the restricted workflow text request.",
    };
  } finally {
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
  }
}
