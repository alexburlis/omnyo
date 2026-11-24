import {
  ANALYTICS_CONSENT_HEADER,
  USER_ACTIVITY_HEADER,
  usageRequestEligible,
} from "@omnyo/domain/usage-telemetry";
import { readClientUsageConsent } from "./usage-consent";
import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_HEADER_NAME,
  APP_SURFACE_WEB,
  type RequestAppSurface,
} from "@omnyo/config/app-surface";
import { isInsideNativeShell } from "@/lib/native-shell";
import { serveBootRead } from "./boot-reads";
import { reloadForGateReauth } from "./gate-reauth";

const APP_SURFACE_MOBILE: RequestAppSurface = "mobile";

export function getAppSurface(): RequestAppSurface {
  if (typeof window !== "undefined" && window.omnyoDesktop !== undefined) {
    return APP_SURFACE_DESKTOP;
  }

  if (isInsideNativeShell()) {
    return APP_SURFACE_MOBILE;
  }

  return APP_SURFACE_WEB;
}

export function appSurfaceRequestInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(APP_SURFACE_HEADER_NAME, getAppSurface());

  return {
    ...init,
    cache: init?.cache ?? "no-store",
    headers,
  };
}

export async function fetchWithAppSurface(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const options = appSurfaceRequestInit(init);

  const target = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin,
  );

  if (
    target.origin === window.location.origin &&
    usageRequestEligible(
      target.pathname,
      init?.method ?? (input instanceof Request ? input.method : "GET"),
    )
  ) {
    const headers = new Headers(options.headers);
    headers.set(USER_ACTIVITY_HEADER, "1");
    const proof = readClientUsageConsent().active;

    if (proof) headers.set(ANALYTICS_CONSENT_HEADER, proof);
    options.headers = headers;
    options.redirect = "error";
  }

  if (
    target.origin === window.location.origin &&
    target.pathname.startsWith("/api/v1/system/usage")
  )
    options.redirect = "error";
  const network = () => fetch(input, options);
  const response = await (serveBootRead(input, init, network) ?? network());

  if (getAppSurface() === APP_SURFACE_WEB) {
    reloadForGateReauth(response);
  }

  return response;
}
