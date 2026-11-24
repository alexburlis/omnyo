import { CLAUDE_POOL_LOGIN_RETIRED } from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  filterRequestHeaders,
  mountedUpstreamUrl,
} from "./provider-adapter.js";
import { isQuotaRejection, quotaFromHeaders } from "./quota.js";
import { parseRequestBody } from "./request-body.js";

const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-app",
]);

const ALLOWED_REQUEST_HEADER_PREFIXES = ["anthropic-", "x-stainless-"];

export function createClaudeAdapter(): ProviderAdapter {
  return {
    provider: "claude",
    upstreamName: "Anthropic",

    parseRequest(body) {
      const parsed = parseRequestBody(body);

      return {
        family: parsed.family,
        model: null,
        serviceTier: null,
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
      };
    },
    inspectModelRejection: async (response) => ({ rejected: false, response }),
    upstreamUrl: (request, settings) =>
      mountedUpstreamUrl(request, settings.anthropicUpstreamBaseUrl, "claude/"),
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(
        inbound,
        ALLOWED_REQUEST_HEADERS,
        ALLOWED_REQUEST_HEADER_PREFIXES,
      );

      if (secret.kind !== "api-key") throw new Error(CLAUDE_POOL_LOGIN_RETIRED);

      headers.set("x-api-key", secret.apiKey);

      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    refreshSecret: async ({ secret }) => ({ secret, refreshed: false }),
    refreshUsage: async () => {},
    errorResponse(status, message, headers) {
      const type =
        status === 401
          ? "authentication_error"
          : status === 429
            ? "rate_limit_error"
            : "api_error";

      return Response.json(
        { type: "error", error: { type, message } },
        { status, headers },
      );
    },
  };
}
