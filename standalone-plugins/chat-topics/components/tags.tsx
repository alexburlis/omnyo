import { experimental_THREAD_ACTION_GROUPS as THREAD_ACTION_GROUPS } from "@omnyo/plugin-sdk/app";
import type {
  PluginThreadActionChoice,
  PluginThreadActionsInlineItem,
} from "@omnyo/plugin-sdk/app";
import { NO_TAG, isIconName, type Tag } from "../lib/tags.ts";

export type PickTag = (tagId: string | null) => void;

function hostChoice(tag: Tag, selected: boolean): PluginThreadActionChoice {
  return isIconName(tag.icon)
    ? { id: tag.id, label: tag.label, icon: tag.icon, selected }
    : { id: tag.id, label: `${tag.icon} ${tag.label}`, selected };
}

function picked(value: string): string | null {
  return value === NO_TAG ? null : value;
}

export function tagMenuItems(
  tags: readonly Tag[],
  current: Tag | null,
  pick: PickTag,
): PluginThreadActionsInlineItem[] {
  if (tags.length === 0) return [];
  const selected = current?.id ?? NO_TAG;

  return [
    {
      key: "chat-topics/tag",
      group: THREAD_ACTION_GROUPS.organize,
      action: {
        label: "Tag",
        icon: "Layers",
        choices: {
          heading: "Tag",
          items: [
            ...tags.map((tag) => hostChoice(tag, tag.id === selected)),
            { id: NO_TAG, label: "No tag", selected: selected === NO_TAG },
          ],
        },
        run: ({ value }) => {
          if (value !== undefined) pick(picked(value));
        },
      },
    },
  ];
}
