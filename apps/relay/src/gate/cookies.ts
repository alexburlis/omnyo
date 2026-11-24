export const GATE_COOKIE = "__Host-omnyo-gate";

export const NONCE_COOKIE = "__Host-omnyo-nonce";

export const SECURE_DESKTOP_SESSION_COOKIE =
  "__Secure-omnyo-connect.desktop_session";

export const LOCAL_DESKTOP_SESSION_COOKIE = "omnyo-connect.desktop_session";

export const LEGACY_SECURE_DESKTOP_SESSION_COOKIE =
  "__Secure-bb-connect.desktop_session";

export const LEGACY_LOCAL_DESKTOP_SESSION_COOKIE = "bb-connect.desktop_session";

const PLATFORM_COOKIE_PREFIXES = [
  "__host-omnyo",
  "__secure-omnyo",
  "__secure-__host-omnyo",
  "__host-__secure-omnyo",
  "better-auth.",
  "__secure-better-auth.",
  "__host-better-auth.",
  "omnyo-connect.",
  "bb-connect.",
  "__secure-bb-connect.",
  "__host-bb-connect.",
];

export function isPlatformCookie(name: string): boolean {
  const lowered = name.trim().toLowerCase();

  return PLATFORM_COOKIE_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

export function desktopSessionCookieName(appUrl: string): string {
  return new URL(appUrl).protocol === "https:"
    ? SECURE_DESKTOP_SESSION_COOKIE
    : LOCAL_DESKTOP_SESSION_COOKIE;
}

export function legacyDesktopSessionCookieName(appUrl: string): string {
  return new URL(appUrl).protocol === "https:"
    ? LEGACY_SECURE_DESKTOP_SESSION_COOKIE
    : LEGACY_LOCAL_DESKTOP_SESSION_COOKIE;
}

export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  let found: string | null = null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) continue;

    if (part.slice(0, separator).trim() !== name) continue;

    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }

  return found;
}

export function withoutPlatformCookies(header: string | null): string | null {
  if (header === null) return null;

  const tenantCookies = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf("=");

      return separator > 0 && !isPlatformCookie(part.slice(0, separator));
    });

  return tenantCookies.length === 0 ? null : tenantCookies.join("; ");
}

export function isAcceptableTenantSetCookie(cookie: string): boolean {
  const separator = cookie.indexOf("=");

  if (separator <= 0) return false;

  return (
    !isPlatformCookie(cookie.slice(0, separator)) &&
    !/;\s*domain\s*(?:=|;|$)/iu.test(cookie) &&
    !/,(?=\s*[^;,=\s]+\s*=)/u.test(cookie)
  );
}

export interface HostCookieOptions {
  name: string;
  value: string;
  expiresAt: number | null;
}

export function hostCookie(options: HostCookieOptions): string {
  const attributes = [
    `${options.name}=${options.value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (options.expiresAt !== null) {
    attributes.push(`Expires=${new Date(options.expiresAt).toUTCString()}`);
  }

  return attributes.join("; ");
}

export function hostCookieWithMaxAge(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function expiredHostCookie(name: string): string {
  return hostCookieWithMaxAge(name, "", 0);
}
