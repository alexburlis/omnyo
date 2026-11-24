import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EMPTY_PLUGIN_UPDATE_STATE } from "@/hooks/queries/plugin-settings-queries";
import { makePluginListItem } from "@/test/fixtures/plugins";
import { InstalledPluginsTab } from "./InstalledPluginsTab";

export default {
  title: "plugin/Installed plugins",
};

const PLUGINS = [
  makePluginListItem({
    id: "github",
    name: "GitHub",
    icon: "Github",
    source: "npm:@omnyo-plugins/github",
    rootDir: "/Users/ada/.omnyo/plugins/github",
    description:
      "Browse GitHub issues and pull requests without leaving Omnyo.",
    provenance: "catalog",
    publisherLabel: "Omnyo",
    version: "1.4.0",
    updateState: { ...EMPTY_PLUGIN_UPDATE_STATE, availableVersion: "1.5.0" },
  }),
  makePluginListItem({
    id: "prompt-shaper",
    name: "Prompt Improver",
    icon: "AiContentGenerator01",
    source: "npm:@acme/prompt-shaper",
    rootDir: "/Users/ada/.omnyo/plugins/prompt-shaper",
    description: "Enhance a rough composer draft before sending it.",
    provenance: "catalog",
    publisherLabel: "Acme Plugins",
  }),
  makePluginListItem({
    id: "issue-sync",
    name: "Issue Sync",
    icon: "Repeat",
    source: "path:/Users/ada/code/issue-sync",
    rootDir: "/Users/ada/code/issue-sync",
    description: "Mirror tracker issues into Omnyo chats.",
    status: "error",
    statusDetail: "The plugin couldn't start. Try reloading it.",
  }),
  makePluginListItem({
    id: "keep-awake",
    name: "Keep Awake",
    icon: "Coffee",
    source: "npm:@omnyo-plugins/keep-awake",
    rootDir: "/Users/ada/.omnyo/plugins/keep-awake",
    description: "Stop the Mac from sleeping while chats are running.",
    provenance: "catalog",
    publisherLabel: "Omnyo",
    enabled: false,
    status: "disabled",
  }),
];

function StoryQueryClient({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnMount: false,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const noop = () => {};

export function Cards() {
  return (
    <StoryQueryClient>
      <div className="max-w-4xl p-6">
        <InstalledPluginsTab
          entries={PLUGINS.map((plugin) => ({ plugin }))}
          onOpenPlugin={noop}
        />
      </div>
    </StoryQueryClient>
  );
}

export function Empty() {
  return (
    <StoryQueryClient>
      <div className="max-w-4xl p-6">
        <InstalledPluginsTab entries={[]} onOpenPlugin={noop} />
      </div>
    </StoryQueryClient>
  );
}
