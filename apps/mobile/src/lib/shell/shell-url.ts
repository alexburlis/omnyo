import { deriveConnectBaseUrl } from "@omnyo/connect-client";

const RELAY_AUTHORIZE_PATH = "/relay/authorize";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

export interface ServerOrigin {
  origin: string;
  prefix: string;
}

export function parseServerUrl(serverUrl: string): ServerOrigin | null {
  try {
    const url = new URL(serverUrl);

    return { origin: url.origin, prefix: trimTrailingSlash(url.pathname) };
  } catch {
    return null;
  }
}

export function buildShellUrl(serverUrl: string, path: string): string {
  const parsed = parseServerUrl(serverUrl);

  const base = parsed
    ? `${parsed.origin}${parsed.prefix}`
    : trimTrailingSlash(serverUrl);

  if (path.length === 0 || path === "/") return `${base}/`;

  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function isShellNavigation(url: string, serverUrl: string): boolean {
  const server = parseServerUrl(serverUrl);

  if (server === null) return false;
  let target: URL;

  try {
    target = new URL(url);
  } catch {
    return false;
  }

  if (target.origin !== server.origin) return false;

  if (server.prefix.length === 0) return true;

  return (
    target.pathname === server.prefix ||
    target.pathname.startsWith(`${server.prefix}/`)
  );
}

export function shellPathFromUrl(
  url: string,
  serverUrl: string,
): string | null {
  if (!isShellNavigation(url, serverUrl)) return null;
  const server = parseServerUrl(serverUrl);

  if (server === null) return null;
  const target = new URL(url);
  const pathname = target.pathname.slice(server.prefix.length) || "/";

  return `${pathname}${target.search}`;
}

export function isExternallyOpenable(url: string): boolean {
  try {
    const { protocol } = new URL(url);

    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

export function isRelaySignInRedirect(url: string, serverUrl: string): boolean {
  try {
    const target = new URL(url);

    return (
      target.origin === deriveConnectBaseUrl(serverUrl) &&
      target.pathname === RELAY_AUTHORIZE_PATH &&
      target.searchParams.get("host") === new URL(serverUrl).host
    );
  } catch {
    return false;
  }
}

const SUBFRAME_LOCAL_PROTOCOLS = new Set(["about:", "blob:", "data:"]);

export const SHELL_ORIGIN_WHITELIST: string[] = [
  "http://*",
  "https://*",
  ...[...SUBFRAME_LOCAL_PROTOCOLS].map((protocol) => `${protocol}*`),
];

function isSubframeLocalUrl(url: string): boolean {
  try {
    return SUBFRAME_LOCAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export type ShellNavigationDecision =
  | "load"
  | "relay-sign-in"
  | "open-external"
  | "block";

export function decideShellNavigation(
  request: { url: string; isTopFrame: boolean },
  profile: { mode: "direct" | "connect"; serverUrl: string },
): ShellNavigationDecision {
  if (isShellNavigation(request.url, profile.serverUrl)) return "load";

  if (!request.isTopFrame && isSubframeLocalUrl(request.url)) return "load";

  if (
    profile.mode === "connect" &&
    isRelaySignInRedirect(request.url, profile.serverUrl)
  ) {
    return request.isTopFrame ? "relay-sign-in" : "block";
  }

  return isExternallyOpenable(request.url) ? "open-external" : "block";
}
