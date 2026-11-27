import { type PluginApi } from "@omnyo/plugin-sdk";
import type { createLibraryStore } from "./library-store.ts";
import type { ComposerDraft } from "@omnyo/plugin-sdk";
import {
  type PromptRow,
  type SearchPromptsInput,
  storedStarredPromptSchema,
} from "./prompt-contract.ts";
import { createHistoryCache, type HistoryCandidate } from "./prompt-history-cache.ts";
import { buildSnippet, createSearchIndex, matchPositions, queryTerms } from "./prompt-ranking.ts";
import { createStarredPromptStore, type StarredPrompt } from "./prompt-store.ts";

const STARRED_RESULT_LIMIT = 20;

const RECENT_RESULT_LIMIT = 30;

const SAVED_RESULT_LIMIT = 30;

type SearchExtra = { item: SearchItem; text: string; time: number };

type SavedItem = ReturnType<ReturnType<typeof createLibraryStore>["savedPrompts"]>[number];

const INDEX_CHUNK_SIZE = 500;

type SearchItem =
  | { kind: "starred"; prompt: StarredPrompt }
  | { kind: "recent"; candidate: HistoryCandidate }
  | { kind: "saved"; saved: SavedItem };

export function createPromptService(
  api: PluginApi,
  library: ReturnType<typeof createLibraryStore>,
) {
  const store = createStarredPromptStore(api.storage.database());
  let migration: Promise<void> | null = null;
  let migratedLegacy: string | null = null;

  async function migrateRunningLegacy() {
    const { plugins } = await api.sdk.plugins.list();

    const legacy = plugins.find((plugin) => plugin.id === "omnyo--prompt-library");

    if (!legacy) {
      migratedLegacy = null;

      return;
    }

    const version = /^(\d+)\.(\d+)\./u.exec(legacy.version);

    if (
      !legacy.enabled ||
      legacy.status !== "running" ||
      version === null ||
      (Number(version[1]) === 0 && Number(version[2]) < 2)
    ) {
      migratedLegacy = null;

      if (store.hasLegacySnapshot()) return;
      throw new Error(
        "Prompt Library migration is waiting for its saved prompts. Update and enable Prompt Library, then retry.",
      );
    }

    const source = `${legacy.source}:${legacy.version}`;

    if (migratedLegacy === source) return;

    const result = await api.sdk.plugins.callRpc({
      pluginId: legacy.id,
      method: "exportStarred",
      input: null,
      outputSchema: storedStarredPromptSchema.array(),
    });

    store.importLegacy({
      sourceId: "omnyo--prompt-library",
      prompts: storedStarredPromptSchema.array().parse(result),
    });
    migratedLegacy = source;
  }

  async function ensureMigrated() {
    const current = migration ?? migrateRunningLegacy();
    migration = current;

    try {
      await current;
    } finally {
      if (migration === current) migration = null;
    }
  }

  const historyCache = createHistoryCache((args) => api.sdk.experimental_promptHistory.list(args));

  const index = createSearchIndex<SearchItem>();
  let indexedCount = 0;
  let indexing: Promise<readonly HistoryCandidate[]> = Promise.resolve([]);

  async function indexNewHistory(): Promise<readonly HistoryCandidate[]> {
    const candidates = await historyCache.refresh();

    while (indexedCount < candidates.length) {
      const chunkEnd = Math.max(0, candidates.length - indexedCount - INDEX_CHUNK_SIZE);

      for (
        let position = candidates.length - indexedCount - 1;
        position >= chunkEnd;
        position -= 1
      ) {
        const candidate = candidates[position]!;
        index.add({
          item: { kind: "recent", candidate },
          text: candidate.prompt.text,
          time: candidate.createdAt,
        });
        indexedCount += 1;
      }

      await new Promise((resolve) => setImmediate(resolve));
    }

    return candidates;
  }

  function loadHistory(): Promise<readonly HistoryCandidate[]> {
    indexing = indexing.catch(() => []).then(indexNewHistory);

    return indexing;
  }

  function inScope(candidate: HistoryCandidate, input: SearchPromptsInput) {
    if (input.scope === "thread") return candidate.threadId === input.threadId;

    if (input.scope === "project") {
      return candidate.projectId === input.projectId;
    }

    return true;
  }

  function historySearchable(input: SearchPromptsInput): boolean {
    if (input.scope === "thread") return input.threadId !== null;

    if (input.scope === "project") return input.projectId !== null;

    return true;
  }

  function orderedItems(
    input: SearchPromptsInput,
    starredPrompts: readonly StarredPrompt[],
    history: readonly HistoryCandidate[],
    savedPrompts: readonly SavedItem[],
  ): SearchItem[] {
    const searching = queryTerms(input.query).length > 0;

    const items: SearchItem[] = searching
      ? index
          .search(
            input.query,
            [
              ...starredPrompts.map((prompt): SearchExtra => ({
                item: { kind: "starred", prompt },
                text: prompt.prompt.text,
                time: prompt.lastUsedAt ?? prompt.createdAt,
              })),
              ...savedPrompts.map((saved): SearchExtra => ({
                item: { kind: "saved", saved },
                text: saved.body,
                time: Date.now(),
              })),
            ],
            Date.now(),
            (item) =>
              item.kind !== "recent" ||
              item.candidate.scope === (input.composer === "new-thread" ? "project" : "thread"),
          )
          .map((match) => match.item)
      : [
          ...starredPrompts.map((prompt): SearchItem => ({
            kind: "starred",
            prompt,
          })),
          ...savedPrompts.map((saved): SearchItem => ({ kind: "saved", saved })),
          ...history.map((candidate): SearchItem => ({
            kind: "recent",
            candidate,
          })),
        ];

    const starredTexts = new Set(starredPrompts.map((prompt) => prompt.prompt.text));

    const seenTexts = new Set(searching ? starredPrompts.map((prompt) => prompt.prompt.text) : []);

    const includeHistory = historySearchable(input);
    let starredCount = 0;
    let recentCount = 0;
    let savedCount = 0;
    const ordered: SearchItem[] = [];

    for (const item of items) {
      if (item.kind === "starred") {
        if (starredCount === STARRED_RESULT_LIMIT) continue;
        starredCount += 1;
        ordered.push(item);

        continue;
      }

      if (item.kind === "saved") {
        if (
          savedCount === SAVED_RESULT_LIMIT ||
          seenTexts.has(item.saved.body) ||
          starredTexts.has(item.saved.body)
        )
          continue;
        savedCount += 1;
        seenTexts.add(item.saved.body);
        ordered.push(item);
        continue;
      }

      const { candidate } = item;
      const text = candidate.prompt.text;

      if (!includeHistory || recentCount === RECENT_RESULT_LIMIT) continue;

      if (!inScope(candidate, input)) continue;

      if (text.trim().length === 0 || seenTexts.has(text)) continue;
      seenTexts.add(text);
      recentCount += 1;
      ordered.push(item);
    }

    return ordered;
  }

  async function projectNames(projectIds: ReadonlySet<string>): Promise<Map<string, string>> {
    if (projectIds.size === 0) return new Map();
    const projects = await api.sdk.projects.list({ includePersonal: true });

    return new Map(
      projects
        .filter((project) => projectIds.has(project.id))
        .map((project) => [project.id, project.name]),
    );
  }

  function snippet(text: string, query: string) {
    return buildSnippet(text, matchPositions(text, query));
  }

  async function search(input: SearchPromptsInput, includeSaved = true) {
    await ensureMigrated();
    const starredPrompts = store.list();

    const starredIdsByText = new Map(
      starredPrompts.map((prompt) => [prompt.prompt.text, prompt.id]),
    );

    const savedPrompts = (includeSaved ? library.savedPrompts() : []).filter((prompt) => {
      if (input.scope === "global") return true;

      return (
        prompt.projectId === input.projectId &&
        (input.environmentId === undefined || prompt.environmentId === input.environmentId)
      );
    });

    const history = historySearchable(input) ? await loadHistory() : [];
    const items = orderedItems(input, starredPrompts, history, savedPrompts);

    const names = await projectNames(
      new Set(items.flatMap((item) => (item.kind === "recent" ? [item.candidate.projectId] : []))),
    );

    const prompts = items.map((item): PromptRow => {
      if (item.kind === "starred") {
        const { prompt } = item;

        return {
          kind: "starred",
          id: prompt.id,
          prompt: prompt.prompt,
          snippet: snippet(prompt.prompt.text, input.query),
          createdAt: prompt.createdAt,
          lastUsedAt: prompt.lastUsedAt,
        };
      }

      if (item.kind === "saved") {
        return {
          kind: "saved",
          id: item.saved.id,
          title: item.saved.title,
          prompt: { text: item.saved.body, mentions: [] },
          snippet: snippet(item.saved.body, input.query),
          projectId: item.saved.projectId,
          environmentId: item.saved.environmentId,
          starredId: starredIdsByText.get(item.saved.body) ?? null,
        };
      }

      const { candidate } = item;
      const text = candidate.prompt.text;

      return {
        kind: "recent",
        id: candidate.id,
        prompt: candidate.prompt,
        snippet: snippet(text, input.query),
        createdAt: candidate.createdAt,
        projectId: candidate.projectId,
        projectName: names.get(candidate.projectId) ?? null,
        threadId: candidate.threadId,
        starredId: starredIdsByText.get(text) ?? null,
      };
    });

    return { prompts };
  }

  async function star(prompt: ComposerDraft): Promise<StarredPrompt> {
    await ensureMigrated();
    const starred = store.star(prompt, Date.now());

    if (starred === null) {
      throw new Error("A starred prompt needs some text.");
    }

    return starred;
  }

  return {
    search: (input: SearchPromptsInput) => search(input),
    searchLegacy: (input: SearchPromptsInput) => search(input, false),
    star: async ({ prompt }: { prompt: ComposerDraft }) => ({ id: (await star(prompt)).id }),
    unstar: async ({ id }: { id: string }) => {
      await ensureMigrated();

      return { unstarred: store.unstar(id) };
    },
    markUsed: async ({ id }: { id: string }) => {
      await ensureMigrated();
      store.markUsed(id, Date.now());

      return null;
    },
    listStarred: async () => {
      await ensureMigrated();

      return store.list();
    },
    importLegacyPrompts: (input: Parameters<typeof store.importLegacy>[0]) => ({
      imported: store.importLegacy(input),
    }),
    promptLibraryStatus: async () => {
      await ensureMigrated();

      return { version: 1 as const };
    },
  };
}
