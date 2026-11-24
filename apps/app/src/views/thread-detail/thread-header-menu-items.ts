import type { PluginThreadActionsInlineItem } from "@omnyo/plugin-sdk";
import type { ThreadPromptParentThreadSection } from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { requestThreadOutline } from "@/components/thread/toc/thread-outline-request";

export const THREAD_HEADER_ACTIONS_GROUP = "0_header";

export interface ThreadHeaderExecutionHost {
  name: string;
  connected: boolean;
}

export interface ThreadHeaderLineageDestination {
  href: string;
  title: string;
}

export function buildThreadHeaderMenuItems({
  threadId,
  isCompactViewport,
  executionHost,
  lineageSource,
  lineageDestinations,
  navigate,
  responsiveItems,
}: {
  threadId: string;
  isCompactViewport: boolean;
  executionHost: ThreadHeaderExecutionHost | null;
  lineageSource: ThreadPromptParentThreadSection | null;
  lineageDestinations: readonly ThreadHeaderLineageDestination[];
  navigate: (href: string) => void;
  responsiveItems: readonly PluginThreadActionsInlineItem[];
}): PluginThreadActionsInlineItem[] {
  const items: PluginThreadActionsInlineItem[] = [];

  if (isCompactViewport && executionHost !== null) {
    items.push({
      key: "thread/execution-host",
      group: THREAD_HEADER_ACTIONS_GROUP,
      action: {
        icon: "Laptop",
        label: `Runs on ${executionHost.name}`,
        detail: executionHost.connected ? "Connected" : "Disconnected",
        disabled: true,
        run: () => {},
      },
    });
  }

  items.push({
    key: "thread/outline",
    group: THREAD_HEADER_ACTIONS_GROUP,
    action: {
      icon: "ListView",
      label: "Jump to message…",
      run: () => {
        requestThreadOutline(threadId);
      },
    },
  });

  if (isCompactViewport) {
    items.push(
      ...buildLineageMenuItems(lineageSource, lineageDestinations, navigate),
    );
  }

  items.push(...responsiveItems);

  return items;
}

function buildLineageMenuItems(
  source: ThreadPromptParentThreadSection | null,
  destinations: readonly ThreadHeaderLineageDestination[],
  navigate: (href: string) => void,
): PluginThreadActionsInlineItem[] {
  const items: PluginThreadActionsInlineItem[] = [];

  if (source?.relationship === "handoff") {
    items.push({
      key: "thread/continued-from",
      group: THREAD_HEADER_ACTIONS_GROUP,
      action: {
        icon: "ArrowTurnBackward",
        label: "Continued from",
        detail: source.parentThreadTitle,
        run: () => navigate(source.href),
      },
    });
  }

  const [destination] = destinations;

  if (destination === undefined) return items;

  items.push({
    key: "thread/continued-in",
    group: THREAD_HEADER_ACTIONS_GROUP,
    action:
      destinations.length === 1
        ? {
            icon: "ArrowTurnForward",
            label: "Continued in",
            detail: destination.title,
            run: () => navigate(destination.href),
          }
        : {
            icon: "ArrowTurnForward",
            label: "Continued in",
            detail: `${destinations.length} chats`,
            choices: {
              heading: "Continued in",
              items: destinations.map(({ href, title }) => ({
                id: href,
                label: title,
              })),
            },
            run: ({ value }) => {
              if (value !== undefined) navigate(value);
            },
          },
  });

  return items;
}
