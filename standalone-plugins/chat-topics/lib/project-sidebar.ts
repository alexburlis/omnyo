import type {
  ExperimentalProjectSidebarGroup,
  ExperimentalProjectSidebarItem,
  PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";

export function projectSidebarClaims(
  groups: readonly ExperimentalProjectSidebarGroup[],
  projectIds: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const claims = new Map<string, Set<string>>();

  function visit(items: readonly ExperimentalProjectSidebarItem[], ids: Set<string>) {
    for (const item of items) {
      if (item.threadId) ids.add(item.threadId);

      if (item.children) visit(item.children, ids);
    }
  }

  for (const group of groups) {
    if (!projectIds.has(group.projectId)) continue;
    const ids = claims.get(group.projectId) ?? new Set<string>();
    visit(group.items, ids);
    claims.set(group.projectId, ids);
  }

  return claims;
}

export function unclaimedProjectThreads<T extends Pick<PluginSidebarThread, "id" | "projectId">>(
  threads: readonly T[],
  claims: ReadonlyMap<string, ReadonlySet<string>>,
  view: "projects" | "inbox",
): readonly T[] {
  return view === "inbox"
    ? threads
    : threads.filter((thread) => !claims.get(thread.projectId)?.has(thread.id));
}
