import type { PromptMentionResource } from "@omnyo/domain";
import { Icon } from "@omnyo/shared-ui/icon";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import { promptMentionIconName } from "./prompt-mention-display";

export function PromptMentionIcon({
  className,
  resource,
}: {
  className?: string;
  resource: PromptMentionResource;
}) {
  if (resource.kind === "plugin") {
    return (
      <PluginItemIcon
        pluginId={resource.pluginId}
        icon={resource.icon ?? null}
        className={className}
      />
    );
  }

  return (
    <Icon
      name={promptMentionIconName(resource)}
      className={className}
      aria-hidden
    />
  );
}
