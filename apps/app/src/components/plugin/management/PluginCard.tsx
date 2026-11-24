import type { ReactNode } from "react";
import {
  ResourceBrowseCard,
  ResourceBrowseGrid,
} from "@omnyo/shared-ui/resource-list";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { PluginAuthorAvatar } from "./PluginAuthorAvatar";
import { PluginAuthorLink } from "./PluginAuthorLink";
import { PluginOfficialBadge } from "./PluginOfficialBadge";
import {
  isOmnyoAuthoredEntry,
  OMNYO_AUTHOR_NAME,
  pluginAuthorGithub,
} from "./plugin-marketplace-author";

export function PluginCardGrid({ children }: { children: ReactNode }) {
  return (
    <ResourceBrowseGrid className="w-full grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-2">
      {children}
    </ResourceBrowseGrid>
  );
}

interface PluginCardProps {
  title: string;
  description: ReactNode;
  leading: ReactNode;
  byline: ReactNode;
  footerAction: ReactNode;
  openLabel: string;
  onOpen: (trigger: HTMLButtonElement) => void;
}

export function PluginCard({
  byline,
  footerAction,
  ...props
}: PluginCardProps) {
  return (
    <ResourceBrowseCard
      {...props}
      className="h-full min-h-36 grid-cols-[minmax(0,1fr)_0px] gap-x-0 gap-y-2 rounded-xl p-3"
      leadingClassName="size-6"
      description={
        <span className="block min-h-[2lh]">{props.description}</span>
      }
      title={
        <span className="line-clamp-2 whitespace-normal">{props.title}</span>
      }
      footer={
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-subtle-foreground">
          <span className="min-w-0 truncate">{byline}</span>
          <span className="pointer-events-auto shrink-0">{footerAction}</span>
        </div>
      }
    />
  );
}

interface PluginAuthorBylineProps {
  name: string;
  github: string | null;
  omnyoLogo?: boolean;
  official?: boolean;
  children: ReactNode;
}

export function PluginAuthorByline({
  name,
  github,
  omnyoLogo,
  official = false,
  children,
}: PluginAuthorBylineProps) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <PluginAuthorAvatar
        name={name}
        github={github}
        omnyoLogo={omnyoLogo}
        size="detail"
      />
      <span className="min-w-0 truncate">{children}</span>
      {official ? <PluginOfficialBadge /> : null}
    </span>
  );
}

export function OmnyoAuthorByline({ official }: { official: boolean }) {
  return (
    <PluginAuthorByline
      name={OMNYO_AUTHOR_NAME}
      github={null}
      omnyoLogo
      official={official}
    >
      {OMNYO_AUTHOR_NAME}
    </PluginAuthorByline>
  );
}

interface PluginCardAuthorProps {
  entry: Pick<
    PluginCatalogSearchEntry,
    "author" | "marketplace" | "publisherLabel" | "official"
  >;
}

function pluginCardAuthorName(entry: PluginCardAuthorProps["entry"]): string {
  return isOmnyoAuthoredEntry(entry)
    ? OMNYO_AUTHOR_NAME
    : (entry.author?.name ?? entry.publisherLabel);
}

export function PluginCardAuthorAvatar({ entry }: PluginCardAuthorProps) {
  return (
    <PluginAuthorAvatar
      name={pluginCardAuthorName(entry)}
      github={pluginAuthorGithub(entry.author)}
      omnyoLogo={isOmnyoAuthoredEntry(entry)}
      size="detail"
    />
  );
}

export function PluginCardAuthorName({ entry }: PluginCardAuthorProps) {
  const name = pluginCardAuthorName(entry);

  return entry.author === null ? (
    name
  ) : (
    <PluginAuthorLink
      entry={entry}
      className="pointer-events-auto relative z-10 rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {name}
    </PluginAuthorLink>
  );
}

export function PluginCardAuthor({ entry }: PluginCardAuthorProps) {
  return (
    <PluginAuthorByline
      name={pluginCardAuthorName(entry)}
      github={pluginAuthorGithub(entry.author)}
      omnyoLogo={isOmnyoAuthoredEntry(entry)}
      official={entry.official}
    >
      <PluginCardAuthorName entry={entry} />
    </PluginAuthorByline>
  );
}
