import type { GuideMeta } from "../guides/guide-types";

export interface ContentLink {
  label: string;
  href: string;
}

export interface ContentGroup {
  label: string;
  links: ContentLink[];
}

const GUIDE_MODULES = import.meta.glob<GuideMeta>("../guides/pages/*.meta.ts", {
  eager: true,
  import: "meta",
});

function metas<T>(modules: Record<string, T>): T[] {
  return Object.values(modules);
}

function once<T>(build: () => T): () => T {
  let value: { built: T } | null = null;

  return () => {
    value ??= { built: build() };

    return value.built;
  };
}

function guidePath(meta: GuideMeta): string {
  return `/guides/${meta.slug}`;
}

const navGuides = once(() =>
  metas(GUIDE_MODULES)
    .flatMap((meta) => (meta.nav ? [{ meta, nav: meta.nav }] : []))
    .sort((a, b) => a.nav.order - b.nav.order),
);

export const guideLinks = once((): ContentLink[] =>
  navGuides().map(({ meta }) => ({ label: meta.title, href: guidePath(meta) })),
);

export const guideFooterLinks = once((): ContentLink[] =>
  navGuides().map(({ meta, nav }) => ({
    label: nav.label,
    href: guidePath(meta),
  })),
);

export const guideMenu = once((): (ContentGroup | ContentLink)[] =>
  navGuides().reduce<(ContentGroup | ContentLink)[]>((menu, { meta, nav }) => {
    const link = { label: nav.label, href: guidePath(meta) };

    if (nav.group === null) {
      return [...menu, link];
    }

    const existing = menu.find(
      (item): item is ContentGroup =>
        "links" in item && item.label === nav.group,
    );

    if (existing) {
      existing.links.push(link);

      return menu;
    }

    return [...menu, { label: nav.group, links: [link] }];
  }, []),
);

const canonicalPaths = once((): Record<string, string> =>
  Object.fromEntries(
    metas(GUIDE_MODULES).flatMap((meta) =>
      meta.canonical ? [[guidePath(meta), meta.canonical]] : [],
    ),
  ),
);

export function canonicalPath(path: string): string {
  return canonicalPaths()[path] ?? path;
}

export const contentPaths = once((): string[] =>
  metas(GUIDE_MODULES)
    .filter((meta) => meta.canonical === null)
    .map(guidePath),
);
