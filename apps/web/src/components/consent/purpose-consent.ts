// Shared source: product-launch/assets/browser-consent. Use install-consent.py.
export type StoredChoice = "accepted" | "rejected"

const blocked = new Set<string>()

/** Fail closed in this document when a write cannot be confirmed. */
export function blockConsent(names: string[]): void {
  names.forEach((name) => blocked.add(name))
}

export function readConsentValue(
  name: string,
  cookieHeader?: string,
): string | undefined {
  if (cookieHeader === undefined && blocked.has(name)) return undefined

  const cookies =
    cookieHeader ?? (typeof document === "undefined" ? "" : document.cookie)

  return cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

export function parsePurposeConsent(
  value: string | undefined,
  maxAgeSeconds: number,
): StoredChoice | null {
  const match = /^(accepted|rejected):([1-9]\d*)$/.exec(value ?? "")

  if (!match) return null
  const choice = match[1] === "accepted" ? "accepted" : "rejected"
  const timestamp = Number(match[2])
  const age = Date.now() - timestamp

  return Number.isSafeInteger(timestamp) &&
    age >= 0 &&
    age < maxAgeSeconds * 1000
    ? choice
    : null
}

export function readPurposeConsent(
  name: string,
  maxAgeSeconds: number,
): StoredChoice | null {
  return parsePurposeConsent(readConsentValue(name), maxAgeSeconds)
}

/** The caller must not enable providers until every purpose write succeeds. */
export function writeConsentValue(
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  try {
    document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`

    if (readConsentValue(name, document.cookie) !== value)
      throw new Error("Consent storage unavailable")
    blocked.delete(name)
  } catch (error) {
    blocked.add(name)
    throw error
  }
}

export function writePurposeConsent(
  name: string,
  enabled: boolean,
  maxAgeSeconds: number,
): void {
  writeConsentValue(
    name,
    `${enabled ? "accepted" : "rejected"}:${Date.now()}`,
    maxAgeSeconds,
  )
}
