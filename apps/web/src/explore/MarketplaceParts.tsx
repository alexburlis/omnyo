import Bug01Icon from "@hugeicons/core-free-icons/Bug01Icon";
import GithubIcon from "@hugeicons/core-free-icons/GithubIcon";
import Plug01Icon from "@hugeicons/core-free-icons/Plug01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MouseEvent } from "react";

import { KindIcon } from "./ExploreParts";
import type { MarketplaceItem } from "./marketplace";
import { highlightParts, isOmnyoEdition } from "./marketplace-view";

const listingIcons = {
  skill: "guide",
  workflow: "workflow",
} as const;

const connectorIcons: Record<string, typeof Plug01Icon> = {
  "workspace-github": GithubIcon,
  sentry: Bug01Icon,
};

export function ConnectorIcon({
  pluginId,
  className,
}: {
  pluginId: string;
  className?: string;
}) {
  return (
    <HugeiconsIcon
      icon={connectorIcons[pluginId] ?? Plug01Icon}
      className={className}
      aria-hidden
    />
  );
}

export function ListingIcon({
  item,
  className,
}: {
  item: MarketplaceItem;
  className?: string;
}) {
  const tone =
    item.kind === "workflow"
      ? "mk-kind mk-kind-workflow"
      : item.kind === "connector" || isOmnyoEdition(item)
        ? "mk-kind mk-kind-omnyo"
        : "mk-kind";

  return (
    <span className={className ? `${tone} ${className}` : tone}>
      {item.kind === "connector" ? (
        <ConnectorIcon pluginId={item.pluginId} className="mk-kind-icon" />
      ) : (
        <KindIcon kind={listingIcons[item.kind]} className="mk-kind-icon" />
      )}
    </span>
  );
}

export function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : part.text,
      )}
    </>
  );
}

export function onPlainClick(action: () => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;

    event.preventDefault();
    action();
  };
}

export function ListingBadge({ item }: { item: MarketplaceItem }) {
  if (item.kind === "workflow") return <em className="mk-badge">Workflow</em>;

  if (item.kind === "connector") return <em className="mk-badge">Connector</em>;

  return isOmnyoEdition(item) ? <em className="mk-badge">Omnyo</em> : null;
}
