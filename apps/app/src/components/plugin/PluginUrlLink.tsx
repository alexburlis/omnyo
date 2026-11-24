import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { previewBindingSchema } from "@omnyo/server-contract";
import type { UrlLinkProps } from "@omnyo/plugin-sdk";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { resolveRouteHref } from "@/lib/route-paths";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { apiClient } from "@/lib/api-server";
import {
  parseManagedPreviewHref,
  resolveManagedPreviewHref,
  type ManagedPreviewHref,
} from "@/lib/managed-preview-url";

function shouldHandleUrlClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.currentTarget.hasAttribute("download") ||
    event.currentTarget.hasAttribute("target")
  ) {
    return false;
  }

  return true;
}

function isCurrentAppRoute(href: string): boolean {
  return (
    typeof window !== "undefined" &&
    resolveRouteHref({ currentOrigin: window.location.origin, href }) !== null
  );
}

export function PluginUrlLink(props: UrlLinkProps) {
  const preview =
    typeof window === "undefined"
      ? null
      : parseManagedPreviewHref(props.href, window.location.origin);

  return preview === null ? (
    <PluginUrlAnchor {...props} />
  ) : (
    <PluginManagedPreviewUrlLink {...props} preview={preview} />
  );
}

function PluginManagedPreviewUrlLink({
  preview,
  ...props
}: UrlLinkProps & { preview: ManagedPreviewHref }) {
  const { localDaemonHostId } = useHostDaemon();

  const binding = useQuery({
    queryKey: ["managed-preview-binding", preview.previewId],
    enabled: localDaemonHostId !== null,
    queryFn: async ({ signal }) => {
      const response = await apiClient.previews[":previewId"].$get(
        { param: { previewId: preview.previewId } },
        { init: { signal } },
      );

      if (!response.ok)
        throw new Error("Could not resolve the preview's computer");

      return previewBindingSchema.parse(await response.json());
    },
    staleTime: 10000,
    retry: false,
  });

  const href = resolveManagedPreviewHref({
    href: props.href,
    preview,
    binding: binding.data,
    viewerHostId: localDaemonHostId,
  });

  return <PluginUrlAnchor {...props} href={href} />;
}

function PluginUrlAnchor({
  href,
  onClick,
  rel,
  target,
  ...anchorProps
}: UrlLinkProps) {
  const navigation = useAppNavigationHost();

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);

      if (
        !shouldHandleUrlClick(event) ||
        isCurrentAppRoute(href) ||
        !navigation.openUrl({ url: href })
      ) {
        return;
      }

      event.preventDefault();
    },
    [href, navigation, onClick],
  );

  const normalizedTarget = target?.toLowerCase();

  const opensNewBrowsingContext =
    normalizedTarget !== undefined &&
    normalizedTarget !== "" &&
    normalizedTarget !== "_self" &&
    normalizedTarget !== "_parent" &&
    normalizedTarget !== "_top" &&
    normalizedTarget !== "_unfencedtop";

  const relTokens = rel?.split(/\s+/u).filter(Boolean) ?? [];
  const normalizedRelTokens = relTokens.map((token) => token.toLowerCase());

  const resolvedRel =
    opensNewBrowsingContext && !normalizedRelTokens.includes("opener")
      ? [
          ...relTokens,
          ...(normalizedRelTokens.includes("noopener") ? [] : ["noopener"]),
          ...(normalizedRelTokens.includes("noreferrer") ? [] : ["noreferrer"]),
        ].join(" ")
      : rel;

  if (target !== undefined) {
    return (
      <a
        {...anchorProps}
        href={href}
        target={target}
        rel={resolvedRel}
        onClick={handleClick}
      />
    );
  }

  return (
    <RouteAnchor
      {...anchorProps}
      href={href}
      rel={resolvedRel}
      onClick={handleClick}
    />
  );
}
