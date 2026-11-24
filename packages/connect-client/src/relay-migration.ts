const LEGACY_APEXES = [
  ["stg.slashnew.com", "stg.omnyo.link"],
  ["slashnew.com", "omnyo.link"],
] as const;

export const PRIVATE_APP_HOSTNAME = "app.example.invalid";

function secureUrl(value: string): URL | null {
  try {
    const url = new URL(value);

    return url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
      ? url
      : null;
  } catch {
    return null;
  }
}

export function migrateLegacyRelayApexUrl(value: string): string | null {
  const url = secureUrl(value);

  if (!url || url.pathname !== "/" || url.search || url.hash) return null;
  const mapping = LEGACY_APEXES.find(([oldApex]) => url.hostname === oldApex);

  return mapping ? `https://${mapping[1]}` : null;
}

function replaceHostname(value: string, url: URL, hostname: string): string {
  url.hostname = hostname;
  const migrated = url.toString();

  return url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    !value.endsWith("/")
    ? migrated.slice(0, -1)
    : migrated;
}

export function migrateLegacyPrivateServerUrl(value: string): string | null {
  const url = secureUrl(value);

  return url?.hostname === "app.example.invalid"
    ? replaceHostname(value, url, PRIVATE_APP_HOSTNAME)
    : null;
}

export function migrateLegacyRelayServerUrl(value: string): string | null {
  const url = secureUrl(value);

  if (!url) return null;

  for (const [oldApex, newApex] of LEGACY_APEXES) {
    const suffix = `.${oldApex}`;

    if (!url.hostname.endsWith(suffix)) continue;
    const label = url.hostname.slice(0, -suffix.length);

    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) return null;

    if (oldApex === "slashnew.com" && label === "stg") return null;

    return replaceHostname(value, url, `${label}.${newApex}`);
  }

  return null;
}
