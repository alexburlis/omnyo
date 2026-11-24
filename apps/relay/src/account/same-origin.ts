const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

const FRAME_DESTINATIONS: ReadonlySet<string> = new Set([
  "iframe",
  "frame",
  "embed",
  "object",
  "fencedframe",
]);

const TRUSTED_FETCH_SITES: ReadonlySet<string> = new Set([
  "same-origin",
  "none",
]);

export type SameOriginViolation =
  | "cross-site-mutation"
  | "foreign-origin"
  | "framed"
  | null;

export function sameOriginViolation(
  request: Request,
  appOrigin: string,
): SameOriginViolation {
  const site = request.headers.get("sec-fetch-site")?.toLowerCase() ?? null;

  const destination =
    request.headers.get("sec-fetch-dest")?.toLowerCase() ?? null;

  const origin = request.headers.get("origin");

  if (
    !SAFE_METHODS.has(request.method.toUpperCase()) &&
    (site === "same-site" || site === "cross-site")
  ) {
    return "cross-site-mutation";
  }

  if (origin !== null && origin !== appOrigin) return "foreign-origin";

  if (
    site !== null &&
    !TRUSTED_FETCH_SITES.has(site) &&
    destination !== null &&
    FRAME_DESTINATIONS.has(destination)
  ) {
    return "framed";
  }

  return null;
}

export function apexSecurityHeaders(
  baseDomain: string,
): Readonly<Record<string, string>> {
  return {
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https://github.com https://*.${baseDomain}; frame-ancestors 'self'; base-uri 'none'`,
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
  };
}

export function withApexSecurityHeaders(
  response: Response,
  securityHeaders: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
