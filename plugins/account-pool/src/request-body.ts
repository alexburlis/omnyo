import { zstdDecompressSync } from "node:zlib";
import { z } from "zod";
import type { ModelFamily } from "./contracts.js";
import { modelFamily } from "./quota.js";

const requestSchema = z
  .object({
    model: z.string().nullish(),
    metadata: z
      .object({ user_id: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const encodedUserSchema = z.object({}).passthrough();

const SESSION_COMPONENT =
  /(?:^|_)session_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu;

const MAX_DECODED_CODEX_BODY_BYTES = 64 * 1024 * 1024;

const MAX_DIAGNOSTIC_CODEX_BODY_BYTES = 8 * 1024 * 1024;

const MAX_DIAGNOSTIC_CODEX_INPUT_ITEMS = 16_384;

const nativeTurnId = z.union([
  z.uuid(),
  z.string().regex(/^[a-f0-9]{10}-t[0-9]{1,10}$/u),
]);

const taggedItemSchema = z.object({ type: z.unknown().optional() });

const textOrItemsSchema = z.union([
  z.string(),
  z.custom<unknown[]>(Array.isArray),
]);

const messageItemSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: textOrItemsSchema,
});

const toolCallSchema = z.object({
  call_id: z.string().min(1),
  name: z.string().min(1),
});

const functionCallSchema = toolCallSchema.extend({ arguments: z.string() });

const customCallSchema = toolCallSchema.extend({ input: z.string() });

const toolOutputSchema = z.object({
  call_id: z.string().min(1),
  output: textOrItemsSchema,
});

const outputLimitSchema = z.int().positive();

export interface ParsedRequestBody {
  family: ModelFamily;
  affinityId: string | null;
  parentAffinityId: string | null;
}

export interface ParsedCodexRequestBody extends ParsedRequestBody {
  model: string | null;
  serviceTier: string | null;
}

function affinityIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 512 &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : null;
}

function parseUserId(userId: string): {
  sessionId: string | null;
  parentSessionId: string | null;
} {
  try {
    const encoded = encodedUserSchema.safeParse(JSON.parse(userId));

    if (encoded.success) {
      const sessionId = affinityIdentifier(encoded.data.session_id);

      const parentSessionId = affinityIdentifier(
        encoded.data.parent_session_id,
      );

      return {
        sessionId,
        parentSessionId:
          sessionId === null || parentSessionId === sessionId
            ? null
            : parentSessionId,
      };
    }
  } catch {}

  return {
    sessionId: affinityIdentifier(SESSION_COMPONENT.exec(userId)?.[1]),
    parentSessionId: null,
  };
}

export function parseRequestBody(body: Uint8Array): ParsedRequestBody {
  try {
    const parsed = requestSchema.safeParse(
      JSON.parse(new TextDecoder().decode(body)),
    );

    if (!parsed.success)
      return {
        family: "other",
        affinityId: null,
        parentAffinityId: null,
      };
    const request = parsed.data;
    const userId = request.metadata?.user_id;

    const user =
      userId === undefined || userId === null ? null : parseUserId(userId);

    return {
      family: modelFamily(request.model ?? null),
      affinityId:
        user?.sessionId === undefined || user.sessionId === null
          ? null
          : `session:${user.sessionId}`,
      parentAffinityId:
        user?.parentSessionId === undefined || user.parentSessionId === null
          ? null
          : `session:${user.parentSessionId}`,
    };
  } catch {
    return {
      family: "other",
      affinityId: null,
      parentAffinityId: null,
    };
  }
}

function parseMetadata(
  value: string | Uint8Array | null,
): z.infer<typeof encodedUserSchema> | null {
  if (value === null) return null;

  try {
    const text =
      typeof value === "string"
        ? value
        : new TextDecoder("utf-8", { fatal: true }).decode(value);

    const parsed = encodedUserSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function decodeCodexBodyBytes(
  body: Uint8Array,
  headers: Headers,
  maxOutputLength = MAX_DECODED_CODEX_BODY_BYTES,
): Uint8Array | null {
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();

  if (encoding === undefined || encoding === "" || encoding === "identity")
    return body;

  if (encoding !== "zstd") return null;

  try {
    return zstdDecompressSync(body, { maxOutputLength });
  } catch {
    return null;
  }
}

function codexTurnMetadata(
  request: z.infer<typeof encodedUserSchema> | null,
  headers: Headers,
) {
  const client = encodedUserSchema.safeParse(request?.client_metadata).data;
  const headerTurn = parseMetadata(headers.get("x-codex-turn-metadata"));
  const bodyMetadata = client?.["x-codex-turn-metadata"];

  const bodyTurn = parseMetadata(
    typeof bodyMetadata === "string" ? bodyMetadata : null,
  );

  return { client, headerTurn, bodyTurn };
}

export function codexRejectionRequestDiagnostic(
  body: Uint8Array,
  headers: Headers,
) {
  const decoded =
    body.byteLength <= MAX_DIAGNOSTIC_CODEX_BODY_BYTES
      ? decodeCodexBodyBytes(body, headers, MAX_DIAGNOSTIC_CODEX_BODY_BYTES)
      : null;

  const request = parseMetadata(decoded);

  const { headerTurn, bodyTurn } = codexTurnMetadata(request, headers);

  const providerTurnId =
    nativeTurnId.safeParse(headerTurn?.turn_id).data ??
    nativeTurnId.safeParse(bodyTurn?.turn_id).data ??
    null;

  const decodedBytes = decoded?.byteLength ?? null;

  if (request === null) {
    return {
      providerTurnId,
      requestShape: {
        kind: decoded === null ? "body-unavailable" : "invalid-envelope",
        wireBytes: body.byteLength,
        decodedBytes,
      },
    };
  }

  const items = Array.isArray(request.input) ? request.input : null;

  const inputKind =
    items !== null
      ? "items"
      : typeof request.input === "string"
        ? "text"
        : "other";

  const functionCalls = new Map<string, number>();
  const customCalls = new Map<string, number>();
  let invalidItems = 0;
  let uncheckedItems = 0;
  let unmatchedToolCalls = 0;
  let unmatchedToolOutputs = 0;

  const scannedItems = Math.min(
    items?.length ?? 0,
    MAX_DIAGNOSTIC_CODEX_INPUT_ITEMS,
  );

  for (const item of items?.slice(0, scannedItems) ?? []) {
    const tagged = taggedItemSchema.safeParse(item);

    if (!tagged.success) {
      invalidItems++;
      continue;
    }

    const { type } = tagged.data;

    if (type === undefined || type === "message") {
      if (!messageItemSchema.safeParse(item).success) invalidItems++;
      continue;
    }

    if (typeof type !== "string" || type.length === 0) {
      invalidItems++;
      continue;
    }

    switch (type) {
      case "function_call":
      case "custom_tool_call": {
        const isFunction = type === "function_call";

        const call = (
          isFunction ? functionCallSchema : customCallSchema
        ).safeParse(item);

        if (!call.success) {
          invalidItems++;
          break;
        }

        const calls = isFunction ? functionCalls : customCalls;
        calls.set(call.data.call_id, (calls.get(call.data.call_id) ?? 0) + 1);
        unmatchedToolCalls++;
        break;
      }

      case "function_call_output":
      case "custom_tool_call_output": {
        const output = toolOutputSchema.safeParse(item);

        if (!output.success) {
          invalidItems++;
          break;
        }

        const calls =
          type === "function_call_output" ? functionCalls : customCalls;

        const pending = calls.get(output.data.call_id) ?? 0;

        if (pending === 0) {
          unmatchedToolOutputs++;
        } else {
          calls.set(output.data.call_id, pending - 1);
          unmatchedToolCalls--;
        }

        break;
      }

      default:
        uncheckedItems++;
    }
  }

  const maxOutputTokens =
    outputLimitSchema.safeParse(request.max_output_tokens).data ?? null;

  return {
    providerTurnId,
    requestShape: {
      kind: "checked",
      wireBytes: body.byteLength,
      decodedBytes,
      inputKind,
      inputItems: items?.length ?? null,
      scannedItems,
      invalidItems,
      uncheckedItems,
      unmatchedToolCalls,
      unmatchedToolOutputs,
      hasPreviousResponse: typeof request.previous_response_id === "string",
      maxOutputTokens,
      invalidOutputLimit:
        request.max_output_tokens != null && maxOutputTokens === null,
    },
  };
}

export function parseCodexRequestBody(
  body: Uint8Array,
  headers: Headers,
): ParsedCodexRequestBody {
  const decoded = decodeCodexBodyBytes(body, headers);

  const request = parseMetadata(
    decoded === null ? null : new TextDecoder().decode(decoded),
  );

  const { client, headerTurn, bodyTurn } = codexTurnMetadata(request, headers);

  const sessionId =
    affinityIdentifier(headers.get("thread-id")) ??
    affinityIdentifier(headerTurn?.thread_id) ??
    affinityIdentifier(client?.thread_id) ??
    affinityIdentifier(bodyTurn?.thread_id) ??
    affinityIdentifier(headers.get("session-id")) ??
    affinityIdentifier(headers.get("session_id")) ??
    affinityIdentifier(headerTurn?.session_id) ??
    affinityIdentifier(client?.session_id) ??
    affinityIdentifier(bodyTurn?.session_id);

  const cacheKey = affinityIdentifier(request?.prompt_cache_key);

  const parentSessionId =
    sessionId === null
      ? null
      : ([
          headerTurn?.forked_from_thread_id,
          bodyTurn?.forked_from_thread_id,
          headers.get("x-codex-parent-thread-id"),
          headerTurn?.parent_thread_id,
          client?.["x-codex-parent-thread-id"],
          bodyTurn?.parent_thread_id,
        ]
          .map(affinityIdentifier)
          .find((value) => value !== null && value !== sessionId) ?? null);

  return {
    family: "other",
    serviceTier: affinityIdentifier(request?.service_tier),
    model:
      typeof request?.model === "string" && request.model.trim() !== ""
        ? request.model
        : null,
    affinityId:
      sessionId !== null
        ? `session:${sessionId}`
        : cacheKey !== null
          ? `cache:${cacheKey}`
          : null,
    parentAffinityId:
      parentSessionId === null ? null : `session:${parentSessionId}`,
  };
}
