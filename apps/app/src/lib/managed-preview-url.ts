import { parseLoopbackPreviewUrl } from "@omnyo/client-core";
import type { PreviewBinding } from "@omnyo/server-contract";

export interface ManagedPreviewHref {
  previewId: string;
  pathname: string;
  search: string;
  hash: string;
}

export function parseManagedPreviewHref(
  href: string,
  currentOrigin: string,
): ManagedPreviewHref | null {
  try {
    const url = new URL(href, currentOrigin);

    if (
      url.origin !== currentOrigin ||
      url.username !== "" ||
      url.password !== ""
    )
      return null;
    const match = /^\/preview\/([^/]+)(\/.*)?$/u.exec(url.pathname);

    if (!match) return null;
    const previewId = decodeURIComponent(match[1]);

    if (!previewId || /[\/\\\u0000-\u001f\u007f]/u.test(previewId)) return null;

    return {
      previewId,
      pathname: match[2] ?? "/",
      search: url.search,
      hash: url.hash,
    };
  } catch {
    return null;
  }
}

export function resolveManagedPreviewHref({
  href,
  preview,
  binding,
  viewerHostId,
}: {
  href: string;
  preview: ManagedPreviewHref;
  binding: Pick<PreviewBinding, "id" | "hostId" | "url"> | undefined;
  viewerHostId: string | null;
}): string {
  if (
    !binding ||
    binding.id !== preview.previewId ||
    binding.hostId !== viewerHostId
  )
    return href;
  const local = parseLoopbackPreviewUrl(binding.url);

  if (!local) return href;

  if (local.protocol === "http:" && local.hostname === "127.0.0.1")
    local.hostname = "localhost";
  local.pathname = preview.pathname;
  local.search = preview.search;
  local.hash = preview.hash;

  return local.href;
}
