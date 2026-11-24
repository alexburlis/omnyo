import { fuzzyMatchText } from "@omnyo/fuzzy-match";
import {
  providerCommandSection,
  providerCommandSectionRank,
  type ProviderCommand,
  type ProviderCommandOrigin,
  type ProviderCommandSection,
  type ProviderCommandSource,
} from "@omnyo/server-contract";
import type { PromptMentionCommandTrigger } from "@omnyo/domain";
import type { PluginMentionTrigger } from "./plugin-mention-triggers.js";
import type { OrderedMentionSuggestions } from "./mention-candidates.js";

type PromptPathMentionSource = "workspace" | "thread-storage";

type PromptPathMentionEntryKind = "file" | "directory";

export const threadMentionRelationValues = [
  "parent",
  "child",
  "same-parent",
  "same-environment",
] as const;

export type ThreadMentionRelation =
  (typeof threadMentionRelationValues)[number];

export type PromptMentionSuggestion =
  | {
      kind: "path";
      source: PromptPathMentionSource;
      entryKind: PromptPathMentionEntryKind;
      path: string;
      name: string;
      replacement: string;
    }
  | {
      kind: "thread";
      path: string;
      replacement: string;
      projectId: string;
      projectName?: string;
      threadId: string;
      title?: string;
      relation: ThreadMentionRelation | null;
    }
  | {
      kind: "project";
      path: string;
      replacement: string;
      projectId: string;
      name: string;
    }
  | {
      kind: "section";
      path: string;
      replacement: string;
      sectionId: string;
      name: string;
    }
  | {
      kind: "attachment";
      path: string;
      name: string;
      replacement: string;
    }
  | {
      kind: "plugin";
      pluginId: string;
      providerId: string;
      itemId: string;
      providerLabel: string;
      title: string;
      subtitle: string | null;
      icon: string | null;
      replacement: string;
    };

export interface ProviderCommandSuggestion {
  kind: "command";
  name: string;
  source: ProviderCommandSource;
  origin: ProviderCommandOrigin;
  description: string | null;
  argumentHint: string | null;
  pluginId?: string;
}

export function toProviderCommandSuggestion(
  command: ProviderCommand,
): ProviderCommandSuggestion {
  return {
    kind: "command",
    name: command.name,
    source: command.source,
    origin: command.origin,
    description: command.description,
    argumentHint: command.argumentHint,
    ...(command.pluginId !== undefined ? { pluginId: command.pluginId } : {}),
  };
}

const commandSearchMetadata = new WeakMap<
  ProviderCommandSuggestion,
  { names: string[]; description: string; hint: string }
>();

const commandSearchRanks = new WeakMap<
  ProviderCommandSuggestion,
  { query: string; rank: number }
>();

function searchMetadata(suggestion: ProviderCommandSuggestion) {
  let metadata = commandSearchMetadata.get(suggestion);

  if (!metadata) {
    const name = suggestion.name.toLowerCase();

    const separator =
      suggestion.source === "skill" ? name.lastIndexOf(":") : -1;

    metadata = {
      names: separator < 0 ? [name] : [name, name.slice(separator + 1)],
      description: suggestion.description?.toLowerCase() ?? "",
      hint: suggestion.argumentHint?.toLowerCase() ?? "",
    };
    commandSearchMetadata.set(suggestion, metadata);
  }

  return metadata;
}

function matchingCommandNames(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): Set<ProviderCommandSuggestion> {
  return new Set(
    fuzzyMatchText({
      items: suggestions,
      query,
      getText: (suggestion) => suggestion.name,
      limit: suggestions.length,
    }).map((match) => match.item),
  );
}

export function filterCommandSuggestions(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): ProviderCommandSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery === "") return [...suggestions];
  const nameMatches = matchingCommandNames(suggestions, normalizedQuery);

  return suggestions.filter((suggestion) => {
    const metadata = searchMetadata(suggestion);

    const rank = commandSuggestionMatchRank(
      suggestion,
      normalizedQuery,
      nameMatches,
    );

    commandSearchRanks.set(suggestion, { query: normalizedQuery, rank });

    return (
      nameMatches.has(suggestion) ||
      metadata.description.includes(normalizedQuery) ||
      metadata.hint.includes(normalizedQuery)
    );
  });
}

function compareCommandSuggestionSections(
  left: ProviderCommandSuggestion,
  right: ProviderCommandSuggestion,
): number {
  return providerCommandSectionRank(left) - providerCommandSectionRank(right);
}

function commandSuggestionMatchRank(
  suggestion: ProviderCommandSuggestion,
  normalizedQuery: string,
  nameMatches: ReadonlySet<ProviderCommandSuggestion>,
): number {
  const metadata = searchMetadata(suggestion);
  const canonicalName = metadata.names[0];

  if (canonicalName === normalizedQuery) {
    return 0;
  }

  const names = metadata.names;

  if (names.includes(normalizedQuery)) {
    return 1;
  }

  if (names.some((name) => name.startsWith(normalizedQuery))) {
    return 2;
  }

  if (names.some((name) => name.includes(normalizedQuery))) {
    return 3;
  }

  return nameMatches.has(suggestion) ? 4 : 5;
}

export function orderCommandSuggestions(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): ProviderCommandSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();

  const missingRanks =
    normalizedQuery !== "" &&
    suggestions.some(
      (item) => commandSearchRanks.get(item)?.query !== normalizedQuery,
    );

  const matches = missingRanks
    ? matchingCommandNames(suggestions, normalizedQuery)
    : new Set<ProviderCommandSuggestion>();

  const ranks = new Map(
    suggestions.map((item) => {
      const cached = commandSearchRanks.get(item);

      const rank =
        normalizedQuery === ""
          ? 0
          : cached?.query === normalizedQuery
            ? cached.rank
            : commandSuggestionMatchRank(item, normalizedQuery, matches);

      commandSearchRanks.set(item, { query: normalizedQuery, rank });

      return [item, rank];
    }),
  );

  const ranked = [...suggestions].sort(
    (left, right) =>
      (ranks.get(left) ?? 0) - (ranks.get(right) ?? 0) ||
      compareCommandSuggestionSections(left, right),
  );

  const bySection = new Map<
    ProviderCommandSection,
    ProviderCommandSuggestion[]
  >();

  for (const suggestion of ranked) {
    const section = providerCommandSection(suggestion);
    const existing = bySection.get(section);

    if (existing) {
      existing.push(suggestion);
      continue;
    }

    bySection.set(section, [suggestion]);
  }

  return [...bySection.values()].flat();
}

export type TypeaheadTrigger =
  | { char: PluginMentionTrigger; kind: "mention" }
  | { char: PromptMentionCommandTrigger; kind: "command" };

export type ActiveTrigger =
  | {
      char: PluginMentionTrigger;
      kind: "mention";
      query: string;
      from: number;
      to: number;
    }
  | {
      char: PromptMentionCommandTrigger;
      kind: "command";
      query: string;
      from: number;
      to: number;
    };

export type MentionMenuState =
  | { kind: "hint" }
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "results";
      results: OrderedMentionSuggestions;
      refreshing: boolean;
    };

export type CommandMenuState =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "results";
      suggestions: readonly ProviderCommandSuggestion[];
      isUpdating?: boolean;
    };

export type TypeaheadMenuState =
  | { trigger: "mention"; state: MentionMenuState }
  | { trigger: "command"; state: CommandMenuState };
