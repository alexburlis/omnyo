// Shared source: product-launch/assets/browser-consent. Use install-consent.py.

/**
 * Where optional analytics asks first (analytics standard, Regions): the EEA with Åland and the EU's outermost
 * regions, the UK with the Crown Dependencies and Gibraltar, Switzerland and Canada. Everyone else gets the regional
 * default: optional analytics on, with the persistent settings control as the opt-out.
 */
export const ASK_FIRST_COUNTRIES: ReadonlySet<string> = new Set(
  `AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI
ES SE AX GF GP MQ RE YT MF IS LI NO GB GG JE IM GI CH CA`.split(/\s+/),
)

/** null asks first; "accepted" turns optional analytics on by default; "rejected" keeps it off. */
export type ConsentDefault = "accepted" | "rejected" | null

/**
 * The default for a visitor without an explicit choice. `country` is the ISO code from a trusted edge header
 * (Cloudflare's CF-IPCountry), or null when the header is missing or untrusted; XX (unknown), T1 (Tor) and ZZ count as
 * unknown, which asks. `objection` is true when the request sends DNT: 1 or Sec-GPC: 1, which outside the ask-first
 * zone keeps analytics off.
 */
export function consentDefault(
  country: string | null | undefined,
  objection: boolean,
): ConsentDefault {
  const code = country?.trim().toUpperCase() ?? ""

  if (!/^[A-Z]{2}$/.test(code) || ["XX", "T1", "ZZ"].includes(code)) return null

  if (ASK_FIRST_COUNTRIES.has(code)) return null

  return objection ? "rejected" : "accepted"
}

/** DNT: 1 or Sec-GPC: 1 on the request. @public */
export function requestObjects(headers: Headers): boolean {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1"
}

/** An objection overrides both an explicit acceptance and a regional default. */
export function browserObjects(): boolean {
  if (typeof navigator === "undefined") return false

  // SAFETY: Optional privacy fields are only read and compared with fixed values.
  const privacyNavigator = navigator as Navigator & {
    globalPrivacyControl?: boolean
    msDoNotTrack?: string
  }

  // SAFETY: The optional legacy field is read only after the browser-window guard.
  const windowSignal =
    typeof window === "undefined"
      ? undefined
      : (window as Window & { doNotTrack?: string }).doNotTrack

  return (
    privacyNavigator.globalPrivacyControl === true ||
    [navigator.doNotTrack, privacyNavigator.msDoNotTrack, windowSignal].some(
      (signal) => signal === "1" || signal === "yes",
    )
  )
}

/**
 * Browser: this page's default from the product's uncached endpoint (it answers `{ choice }` from the request's edge
 * country). The answer lives in memory for one page and is never stored as consent. A failed lookup asks.
 * @public
 */
export function fetchConsentDefault(
  url = "/api/consent-default",
): Promise<ConsentDefault> {
  return fetch(url, { cache: "no-store", credentials: "omit" })
    .then((response) => (response.ok ? response.json() : { choice: null }))
    .then(({ choice }: { choice?: unknown }) =>
      choice === "accepted" || choice === "rejected" ? choice : null,
    )
    .catch(() => null)
}

/**
 * Default-basis sampling (analytics standard, Regions): default-on traffic shares the free PostHog allowance and
 * the Sentry reserve, so it is sampled; explicit acceptance is not. Events from 20% of browsers, replay for 10% (within
 * the event sample), 25% of browser error reports. Products import the ones their adapters use, hence @public.
 */
/** @public */
export const DEFAULT_BASIS_EVENT_PERCENT = 20

/** @public */
export const DEFAULT_BASIS_REPLAY_PERCENT = 10

/** @public */
export const DEFAULT_BASIS_REPORT_RATE = 0.25

/**
 * PostHog's own distinct-ID sampling hash, so a browser is wholly in or out of the default-basis sample (and its
 * replay bucket) for its cookie's lifetime.
 * @public
 */
export function inDefaultBasisSample(
  distinctId: string | null | undefined,
  percent: number,
): boolean {
  if (distinctId == null) return false
  let hash = 0

  for (let index = 0; index < distinctId.length; index++) {
    hash = ((hash << 5) - hash + distinctId.charCodeAt(index)) | 0
  }

  return Math.abs(hash) % 100 < percent
}
