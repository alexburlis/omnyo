import { siteUsageRequestSchema } from "@omnyo/domain/site-usage";

import { requestObjects } from "../components/consent/consent-region";
import {
  parsePurposeConsent,
  readConsentValue,
} from "../components/consent/purpose-consent";
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_HOST,
  CONSENT_DEFAULT_PATH,
  CONSENT_MAX_AGE_SECONDS,
  DEV_ANALYTICS_HOST,
  SITE_USAGE_PATH,
} from "./config";

export interface AnalyticsRouteOptions {
  fetch: typeof fetch;
  collectorOrigin: string | undefined;
}

const MAX_BODY_BYTES = 1024;

const UPSTREAM_TIMEOUT_MS = 5000;

const NO_STORE = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex",
};

function emptyResponse(status: number, headers: HeadersInit = {}): Response {
  return new Response(null, { status, headers: { ...NO_STORE, ...headers } });
}

export function consentDefaultResponse(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return emptyResponse(405, { allow: "GET, HEAD" });

  return Response.json(
    { choice: requestObjects(request.headers) ? "rejected" : null },
    { headers: NO_STORE },
  );
}

function allowedRequest(request: Request, url: URL): boolean {
  const expectedOrigin =
    url.hostname === ANALYTICS_HOST
      ? `https://${ANALYTICS_HOST}`
      : import.meta.env.DEV && url.hostname === DEV_ANALYTICS_HOST
        ? url.origin
        : null;

  const cookies = request.headers.get("cookie") ?? "";

  const choices = cookies
    .split(";")
    .filter((part) => part.trim().startsWith(`${ANALYTICS_CONSENT_COOKIE}=`));

  return (
    expectedOrigin !== null &&
    request.headers.get("origin") === expectedOrigin &&
    !requestObjects(request.headers) &&
    choices.length === 1 &&
    parsePurposeConsent(
      readConsentValue(ANALYTICS_CONSENT_COOKIE, cookies),
      CONSENT_MAX_AGE_SECONDS,
    ) === "accepted"
  );
}

async function readBoundedBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");

  if (
    !Number.isSafeInteger(declared) ||
    declared < 0 ||
    declared > MAX_BODY_BYTES ||
    request.body === null
  )
    return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();

  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  ]);

  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };

  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > MAX_BODY_BYTES) {
        await reader.cancel();

        return null;
      }

      text += decoder.decode(chunk.value, { stream: true });
    }

    return signal.aborted ? null : JSON.parse(text + decoder.decode());
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function handleAnalyticsRoute(
  request: Request,
  options: AnalyticsRouteOptions,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === CONSENT_DEFAULT_PATH)
    return consentDefaultResponse(request);

  if (url.pathname === "/ox" || url.pathname.startsWith("/ox/"))
    return emptyResponse(410);

  if (url.pathname !== SITE_USAGE_PATH) return null;

  if (request.method !== "POST") return emptyResponse(405, { allow: "POST" });

  if (url.search !== "" || !allowedRequest(request, url))
    return emptyResponse(403);

  if (request.signal.aborted) return emptyResponse(499);

  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  )
    return emptyResponse(415);

  const parsed = siteUsageRequestSchema.safeParse(
    await readBoundedBody(request),
  );

  if (!parsed.success) return emptyResponse(400);

  if (options.collectorOrigin === undefined) return emptyResponse(503);

  if (request.signal.aborted) return emptyResponse(499);

  try {
    const upstream = await options.fetch(
      `${options.collectorOrigin}/metrics/site-events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Omnyo-Site-Usage/1",
        },
        body: JSON.stringify(parsed.data),
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ]),
      },
    );

    await upstream.body?.cancel();

    return emptyResponse(upstream.ok ? 204 : 502);
  } catch {
    return emptyResponse(502);
  }
}
