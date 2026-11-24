import { useEffect, useState, type ComponentProps } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PromptMentionCommandTrigger } from "@omnyo/domain";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@omnyo/client-core";
import type { ProviderCommand } from "@omnyo/server-contract";
import { PromptBoxInternal } from "../PromptBoxInternal";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import { projectCommandCatalogQueryKey } from "@/hooks/queries/query-keys";

export default { title: "promptbox/Command search" };

const projectId = "proj_command_search_fixture";

const commands: ProviderCommand[] = Array.from({ length: 525 }, (_, index) => ({
  name: index === 524 ? "security" : `skill-${String(index).padStart(3, "0")}`,
  source: "skill",
  origin: "user",
  description:
    index === 524
      ? "Audit code for security defects"
      : "A searchable skill in a large catalog",
  argumentHint: null,
}));

function Composer() {
  const [value, setValue] = useState<{
    text: string;
    mentions: ComponentProps<typeof PromptBoxInternal>["mentionRanges"];
  }>({ text: "", mentions: [] });

  const [command, setCommand] = useState<{
    query: string | null;
    trigger: PromptMentionCommandTrigger | null;
  }>({ query: null, trigger: null });

  const suggestions = useCommandSuggestions({
    projectId,
    providerId: "codex",
    environmentId: null,
    commandScope: "thread",
    skillsTriggers: ["/"],
    query: command.query,
    activeTrigger: command.trigger,
  });

  return (
    <div className="mx-auto max-w-2xl p-6">
      <PromptBoxInternal
        value={value.text}
        mentionRanges={value.mentions}
        onChange={(text, mentions) => setValue({ text, mentions })}
        onSubmit={() => undefined}
        suppressPluginComposerCustomizations
        mentionMenuPlacement="top"
        typeahead={{
          mention: {
            triggers: [],
            results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
            isLoading: false,
            isRefreshing: false,
            isError: false,
            onQueryChange: () => undefined,
          },
          command: {
            ...suggestions,
            onQueryChange: (query, trigger) => setCommand({ query, trigger }),
          },
        }}
      />
    </div>
  );
}

export function LargeCatalog() {
  const client = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    client.setQueryData(
      projectCommandCatalogQueryKey(projectId, "codex", null, null),
      { state: "ready", commands },
    );
    setReady(true);
  }, [client]);

  return ready ? <Composer /> : null;
}
