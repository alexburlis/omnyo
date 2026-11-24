import { z } from "zod";

export const pluginErrorDiagnosticSchema = z
  .object({
    stage: z.enum(["send", "receive", "decode", "complete"]),
    failureClass: z.enum([
      "connection",
      "upstream-unavailable",
      "upstream-rejected",
      "invalid-response",
      "unknown",
    ]),
    outcome: z.literal("terminal"),
    retryable: z.boolean(),
    attempt: z.number().int().min(1).max(1000),
    itemCount: z.number().int().min(1).max(100000),
    transportCode: z
      .enum([
        "ECONNREFUSED",
        "ECONNRESET",
        "ECONNABORTED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "EPIPE",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "CERT_HAS_EXPIRED",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_SOCKET",
        "ABORT_ERR",
      ])
      .optional(),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export type PluginErrorDiagnostic = z.infer<typeof pluginErrorDiagnosticSchema>;
