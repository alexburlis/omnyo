import { useMemo } from "react";
import type { PromptMentionCommandTrigger } from "@omnyo/domain";
import type { ProviderCommand } from "@omnyo/server-contract";
import {
  filterCommandSuggestions,
  toProviderCommandSuggestion,
  type ProviderCommandSuggestion,
} from "@omnyo/client-core";
import { useProjectCommandCatalog } from "./queries/project-queries";
import { useSystemConfig } from "./queries/system-queries";

interface UseCommandSuggestionsArgs {
  projectId: string | undefined;
  providerId: string | undefined;
  commandScope: "new-thread" | "thread";
  skillsTriggers: readonly PromptMentionCommandTrigger[];
  activeTrigger: PromptMentionCommandTrigger | null;
  promptActions?: readonly CommandSuggestionPromptAction[];
  threadProviderCommands?: readonly ProviderCommand[] | null;
  environmentId: string | null;
  hostId?: string | null;
  query: string | null;
}

interface UseCommandSuggestionsResult {
  triggers: readonly PromptMentionCommandTrigger[];
  suggestions: ProviderCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  isUpdating: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

interface CommandSuggestionPromptAction {
  text?: string;
  command?: {
    trigger: PromptMentionCommandTrigger;
    name: string;
    trailingText: string;
  };
}

export function promptActionCommandSuggestions({
  promptActions,
  query,
  trigger,
}: {
  promptActions: readonly CommandSuggestionPromptAction[] | undefined;
  query: string;
  trigger: PromptMentionCommandTrigger | null;
}): ProviderCommandSuggestion[] {
  if (trigger === null) {
    return [];
  }

  return filterCommandSuggestions(
    (promptActions ?? []).flatMap((action): ProviderCommandSuggestion[] => {
      if (!action.command || action.command.trigger !== trigger) {
        return [];
      }

      return [
        {
          kind: "command",
          name: action.command.name,
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
      ];
    }),
    query,
  );
}

export function threadProviderCommandSuggestions({
  commands,
  query,
  trigger,
}: {
  commands: readonly ProviderCommand[] | null | undefined;
  query: string;
  trigger: PromptMentionCommandTrigger | null;
}): ProviderCommandSuggestion[] {
  if (trigger !== "/") {
    return [];
  }

  return filterCommandSuggestions(
    (commands ?? []).map(toProviderCommandSuggestion),
    query,
  );
}

function mergeCommandSuggestions(
  preferred: readonly ProviderCommandSuggestion[],
  fallback: readonly ProviderCommandSuggestion[],
): ProviderCommandSuggestion[] {
  const suggestions: ProviderCommandSuggestion[] = [];
  const seen = new Set<string>();

  for (const suggestion of [...preferred, ...fallback]) {
    const key = `${suggestion.source}:${suggestion.name}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    suggestions.push(suggestion);
  }

  return suggestions;
}

export function useCommandSuggestions(
  args: UseCommandSuggestionsArgs,
): UseCommandSuggestionsResult {
  const trigger = args.activeTrigger;

  const isActive =
    args.projectId !== undefined &&
    args.providerId !== undefined &&
    trigger !== null &&
    args.skillsTriggers.includes(trigger) &&
    args.query !== null;

  const trimmedQuery = args.query?.trim() ?? "";

  const promptActionSuggestions = useMemo(
    () =>
      isActive
        ? promptActionCommandSuggestions({
            promptActions: args.promptActions,
            query: trimmedQuery.toLowerCase(),
            trigger,
          })
        : [],
    [args.promptActions, isActive, trigger, trimmedQuery],
  );

  const catalogEnabled =
    args.projectId !== undefined &&
    args.providerId !== undefined &&
    args.skillsTriggers.length > 0;

  const systemConfigQuery = useSystemConfig({ enabled: catalogEnabled });

  const commandsQuery = useProjectCommandCatalog(
    {
      projectId: args.projectId,
      providerId: args.providerId,
      environmentId: args.environmentId,
      hostId: args.hostId ?? null,
    },
    {
      enabled: catalogEnabled,
    },
  );

  const catalogSuggestions = useMemo(
    () =>
      (
        commandsQuery.data?.commands ??
        (args.providerId === undefined
          ? []
          : (systemConfigQuery.data?.commandDefaultsByProvider[
              args.providerId
            ] ?? []))
      ).map(toProviderCommandSuggestion),
    [
      args.providerId,
      commandsQuery.data?.commands,
      systemConfigQuery.data?.commandDefaultsByProvider,
    ],
  );

  const suggestions = useMemo<ProviderCommandSuggestion[]>(() => {
    if (!isActive) {
      return [];
    }

    const discoveredSuggestions = filterCommandSuggestions(
      catalogSuggestions.filter(
        (suggestion) =>
          (trigger !== "$" || suggestion.source === "skill") &&
          (args.commandScope === "thread" ||
            suggestion.source !== "command" ||
            suggestion.origin !== "builtin" ||
            suggestion.name !== "compact"),
      ),
      trimmedQuery,
    );

    return mergeCommandSuggestions(
      mergeCommandSuggestions(
        promptActionSuggestions,
        threadProviderCommandSuggestions({
          commands: args.threadProviderCommands,
          query: trimmedQuery,
          trigger,
        }),
      ),
      discoveredSuggestions,
    );
  }, [
    args.threadProviderCommands,
    catalogSuggestions,
    args.commandScope,
    trigger,
    isActive,
    promptActionSuggestions,
    trimmedQuery,
  ]);

  const catalogFailure =
    commandsQuery.data?.state === "failed"
      ? commandsQuery.data.error
      : commandsQuery.error;

  const hasCatalogError =
    isActive &&
    (commandsQuery.isError || commandsQuery.data?.state === "failed");

  const isError = hasCatalogError && suggestions.length === 0;

  const isPreparing =
    isActive &&
    !hasCatalogError &&
    (commandsQuery.data === undefined ||
      commandsQuery.data.state === "preparing");

  return {
    triggers: args.skillsTriggers,
    suggestions,
    isLoading: false,
    isError,
    errorMessage: hasCatalogError
      ? catalogFailure !== null &&
        "code" in catalogFailure &&
        catalogFailure.code === "host_unavailable"
        ? "Machine unavailable. Reconnect it to update commands."
        : "Failed to load commands"
      : null,
    isUpdating: isPreparing,
    hasMore: false,
    isLoadingMore: false,
    loadMore: () => {},
  };
}
