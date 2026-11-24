import { zstdDecompressSync } from "node:zlib";
import { z } from "zod";
import {
  CLAUDE_WORKFLOW_UNAVAILABLE,
  WORKFLOW_SYSTEM_PROMPT,
  type PoolWorkflowInput,
} from "./workflow-contract.js";

const textPart = z
  .object({ type: z.enum(["text", "input_text"]), text: z.string() })
  .catchall(z.json());

const message = z
  .object({
    role: z.enum(["user", "developer", "system"]),
    content: z.array(textPart),
  })
  .catchall(z.json());

const request = z
  .object({ model: z.string(), stream: z.literal(true) })
  .catchall(z.json());

export async function workflowRequest(
  source: Request,
  input: PoolWorkflowInput,
): Promise<Uint8Array<ArrayBuffer>> {
  if (input.providerId === "claude-code")
    throw new Error(CLAUDE_WORKFLOW_UNAVAILABLE);

  const wire = new Uint8Array(await source.arrayBuffer());

  if (wire.byteLength > 2 * 1024 * 1024)
    throw new Error("Workflow request is too large.");
  const encoding = source.headers.get("content-encoding");

  if (encoding !== null && encoding !== "identity" && encoding !== "zstd")
    throw new Error("Unsupported workflow encoding.");

  const bytes =
    encoding === "zstd"
      ? zstdDecompressSync(wire, { maxOutputLength: 2 * 1024 * 1024 })
      : wire;

  const body = request.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );

  if (body.model !== input.model) throw new Error("Workflow model changed.");

  const items = z
    .array(z.object({ type: z.string() }).catchall(z.json()))
    .parse(body.input);

  const messages = items
    .filter((item) => {
      if (item.type === "configuration_update") {
        z.object({
          type: z.literal("configuration_update"),
          reasoning: z.object({ effort: z.literal("low") }).strict(),
        })
          .strict()
          .parse(item);

        return false;
      }

      return item.type !== "additional_tools";
    })
    .map((item) => {
      if (item.type !== "message")
        throw new Error("Unexpected workflow input.");

      return message.parse(item);
    });

  const last = messages.at(-1);

  const generatedPrefixes = [
    "<skills_instructions>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<environment_context>",
  ];

  if (
    messages
      .slice(0, -1)
      .some((item) =>
        item.content.some(
          (part) =>
            part.text !== WORKFLOW_SYSTEM_PROMPT &&
            !generatedPrefixes.some((prefix) => part.text.startsWith(prefix)),
        ),
      )
  )
    throw new Error("Unexpected workflow context.");

  if (
    last?.role !== "user" ||
    last.content.length !== 1 ||
    last.content[0]?.text !== input.prompt ||
    !messages.some(
      (item) =>
        item.role === "developer" &&
        item.content.some((part) => part.text === WORKFLOW_SYSTEM_PROMPT),
    )
  )
    throw new Error("Workflow prompt changed.");

  return new TextEncoder().encode(
    JSON.stringify({
      ...body,
      input: items.filter((item) => item.type !== "additional_tools"),
      tools: [],
      tool_choice: "none",
    }),
  );
}

const events = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.metadata",
  "codex.response.metadata",
  "responsesapi.websocket_timing",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.completed",
  "ping",
]);

const eventSchema = z.object({ type: z.string() }).catchall(z.json());

function rejectsTool(value: z.output<z.ZodJSONSchema>): boolean {
  if (Array.isArray(value)) return value.some(rejectsTool);

  if (value !== null && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) =>
        (key === "type" &&
          typeof item === "string" &&
          /tool|function|computer|shell/u.test(item)) ||
        rejectsTool(item),
    );

  return false;
}

export class WorkflowResponseFailure extends Error {
  constructor(
    readonly code:
      | "content_type"
      | "payload_type"
      | "wire_limit"
      | "invalid_json"
      | "event_shape"
      | "unknown_event"
      | "tool_call"
      | "terminal_shape"
      | "missing_terminal"
      | "missing_text"
      | "output_limit",
    readonly eventType: string | null = null,
    readonly mime: string | null = null,
    readonly payload: string | null = null,
    readonly providerCode: string | null = null,
  ) {
    super(code);
  }
}

const messageItem = z
  .object({
    type: z.literal("message"),
    id: z.string().min(1),
    role: z.literal("assistant"),
    status: z.literal("completed").nullish(),
    content: z.array(
      z
        .object({ type: z.literal("output_text"), text: z.string() })
        .passthrough(),
    ),
  })
  .passthrough();

export async function workflowResponse(
  source: Response,
  input: PoolWorkflowInput,
  signal: AbortSignal,
): Promise<Response> {
  if (input.providerId === "claude-code")
    throw new Error(CLAUDE_WORKFLOW_UNAVAILABLE);

  const rawMime = source.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();

  const mime =
    rawMime === undefined
      ? "missing"
      : [
            "text/event-stream",
            "application/json",
            "text/html",
            "text/plain",
            "application/octet-stream",
          ].includes(rawMime)
        ? rawMime
        : "other";

  if (!source.body)
    throw new WorkflowResponseFailure("content_type", null, mime, "empty");
  const reader = source.body.getReader();

  const abort = () => {
    void reader.cancel().catch(() => {});
  };

  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();

      if (part.done) break;
      total += part.value.byteLength;

      if (total > 2 * 1024 * 1024)
        throw new WorkflowResponseFailure("wire_limit");
      chunks.push(part.value);
    }

    signal.throwIfAborted();
    const body = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    let decoded: string;

    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new WorkflowResponseFailure("payload_type", null, mime, "binary");
    }

    const trimmed = decoded.trimStart();

    const payload = /^(?:data|event):/mu.test(decoded)
      ? "sse"
      : trimmed.startsWith("{") || trimmed.startsWith("[")
        ? "json"
        : trimmed.startsWith("<")
          ? "html"
          : trimmed.length === 0
            ? "empty"
            : "other";

    if (payload !== "sse") {
      let providerCode: string | null = null;

      if (payload === "json") {
        try {
          const parsed = z
            .object({
              error: z.object({
                code: z
                  .enum([
                    "invalid_request_error",
                    "authentication_error",
                    "rate_limit_error",
                    "permission_error",
                    "model_not_found",
                    "insufficient_quota",
                    "unsupported_parameter",
                    "account_deactivated",
                    "bad_request",
                    "not_found",
                    "forbidden",
                    "unauthorized",
                    "invalid_api_key",
                  ])
                  .optional(),
                type: z
                  .enum([
                    "invalid_request_error",
                    "authentication_error",
                    "rate_limit_error",
                    "permission_error",
                  ])
                  .optional(),
              }),
            })
            .safeParse(JSON.parse(decoded));

          if (parsed.success)
            providerCode =
              parsed.data.error.code ?? parsed.data.error.type ?? null;
        } catch {}
      }

      throw new WorkflowResponseFailure(
        "payload_type",
        null,
        mime,
        payload,
        providerCode,
      );
    }

    const fail = (
      code: WorkflowResponseFailure["code"],
      eventType: string | null = null,
    ) => new WorkflowResponseFailure(code, eventType, mime, payload);

    let complete = false;
    let responseId: string | undefined;
    const messages = new Map<string, string>();

    const recordItem = (value: unknown) => {
      if (z.object({ type: z.literal("reasoning") }).safeParse(value).success)
        return;
      const parsed = messageItem.safeParse(value);

      if (!parsed.success) throw fail("event_shape");
      messages.set(
        parsed.data.id,
        parsed.data.content.map((part) => part.text).join(""),
      );
    };

    for (const frame of decoded.replaceAll("\r\n", "\n").split("\n\n")) {
      const fields = frame.split("\n");

      if (
        fields.some(
          (line) =>
            line.trim() !== "" && !/^(?:data:|event:|id:|retry:|:)/u.test(line),
        )
      )
        throw fail("event_shape");
      const lines = fields.filter((line) => line.startsWith("data:"));

      if (lines.length === 0) continue;
      const raw = lines.map((line) => line.slice(5).trimStart()).join("\n");

      if (raw === "[DONE]" && complete) continue;
      let value: unknown;

      try {
        value = JSON.parse(raw);
      } catch {
        throw fail("invalid_json");
      }

      const parsed = eventSchema.safeParse(value);

      if (!parsed.success) throw fail("event_shape");
      const event = parsed.data;

      if (rejectsTool(event)) throw fail("tool_call");

      if (!events.has(event.type))
        throw fail(
          "unknown_event",
          /^[a-z][a-z0-9_.]{0,79}$/u.test(event.type) ? event.type : null,
        );

      if (event.type === "response.created") {
        const created = z
          .object({ id: z.string().min(1) })
          .safeParse(event.response);

        if (created.success) responseId = created.data.id;
      }

      if (event.type === "response.output_item.done") recordItem(event.item);

      if (event.type === "response.completed") {
        const terminal = z
          .object({
            id: z.string().min(1),
            status: z.literal("completed").nullish(),
            error: z.null().optional(),
            end_turn: z.literal(true).nullish(),
            output: z.array(z.json()).optional(),
          })
          .safeParse(event.response);

        if (
          !terminal.success ||
          (responseId !== undefined && responseId !== terminal.data.id)
        )
          throw fail("terminal_shape");

        for (const item of terminal.data.output ?? []) recordItem(item);
        complete = true;
      }
    }

    const text = [...messages.values()].join("\n");

    if (!complete) throw fail("missing_terminal");

    if (!text.trim()) throw fail("missing_text");

    if (Buffer.byteLength(text, "utf8") > input.maxOutputBytes)
      throw fail("output_limit");
    const headers = new Headers(source.headers);
    headers.set("content-type", "text/event-stream");
    headers.delete("content-length");
    headers.delete("content-encoding");

    return new Response(body, { status: source.status, headers });
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}
