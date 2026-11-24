import type { ReactNode } from "react";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import type { IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { getBrowserUrlHost } from "@/lib/browser-url";
import { isLocalOnlyUrl } from "@/lib/loopback-hostname";

export interface BrowserStatePageProps {
  icon: IconName;
  tone?: "neutral" | "error";
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  detailLabel?: string;
  detail?: string | null;
  className?: string;
}

export function BrowserStatePage({
  icon,
  tone = "neutral",
  title,
  description,
  actions,
  detailLabel,
  detail = null,
  className,
}: BrowserStatePageProps) {
  const shownDetail = detail !== null && detail.length > 0 ? detail : null;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-y-auto px-4",
        className,
      )}
    >
      <div className="my-auto flex w-full flex-col items-center">
        <EmptyStateBlock
          icon={icon}
          tone={tone}
          title={title}
          description={description}
          actions={actions}
          className={cn("w-full max-w-md py-8", shownDetail !== null && "pb-0")}
        />
        {shownDetail === null ? null : (
          <p
            className="mt-4 mb-8 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-surface-recessed px-2 py-1 text-2xs text-muted-foreground"
            title={shownDetail}
          >
            {detailLabel === undefined ? null : (
              <span className="shrink-0">{detailLabel}</span>
            )}
            <span className="min-w-0 truncate font-mono text-foreground select-text">
              {shownDetail}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

export interface BrowserPageLoadErrorCopy {
  icon: IconName;
  title: string;
  description: string;
}

function errorMatches(errorText: string, codes: readonly string[]): boolean {
  const upper = errorText.toUpperCase();

  return codes.some((code) => upper.includes(code));
}

export function describeBrowserPageLoadError({
  errorText,
  url,
}: {
  errorText: string;
  url: string;
}): BrowserPageLoadErrorCopy {
  const host = getBrowserUrlHost(url);
  const place = host.length > 0 ? host : "this address";

  if (errorMatches(errorText, ["RENDERER"])) {
    return {
      icon: "AlertTriangle",
      title: "This page stopped working",
      description:
        "The page crashed while it was open. Try again to reload it, or open it in your own browser.",
    };
  }

  if (isLocalOnlyUrl(url)) {
    return {
      icon: "Plug02",
      title: errorMatches(errorText, ["CONNECTION_REFUSED"])
        ? `Nothing is running on ${place}`
        : `Can’t reach ${place}`,
      description:
        "Start the server for this project, then try again. If it uses a different port, change the address above.",
    };
  }

  if (errorMatches(errorText, ["INTERNET_DISCONNECTED", "NETWORK_CHANGED"])) {
    return {
      icon: "CloudOff",
      title: "You’re offline",
      description: "Connect to the internet, then try again.",
    };
  }

  if (errorMatches(errorText, ["NAME_NOT_RESOLVED", "NAME_RESOLUTION"])) {
    return {
      icon: "Search",
      title: `Can’t find ${place}`,
      description:
        "Check the address for typos. The site may also be down, or your network may be blocking it.",
    };
  }

  if (errorMatches(errorText, ["TIMED_OUT"])) {
    return {
      icon: "Clock",
      title: `${place} took too long to answer`,
      description: "The site may be busy or down. Try again in a moment.",
    };
  }

  if (errorMatches(errorText, ["CERT_", "SSL_"])) {
    return {
      icon: "ShieldOff",
      title: "This connection isn’t private",
      description: `The browser couldn’t verify ${place}’s security certificate, so it didn’t load the page.`,
    };
  }

  if (errorMatches(errorText, ["BLOCKED_BY"])) {
    return {
      icon: "Unavailable",
      title: "This page was blocked",
      description:
        "The browser blocked this page from loading here. Opening it in your own browser may work.",
    };
  }

  return {
    icon: "Globe",
    title: "This page didn’t load",
    description: `The browser couldn’t reach ${place}. Try again, or open it in your own browser.`,
  };
}
