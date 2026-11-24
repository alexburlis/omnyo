import {
  deriveConnectBaseUrl,
  PRIVATE_APP_HOSTNAME,
} from "@omnyo/connect-client";

const RELAY_APEX_HOSTS = new Set(["omnyo.link", "stg.omnyo.link"]);

export function isSupportedRelayApex(apexUrl: string): boolean {
  let url: URL;

  try {
    url = new URL(apexUrl);
  } catch {
    return false;
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return false;

  if (url.hostname === "localhost") {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  return (
    url.protocol === "https:" &&
    url.port === "" &&
    RELAY_APEX_HOSTS.has(url.hostname)
  );
}

export function isSupportedRelayServer(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);

    if (
      url.hostname === PRIVATE_APP_HOSTNAME ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return false;
    const label = url.hostname.split(".")[0] ?? "";

    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) return false;

    return isSupportedRelayApex(deriveConnectBaseUrl(serverUrl));
  } catch {
    return false;
  }
}
