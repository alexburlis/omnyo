export const ANALYTICS_HOST = "omnyohq.com";

export const DEV_ANALYTICS_HOST = "analytics.localhost";

export const ANALYTICS_CONSENT_COOKIE = "omnyo_analytics_consent_v2";

export const LEGACY_ANALYTICS_CONSENT_COOKIE = "omnyo_analytics_consent_v1";

export const DIAGNOSTICS_CONSENT_COOKIE = "omnyo_diagnostics_consent_v1";

export const CONSENT_CHANNEL = "omnyo_consent_v1";

export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export const CONSENT_DEFAULT_PATH = "/api/consent-default";

export const SITE_USAGE_PATH = "/api/usage/event";

export const SENTRY_DSN = import.meta.env.VITE_OMNYO_WEBSITE_SENTRY_DSN ?? "";

export const SENTRY_RUNTIME = "website";

export const PRIVATE_PATH_PREFIXES = ["/w/"] as const;

export function isPrivatePath(pathname: string): boolean {
  return PRIVATE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
