import {
  browserObjects,
  fetchConsentDefault,
  type ConsentDefault,
} from "../components/consent/consent-region";
import { announceConsentChange } from "../components/consent/consent-withdrawal";
import {
  blockConsent,
  readPurposeConsent,
  writePurposeConsent,
  type StoredChoice,
} from "../components/consent/purpose-consent";
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_HOST,
  CONSENT_CHANNEL,
  CONSENT_DEFAULT_PATH,
  CONSENT_MAX_AGE_SECONDS,
  DEV_ANALYTICS_HOST,
  DIAGNOSTICS_CONSENT_COOKIE,
  LEGACY_ANALYTICS_CONSENT_COOKIE,
  isPrivatePath,
} from "./config";

export interface ConsentGrants {
  analytics: boolean;
  diagnostics: boolean;
}

const PURPOSE_COOKIES = [ANALYTICS_CONSENT_COOKIE, DIAGNOSTICS_CONSENT_COOKIE];

const POSTHOG_STORAGE_KEY = /^(?:ph_|__ph_|_postHog)/;

let consentDefaultRequest: Promise<ConsentDefault> | undefined;

export function optionalToolsRunOnThisHost(): boolean {
  const { hostname } = window.location;

  return (
    hostname === ANALYTICS_HOST ||
    (import.meta.env.DEV && hostname === DEV_ANALYTICS_HOST)
  );
}

export function analyticsChoice(): StoredChoice | null {
  const current = readPurposeConsent(
    ANALYTICS_CONSENT_COOKIE,
    CONSENT_MAX_AGE_SECONDS,
  );

  if (current !== null) return current;

  return readPurposeConsent(
    LEGACY_ANALYTICS_CONSENT_COOKIE,
    CONSENT_MAX_AGE_SECONDS,
  ) === "rejected"
    ? "rejected"
    : null;
}

export function diagnosticsChoice(): StoredChoice | null {
  return readPurposeConsent(
    DIAGNOSTICS_CONSENT_COOKIE,
    CONSENT_MAX_AGE_SECONDS,
  );
}

export function storedChoice(): StoredChoice | null {
  const analytics = analyticsChoice();
  const diagnostics = diagnosticsChoice();

  if (analytics === null && diagnostics === null) return null;

  return analytics === "accepted" || diagnostics === "accepted"
    ? "accepted"
    : "rejected";
}

export function consentGrants(): ConsentGrants {
  const usable = optionalToolsRunOnThisHost() && !browserObjects();

  return {
    analytics: usable && analyticsChoice() === "accepted",
    diagnostics: usable && diagnosticsChoice() === "accepted",
  };
}

function onPublicPage(): boolean {
  return !isPrivatePath(window.location.pathname);
}

export function analyticsAllowedNow(): boolean {
  return onPublicPage() && consentGrants().analytics;
}

export function diagnosticsAllowedNow(): boolean {
  return onPublicPage() && consentGrants().diagnostics;
}

export function loadConsentDefault(): Promise<ConsentDefault> {
  if (browserObjects()) return Promise.resolve("rejected");
  consentDefaultRequest ??= fetchConsentDefault(CONSENT_DEFAULT_PATH);

  return consentDefaultRequest;
}

export function savePurposeChoices(choices: ConsentGrants): void {
  try {
    writePurposeConsent(
      DIAGNOSTICS_CONSENT_COOKIE,
      choices.diagnostics,
      CONSENT_MAX_AGE_SECONDS,
    );
    writePurposeConsent(
      ANALYTICS_CONSENT_COOKIE,
      choices.analytics,
      CONSENT_MAX_AGE_SECONDS,
    );
  } catch (error) {
    blockConsent(PURPOSE_COOKIES);
    throw error;
  }

  announceConsentChange(CONSENT_CHANNEL);
}

function expireCookie(name: string): void {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function removePosthogKeys(area: "localStorage" | "sessionStorage"): void {
  try {
    const storage = window[area];

    const keys = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    );

    for (const key of keys) {
      if (key !== null && POSTHOG_STORAGE_KEY.test(key))
        storage.removeItem(key);
    }
  } catch {
    return;
  }
}

function posthogCookieNames(): string[] {
  return document.cookie
    .split(";")
    .map((part) => part.trim().split("=", 1)[0] ?? "")
    .filter((name) => POSTHOG_STORAGE_KEY.test(name));
}

export function removePosthogStorage(): void {
  for (const name of posthogCookieNames()) expireCookie(name);
  removePosthogKeys("localStorage");
  removePosthogKeys("sessionStorage");
}
