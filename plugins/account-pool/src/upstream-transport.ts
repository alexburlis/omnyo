import { EnvHttpProxyAgent } from "undici";
import { z } from "zod";
import type { codexRejectionRequestDiagnostic } from "./request-body.js";

export function createUpstreamTransport() {
  const dispatcher = new EnvHttpProxyAgent({ allowH2: false });

  const upstreamFetch: typeof fetch = (input, init) => {
    const options = { ...init, dispatcher };

    return fetch(input, options);
  };

  return {
    fetch: upstreamFetch,
    destroy: () => dispatcher.destroy(),
  };
}

const TRANSPORT_CODES = new Set([
  "ERR_HTTP2_INVALID_SESSION",
  "ERR_HTTP2_GOAWAY_SESSION",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

export function transportErrorCode(error: unknown): string {
  let cause = error;

  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      TRANSPORT_CODES.has(cause.code)
    ) {
      return cause.code;
    }

    cause = cause.cause;
  }

  return "unclassified transport error";
}

export type UpstreamEndpoint =
  | "responses"
  | "messages"
  | "models"
  | "prediction"
  | "parent"
  | "unknown";

export interface UpstreamDiagnosticContext {
  operationId: string;
  endpoint: UpstreamEndpoint;
  attempt: number;
  startedAt: number;
}

export interface UpstreamDiagnostic {
  operationId: string;
  endpoint: UpstreamEndpoint;
  attempt: number;
  durationMs: number;
  httpStatus: number | null;
  transportCode: string | null;
  requestId: string | null;
  providerCode: string | null;
  codexRequest?: ReturnType<typeof codexRejectionRequestDiagnostic>;
  rejectedParameter:
    | "model"
    | "service-tier"
    | "reasoning"
    | "tools"
    | "input"
    | "output-limit"
    | null;
}

const providerCodeSchema = z.enum([
  "invalid_request_error",
  "invalid_request",
  "unsupported_parameter",
  "unsupported_value",
  "model_not_found",
  "rate_limit_exceeded",
  "usage_limit_reached",
  "insufficient_quota",
  "authentication_error",
  "permission_error",
  "overloaded_error",
  "server_error",
  "context_length_exceeded",
]);

const providerFailureSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    type: z.string().optional(),
    param: z.string().optional(),
  }),
});

function rejectedParameter(
  value: string | undefined,
): UpstreamDiagnostic["rejectedParameter"] {
  switch (value) {
    case "model":
      return "model";
    case "service_tier":
      return "service-tier";
    case "reasoning":
    case "reasoning.effort":
      return "reasoning";
    case "tools":
    case "tool_choice":
      return "tools";
    case "input":
    case "messages":
      return "input";
    case "max_output_tokens":
    case "max_tokens":
      return "output-limit";
    default:
      return null;
  }
}

export function upstreamDiagnostic(
  context: UpstreamDiagnosticContext,
  error?: unknown,
): UpstreamDiagnostic {
  const code = error === undefined ? null : transportErrorCode(error);

  return {
    operationId: context.operationId,
    endpoint: context.endpoint,
    attempt: context.attempt,
    durationMs: Math.max(0, Math.round(performance.now() - context.startedAt)),
    httpStatus: null,
    transportCode: code === "unclassified transport error" ? null : code,
    requestId: null,
    providerCode: null,
    rejectedParameter: null,
  };
}

export function observeUpstreamResponse(
  response: Response,
  context: UpstreamDiagnosticContext,
  record: (diagnostic: UpstreamDiagnostic) => void,
): Response {
  if (response.ok) return response;

  const emit = (diagnostic: UpstreamDiagnostic) => {
    try {
      record(diagnostic);
    } catch {}
  };

  const requestId =
    response.headers.get("x-request-id") ?? response.headers.get("request-id");

  const diagnostic: UpstreamDiagnostic = {
    ...upstreamDiagnostic(context),
    httpStatus: response.status,
    requestId:
      requestId !== null &&
      /^(?:req_[A-Za-z0-9]{8,80}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.test(
        requestId,
      )
        ? requestId
        : null,
  };

  emit(diagnostic);

  if (response.body === null) return response;
  const reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let size = 0;
  let oversized = false;

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();

          if (result.done) {
            if (!oversized) {
              const bytes = new Uint8Array(size);
              let offset = 0;

              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }

              let parsed: unknown;

              try {
                parsed = JSON.parse(new TextDecoder().decode(bytes));
              } catch {
                parsed = null;
              }

              const failure =
                providerFailureSchema.safeParse(parsed).data?.error;

              const providerCode =
                providerCodeSchema.safeParse(failure?.code ?? failure?.type)
                  .data ?? null;

              const parameter = rejectedParameter(failure?.param);

              if (providerCode !== null || parameter !== null)
                emit({
                  ...diagnostic,
                  durationMs: Math.max(
                    0,
                    Math.round(performance.now() - context.startedAt),
                  ),
                  providerCode,
                  rejectedParameter: parameter,
                });
            }

            chunks = [];
            controller.close();

            return;
          }

          if (!oversized && size + result.value.byteLength <= 8192) {
            chunks.push(result.value.slice());
            size += result.value.byteLength;
          } else {
            oversized = true;
            chunks = [];
          }

          controller.enqueue(result.value);
        } catch (error) {
          chunks = [];
          const failure = upstreamDiagnostic(context, error);
          emit({
            ...diagnostic,
            durationMs: failure.durationMs,
            transportCode: failure.transportCode,
          });
          controller.error(error);
        }
      },
      async cancel(reason) {
        chunks = [];
        await reader.cancel(reason);
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}
