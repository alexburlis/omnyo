export interface FamilyThread {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  shelvedAt: number | null;
}

export function familyRoots(threads: readonly FamilyThread[]): Map<string, string> {
  const parents = new Map(threads.map((thread) => [thread.id, thread.parentThreadId]));
  const roots = new Map<string, string>();

  for (const thread of threads) {
    const seen = new Set([thread.id]);
    let root = thread.id;
    let parent = thread.parentThreadId;

    while (parent !== null && parents.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      root = parent;
      parent = parents.get(parent) ?? null;
    }

    roots.set(thread.id, root);
  }

  return roots;
}
