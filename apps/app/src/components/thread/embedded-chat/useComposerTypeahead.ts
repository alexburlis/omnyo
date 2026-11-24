import { useMemo, useState } from "react";
import type { TypeaheadConfig } from "@/components/promptbox/PromptBoxInternal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { PromptBoxAction } from "@/components/promptbox/PromptBoxActionsMenu";
import type { ProviderComposerAction } from "@omnyo/domain";
import type { ProviderCommand } from "@omnyo/server-contract";
import { buildProviderPromptActionProps } from "@omnyo/client-core";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import { usePromptMentions } from "@/hooks/usePromptMentions";

interface UseComposerTypeaheadArgs {
  projectId: string;
  mentionsProjectId?: string;
  providerId: string;
  commandScope?: "new-thread" | "thread";
  environmentId: string | null;
  currentThreadId: string;
  selectedProviderComposerActions:
    | readonly ProviderComposerAction[]
    | undefined;
  threadProviderCommands?: readonly ProviderCommand[] | null;
  resolveMentionLink: PromptMentionLinkResolver;
}

interface UseComposerTypeaheadResult {
  typeaheadConfig: TypeaheadConfig;
  promptActions: readonly PromptBoxAction[];
}

export function useComposerTypeahead({
  projectId,
  mentionsProjectId,
  providerId,
  commandScope = "thread",
  environmentId,
  currentThreadId,
  selectedProviderComposerActions,
  threadProviderCommands,
  resolveMentionLink,
}: UseComposerTypeaheadArgs): UseComposerTypeaheadResult {
  const promptMentions = usePromptMentions(mentionsProjectId ?? projectId, {
    currentThreadId,
    environmentId,
    threadStorageThreadId: currentThreadId,
  });

  const [commandState, setCommandState] = useState<{
    query: string | null;
    trigger: import("@omnyo/domain").PromptMentionCommandTrigger | null;
  }>({ query: null, trigger: null });

  const providerPromptActions = useMemo(
    () => buildProviderPromptActionProps(selectedProviderComposerActions ?? []),
    [selectedProviderComposerActions],
  );

  const { promptActions } = providerPromptActions;

  const commandSuggestions = useCommandSuggestions({
    projectId,
    providerId,
    commandScope,
    skillsTriggers: providerPromptActions.skillsTriggers,
    activeTrigger: commandState.trigger,
    promptActions,
    threadProviderCommands: threadProviderCommands ?? null,
    environmentId,
    query: commandState.query,
  });

  const typeaheadConfig = useMemo<TypeaheadConfig>(
    () => ({
      mention: {
        triggers: promptMentions.triggers,
        results: promptMentions.results,
        isLoading: promptMentions.isLoading,
        isRefreshing: promptMentions.isRefreshing,
        isError: promptMentions.isError,
        onQueryChange: promptMentions.setQuery,
        resolveLink: resolveMentionLink,
      },
      command: {
        triggers: commandSuggestions.triggers,
        suggestions: commandSuggestions.suggestions,
        isLoading: commandSuggestions.isLoading,
        isUpdating: commandSuggestions.isUpdating,
        isError: commandSuggestions.isError,
        errorMessage: commandSuggestions.errorMessage,
        hasMore: commandSuggestions.hasMore,
        isLoadingMore: commandSuggestions.isLoadingMore,
        loadMore: commandSuggestions.loadMore,
        onQueryChange: (query, trigger) => setCommandState({ query, trigger }),
      },
    }),
    [
      commandSuggestions.hasMore,
      commandSuggestions.isError,
      commandSuggestions.errorMessage,
      commandSuggestions.isLoading,
      commandSuggestions.isUpdating,
      commandSuggestions.isLoadingMore,
      commandSuggestions.loadMore,
      commandSuggestions.suggestions,
      commandSuggestions.triggers,
      promptMentions.isError,
      promptMentions.isLoading,
      promptMentions.isRefreshing,
      promptMentions.setQuery,
      promptMentions.results,
      promptMentions.triggers,
      resolveMentionLink,
    ],
  );

  return { typeaheadConfig, promptActions };
}
