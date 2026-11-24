const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const FRAME_DESTINATIONS = new Set([
  "iframe",
  "frame",
  "embed",
  "object",
  "fencedframe",
]);

export type SameOriginViolation =
  | "cross-site-mutation"
  | "foreign-origin"
  | "framed"
  | "foreign-websocket-origin";

export interface SameOriginInput {
  method: string;
  headers: Headers;
  origin: string;
  isWebSocket: boolean;
}

export function sameOriginViolation(
  input: SameOriginInput,
): SameOriginViolation | null {
  const site =
    input.headers.get("sec-fetch-site")?.trim().toLowerCase() ?? null;

  const dest =
    input.headers.get("sec-fetch-dest")?.trim().toLowerCase() ?? null;

  const origin = input.headers.get("origin");

  if (input.isWebSocket) {
    return origin !== null && origin !== input.origin
      ? "foreign-websocket-origin"
      : null;
  }

  if (
    !SAFE_METHODS.has(input.method.toUpperCase()) &&
    (site === "same-site" || site === "cross-site")
  ) {
    return "cross-site-mutation";
  }

  if (origin !== null && origin !== input.origin) return "foreign-origin";

  if (
    site !== null &&
    site !== "same-origin" &&
    site !== "none" &&
    dest !== null &&
    FRAME_DESTINATIONS.has(dest)
  ) {
    return "framed";
  }

  return null;
}

const FRAME_ANCESTORS_SELF = "frame-ancestors 'self'";

export function applyFramingHeaders(headers: Headers): void {
  headers.append("content-security-policy", FRAME_ANCESTORS_SELF);
  const existing = headers.get("x-frame-options")?.trim().toUpperCase();

  if (existing !== "DENY") headers.set("x-frame-options", "SAMEORIGIN");
}
