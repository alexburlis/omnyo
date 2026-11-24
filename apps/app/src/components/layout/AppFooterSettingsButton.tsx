import { useNavigate } from "react-router-dom";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { appCommandTarget } from "@/lib/app-command-targets";
import { getSettingsRouteIntent } from "@/views/settings-view-split";

export function AppFooterSettingsButton({
  isSettingsActive,
  settingsToggleRoutePath,
}: {
  isSettingsActive: boolean;
  settingsToggleRoutePath: string;
}) {
  const navigate = useNavigate();
  const shortcut = useAppCommandShortcut("settings.open");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Settings"
          {...appCommandTarget("settings.open")}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          aria-pressed={isSettingsActive}
          className="size-(--omnyo-sidebar-control-size) shrink-0 rounded-[10px] p-0 text-muted-foreground ring-sidebar-ring hover:bg-state-hover hover:text-sidebar-foreground focus-visible:ring-2 [&_[data-icon-root]]:size-(--omnyo-sidebar-control-icon-size)"
          {...getSettingsRouteIntent(settingsToggleRoutePath)}
          onClick={() => void navigate(settingsToggleRoutePath)}
        >
          <Icon name="Settings" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isSettingsActive
          ? "Close Settings"
          : shortcut
            ? `Settings (${shortcut.label})`
            : "Settings"}
      </TooltipContent>
    </Tooltip>
  );
}
