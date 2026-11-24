import { useState } from "react";
import type { PaletteAction } from "@/lib/command-palette/palette-action";
import { CommandPaletteBody } from "./CommandPaletteBody";

export default {
  title: "commands/Command Palette",
};

const noop = () => {};

function shortcut(label: string, aria: string) {
  return { label, ariaKeyshortcuts: aria };
}

const ACTIONS: readonly PaletteAction[] = [
  {
    id: "app:thread.new",
    bucket: "Threads",
    group: "Threads",
    title: "New thread",
    shortcut: shortcut("⌘ N", "Meta+N"),
    run: noop,
  },
  {
    id: "app:thread.search",
    bucket: "Threads",
    group: "Threads",
    title: "Search threads",
    shortcut: shortcut("⌘ K", "Meta+K"),
    run: noop,
  },
  {
    id: "app:thread.next",
    bucket: "Threads",
    group: "Threads",
    title: "Next thread",
    shortcut: shortcut("⌃ Tab", "Control+Tab"),
    run: noop,
  },
  {
    id: "app:layout.toggle-sidebar",
    bucket: "Actions",
    group: "Window and layout",
    title: "Toggle sidebar",
    shortcut: shortcut("⌘ B", "Meta+B"),
    run: noop,
  },
  {
    id: "app:workspace.open-terminal",
    bucket: "Actions",
    group: "Workspace",
    title: "Open terminal",
    shortcut: shortcut("⌃ `", "Control+`"),
    run: noop,
  },
  {
    id: "app:composer.cycle-model",
    bucket: "Actions",
    group: "Composer and models",
    title: "Switch model",
    shortcut: shortcut("⌘ ⇧ M", "Meta+Shift+M"),
    run: noop,
  },
  {
    id: "app:browser.reload",
    bucket: "Actions",
    group: "Browser",
    title: "Reload browser tab",
    shortcut: null,
    run: noop,
  },
  {
    id: "plugin:linear:open-issue",
    bucket: "Plugins",
    group: "Linear",
    title: "Open issue",
    shortcut: null,
    run: noop,
  },
];

function PaletteFrame({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery);

  return (
    <div className="flex min-h-[560px] items-start justify-center p-10">
      <div className="grid w-[640px] overflow-hidden rounded-xl border border-border bg-background shadow-lg">
        <CommandPaletteBody
          actions={ACTIONS}
          installedPlugins={[]}
          recents={[]}
          query={query}
          onQueryChange={setQuery}
          onChoose={noop}
        />
      </div>
    </div>
  );
}

export function Commands() {
  return <PaletteFrame initialQuery="" />;
}

export function FilteredResults() {
  return <PaletteFrame initialQuery="thr" />;
}

export function NoMatches() {
  return <PaletteFrame initialQuery="deploy rocket" />;
}
