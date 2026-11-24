export const REWRITE_LOCALHOST_LINKS_STORAGE_KEY =
  "omnyo.rewriteLocalhostLinks";

export const REWRITE_LOCALHOST_LINKS_DEFAULT = true;

interface RewriteLocalhostLinkHrefArgs {
  enabled: boolean;
  href: string | undefined;
  sourceHostId?: string | null;
  viewerHostId?: string | null;
  remoteBaseUrl?: string;
}

export function parseLoopbackPreviewUrl(href: string | undefined): URL | null {
  if (href === undefined) return null;

  try {
    const url = new URL(href);

    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(
        url.hostname.toLowerCase(),
      ) &&
      url.username === "" &&
      url.password === ""
      ? url
      : null;
  } catch {
    return null;
  }
}

export function rewriteLocalhostLinkHref({
  enabled,
  href,
  sourceHostId,
  viewerHostId,
  remoteBaseUrl,
}: RewriteLocalhostLinkHrefArgs): string | undefined {
  const url = parseLoopbackPreviewUrl(href);

  if (
    !enabled ||
    url === null ||
    (sourceHostId && sourceHostId === viewerHostId) ||
    remoteBaseUrl === undefined
  )
    return href;

  return `${remoteBaseUrl}${url.pathname}${url.search}${url.hash}`;
}
