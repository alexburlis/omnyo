import type { PluginCatalogAuthor } from "@omnyo/server-contract";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";

const GITHUB_AUTHOR_PREFIX = "github:";

const NAME_AUTHOR_PREFIX = "name:";

export const OMNYO_AUTHOR_NAME = "Omnyo";

export function isOmnyoAuthoredEntry(
  entry: Pick<PluginCatalogSearchEntry, "author" | "marketplace">,
): boolean {
  return (
    entry.marketplace === "omnyo-official" &&
    (entry.author === null || entry.author.name === OMNYO_AUTHOR_NAME)
  );
}

export function pluginAuthorGithub(
  author: PluginCatalogAuthor | null,
): string | null {
  return author?.github ?? null;
}

export function pluginMarketplaceAuthorKey(
  entry: Pick<PluginCatalogSearchEntry, "author" | "marketplace">,
): string | null {
  if (entry.author === null) return null;
  const github = pluginAuthorGithub(entry.author);

  const identity =
    github !== null
      ? `${GITHUB_AUTHOR_PREFIX}${github.toLowerCase()}`
      : `${NAME_AUTHOR_PREFIX}${entry.author.name}`;

  return `${entry.marketplace.length}:${entry.marketplace}:${identity}`;
}

export function entriesByMarketplaceAuthor<
  Entry extends Pick<PluginCatalogSearchEntry, "author" | "marketplace">,
>(entries: readonly Entry[], authorKey: string): Entry[] {
  return entries.filter(
    (entry) => pluginMarketplaceAuthorKey(entry) === authorKey,
  );
}
