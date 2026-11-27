import {
  cliCommand,
  defineCli,
  PluginCliError,
  type PluginApi,
} from "@omnyo/plugin-sdk";
import type { ComposerDraft } from "@omnyo/plugin-sdk";
import {
  promptLibraryRpcContract,
  starredPromptTransferSchema,
  skillsPromptStatusSchema,
  skillsPromptImportResultSchema,
  type PromptRow,
  type SearchPromptsInput,
} from "./contract.js";
import { createHistoryCache, type HistoryCandidate } from "./history-cache.js";
import {
  buildSnippet,
  createSearchIndex,
  matchPositions,
  queryTerms,
} from "./ranking.js";
import {
  createStarredPromptStore,
  STARRED_PROMPT_MIGRATIONS,
  type StarredPrompt,
} from "./store.js";

const STARRED_RESULT_LIMIT = 20;

const RECENT_RESULT_LIMIT = 30;

const INDEX_CHUNK_SIZE = 500;

type SearchItem =
  | { kind: "starred"; prompt: StarredPrompt }
  | { kind: "recent"; candidate: HistoryCandidate };

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

export default function promptLibraryPlugin(api: PluginApi): void {
  const db = api.storage.database();
  api.storage.migrate(db, STARRED_PROMPT_MIGRATIONS);
  const store = createStarredPromptStore(db);

  function isOmnyoSkills(plugin: {
    id: string;
    source: string;
    repositoryUrl: string | null;
  }): boolean {
    return (
      plugin.id === "skill-discovery" &&
      (plugin.source === "builtin:skill-discovery" ||
        (plugin.source.startsWith("path:") &&
          (plugin.repositoryUrl ===
            "https://github.com/alexburlis/omnyo-plugins/tree/HEAD/skill-discovery" ||
            plugin.repositoryUrl ===
              "https://github.com/alexburlis/omnyo/tree/HEAD/standalone-plugins/skill-discovery")))
    );
  }

  async function skillsOwner(): Promise<string | null> {
    const { plugins } = await api.sdk.plugins.list();

    const skills = plugins.find((plugin) => {
      if (
        !isOmnyoSkills(plugin) ||
        !plugin.enabled ||
        plugin.status !== "running"
      )
        return false;
      const match = /^(\d+)\.(\d+)\./u.exec(plugin.version);

      return match !== null && (Number(match[1]) > 0 || Number(match[2]) >= 6);
    });

    if (!skills) return null;

    const status = await api.sdk.plugins.callRpc({
      pluginId: skills.id,
      method: "promptLibraryStatus",
      input: null,
      outputSchema: skillsPromptStatusSchema,
    });

    skillsPromptStatusSchema.parse(status);
    await api.sdk.plugins.callRpc({
      pluginId: skills.id,
      method: "importLegacyPrompts",
      input: {
        sourceId: "omnyo--prompt-library",
        prompts: store.list().map(({ id, prompt, createdAt, lastUsedAt }) => ({
          id,
          prompt: {
            text: prompt.text,
            mentions: prompt.mentions.map((mention) => ({ ...mention })),
          },
          createdAt,
          lastUsedAt,
        })),
      },
      outputSchema: skillsPromptImportResultSchema,
    });

    return skills.id;
  }

  async function listStarred() {
    const owner = await skillsOwner();

    if (owner === null) return store.list();

    const result = await api.sdk.plugins.callRpc({
      pluginId: owner,
      method: "listStarred",
      input: null,
      outputSchema: starredPromptTransferSchema.array(),
    });

    return starredPromptTransferSchema.array().parse(result);
  }

  async function unstar(id: string) {
    const owner = await skillsOwner();

    if (owner === null) return { unstarred: store.unstar(id) };

    return promptLibraryRpcContract.unstar.output.parse(
      await api.sdk.plugins.callRpc({
        pluginId: owner,
        method: "unstar",
        input: { id },
        outputSchema: promptLibraryRpcContract.unstar.output,
      }),
    );
  }

  async function markUsed(id: string) {
    const owner = await skillsOwner();

    if (owner === null) store.markUsed(id, Date.now());
    else
      await api.sdk.plugins.callRpc({
        pluginId: owner,
        method: "markUsed",
        input: { id },
        outputSchema: promptLibraryRpcContract.markUsed.output,
      });

    return null;
  }

  const historyCache = createHistoryCache((args) =>
    api.sdk.experimental_promptHistory.list(args),
  );

  const index = createSearchIndex<SearchItem>();
  let indexedCount = 0;
  let indexing: Promise<readonly HistoryCandidate[]> = Promise.resolve([]);

  async function indexNewHistory(): Promise<readonly HistoryCandidate[]> {
    const candidates = await historyCache.refresh();

    while (indexedCount < candidates.length) {
      const chunkEnd = Math.max(
        0,
        candidates.length - indexedCount - INDEX_CHUNK_SIZE,
      );

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
  ): SearchItem[] {
    const searching = queryTerms(input.query).length > 0;

    const items: SearchItem[] = searching
      ? index
          .search(
            input.query,
            starredPrompts.map((prompt) => ({
              item: { kind: "starred", prompt },
              text: prompt.prompt.text,
              time: prompt.lastUsedAt ?? prompt.createdAt,
            })),
            Date.now(),
            (item) =>
              item.kind === "starred" ||
              item.candidate.scope ===
                (input.composer === "new-thread" ? "project" : "thread"),
          )
          .map((match) => match.item)
      : [
          ...starredPrompts.map((prompt): SearchItem => ({
            kind: "starred",
            prompt,
          })),
          ...history.map((candidate): SearchItem => ({
            kind: "recent",
            candidate,
          })),
        ];

    const seenTexts = new Set(
      searching ? starredPrompts.map((prompt) => prompt.prompt.text) : [],
    );

    const includeHistory = historySearchable(input);
    let starredCount = 0;
    let recentCount = 0;
    const ordered: SearchItem[] = [];

    for (const item of items) {
      if (item.kind === "starred") {
        if (starredCount === STARRED_RESULT_LIMIT) continue;
        starredCount += 1;
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

  async function projectNames(
    projectIds: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
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

  async function search(input: SearchPromptsInput) {
    const owner = await skillsOwner();

    if (owner !== null)
      return promptLibraryRpcContract.search.output.parse(
        await api.sdk.plugins.callRpc({
          pluginId: owner,
          method: "searchLegacy",
          input,
          outputSchema: promptLibraryRpcContract.search.output,
        }),
      );
    const starredPrompts = store.list();

    const starredIdsByText = new Map(
      starredPrompts.map((prompt) => [prompt.prompt.text, prompt.id]),
    );

    const history = historySearchable(input) ? await loadHistory() : [];
    const items = orderedItems(input, starredPrompts, history);

    const names = await projectNames(
      new Set(
        items.flatMap((item) =>
          item.kind === "recent" ? [item.candidate.projectId] : [],
        ),
      ),
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

  async function star(
    prompt: ComposerDraft,
  ): Promise<{ id: string; prompt: ComposerDraft }> {
    const owner = await skillsOwner();

    if (owner !== null) {
      const result = promptLibraryRpcContract.star.output.parse(
        await api.sdk.plugins.callRpc({
          pluginId: owner,
          method: "star",
          input: {
            prompt: {
              text: prompt.text,
              mentions: prompt.mentions.map((mention) => ({ ...mention })),
            },
          },
          outputSchema: promptLibraryRpcContract.star.output,
        }),
      );

      return { ...result, prompt };
    }

    const starred = store.star(prompt, Date.now());

    if (starred === null) {
      throw new Error("A starred prompt needs some text.");
    }

    return starred;
  }

  api.rpc.register(promptLibraryRpcContract, {
    exportStarred: async (_input, { experimental_caller: caller }) => {
      if (caller.kind === "plugin") {
        const { plugins } = await api.sdk.plugins.list();

        if (
          !plugins.some(
            (plugin) => plugin.id === caller.pluginId && isOmnyoSkills(plugin),
          )
        ) {
          throw new Error(
            "Only Omnyo Skills can import Prompt Library favorites.",
          );
        }
      }

      return store.list();
    },
    search,
    star: async ({ prompt }) => ({ id: (await star(prompt)).id }),
    unstar: ({ id }) => unstar(id),
    markUsed: ({ id }) => markUsed(id),
  });

  api.cli.register(
    defineCli({
      name: "prompts",
      summary: "Search previous prompts and manage starred prompts",
      description:
        "Without a query, starred prompts appear before recent ones in the composer's Prompts… picker (Ctrl+R). A query ranks both in one list: prompts that start with the query first, then by match type (exact, word start, typo, inside a word, abbreviation), then starred prompts and prompts of the searching composer's kind (thread starts in the new-thread composer, follow-ups in a thread), then by relevance decayed by age. Previous prompts come from Omnyo's prompt history.",
      commands: {
        search: cliCommand({
          summary: "Search starred and previous prompts",
          positionals: [
            {
              name: "query",
              description:
                "Words that must each match a prompt word exactly, as its start, with one typo, inside it, or as an abbreviation; omit to list the most recent",
              variadic: true,
            },
          ],
          options: {
            project: {
              type: "string",
              description: "Search this project's prompts",
            },
            thread: {
              type: "string",
              description: "Search this thread's prompts",
            },
            composer: {
              type: "enum",
              values: ["new-thread", "follow-up"],
              default: "follow-up",
              description:
                "Rank like this composer: new-thread favors prompts that started threads, follow-up favors follow-ups",
            },
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "at-most-one", options: ["project", "thread"] },
          ],
          async run({ options, positionals }) {
            const result = await search({
              query: positionals.query.join(" "),
              scope:
                options.thread !== undefined
                  ? "thread"
                  : options.project !== undefined
                    ? "project"
                    : "global",
              projectId: options.project ?? null,
              threadId: options.thread ?? null,
              composer: options.composer,
            });

            if (options.json) {
              return { exitCode: 0, stdout: JSON.stringify(result) };
            }

            const lines = result.prompts.map((row) =>
              row.kind === "starred"
                ? `★ ${row.id}  ${row.snippet.text}`
                : `  ${new Date(row.createdAt).toISOString()}  ${row.snippet.text}`,
            );

            return {
              exitCode: 0,
              stdout: lines.length > 0 ? lines.join("\n") : "No prompts found",
            };
          },
        }),
        list: cliCommand({
          summary: "List starred prompts, most recently used first",
          options: { json: JSON_OPTION },
          async run({ options }) {
            const prompts = await listStarred();

            if (options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  prompts.map((prompt) => ({
                    id: prompt.id,
                    prompt: prompt.prompt,
                    createdAt: prompt.createdAt,
                    lastUsedAt: prompt.lastUsedAt,
                  })),
                ),
              };
            }

            return {
              exitCode: 0,
              stdout:
                prompts.length > 0
                  ? prompts
                      .map(
                        (prompt) =>
                          `${prompt.id}  ${buildSnippet(prompt.prompt.text, []).text}`,
                      )
                      .join("\n")
                  : "No starred prompts",
            };
          },
        }),
        star: cliCommand({
          summary: "Star a prompt",
          positionals: [
            {
              name: "text",
              description: "The prompt text",
              required: true,
              variadic: true,
            },
          ],
          options: { json: JSON_OPTION },
          async run({ options, positionals }) {
            const starred = await star({
              text: positionals.text.join(" "),
              mentions: [],
            });

            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify({ id: starred.id, text: starred.prompt.text })
                : starred.id,
            };
          },
        }),
        unstar: cliCommand({
          summary: "Unstar a prompt",
          positionals: [
            {
              name: "id",
              description:
                "Starred prompt id, as `omnyo prompts list` prints it",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          async run({ options, positionals }) {
            if (!(await unstar(positionals.id)).unstarred) {
              throw new PluginCliError(
                `Unknown starred prompt: ${positionals.id}`,
                {
                  code: "unknown_prompt",
                  hint: "Run `omnyo prompts list` for starred prompt ids.",
                },
              );
            }

            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify({ id: positionals.id, unstarred: true })
                : `Unstarred ${positionals.id}`,
            };
          },
        }),
      },
    }),
  );
}
