import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@omnyo/shared-ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { HEADER_PANE_ACTION_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@omnyo/shared-ui/chrome-style-tokens";
import { useHoverPopover } from "@/components/ui/hooks/use-hover-popover";
import { useBrowserDimmingOverlay } from "@/hooks/useBrowserDimmingModal";
import { appCommandTarget } from "@/lib/app-command-targets";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import type { KeyboardCommandId } from "@omnyo/domain";
import { getOmnyoDesktopInfo } from "@/lib/omnyo-desktop";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRef } from "react";
import type { SplitSide } from "@/lib/split-layout";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { usePaneContext } from "./PaneContext";

const ARRANGEMENT_ACTIONS: ReadonlyArray<{
  label: string;
  side: SplitSide;
}> = [
  { label: "Move left", side: "left" },
  { label: "Move right", side: "right" },
  { label: "Move top", side: "top" },
  { label: "Move bottom", side: "bottom" },
];

const MENU_ITEM_CLASS = cn(
  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground outline-none hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none [&>[data-icon-root]]:size-4 [&>[data-icon-root]]:shrink-0",
  LIST_HOVER_TRANSITION,
);

const ARRANGEMENT_REGION_CLASS: Record<SplitSide, string> = {
  left: "inset-y-[3px] left-[3px] w-2.5",
  right: "inset-y-[3px] right-[3px] w-2.5",
  top: "inset-x-[3px] top-[3px] h-1.5",
  bottom: "inset-x-[3px] bottom-[3px] h-1.5",
};

export function resolvePaneArrangementLabel({
  isDesktopApp,
  isFullScreen,
}: {
  isDesktopApp: boolean;
  isFullScreen: boolean;
}): string {
  if (isDesktopApp) {
    return isFullScreen ? "Exit Full Screen" : "Full Screen";
  }

  return isFullScreen ? "Restore split" : "Maximize pane";
}

function ArrangementGlyph({ side }: { side: SplitSide }) {
  return (
    <span
      data-pane-arrangement-glyph={side}
      aria-hidden
      className="relative block h-5 w-8 rounded-[5px] border-2 border-current"
    >
      <span
        className={cn(
          "absolute rounded-[2px] bg-current",
          ARRANGEMENT_REGION_CLASS[side],
        )}
      />
    </span>
  );
}

export function PaneMaximizeButton() {
  const { isMaximized, onToggleMaximize, onMoveToSide } = usePaneContext();
  const shortcut = useAppCommandShortcut("pane.maximize.toggle");

  if (onToggleMaximize === null) return null;

  return (
    <PaneArrangementButton
      command="pane.maximize.toggle"
      isFullScreen={isMaximized}
      onMoveToSide={onMoveToSide ?? undefined}
      onToggleFullScreen={onToggleMaximize}
      shortcut={shortcut ?? undefined}
    />
  );
}

export function PaneArrangementButton({
  className,
  command,
  isFullScreen,
  onMoveToSide,
  onToggleFullScreen,
  shortcut,
}: {
  className?: string;
  command: KeyboardCommandId;
  isFullScreen: boolean;
  onMoveToSide?: (side: SplitSide) => void;
  onToggleFullScreen: () => void;
  shortcut?: AppShortcutPresentation;
}) {
  const {
    open: hoverOpen,
    triggerHoverProps,
    contentHoverProps,
    handleOpenChange,
  } = useHoverPopover({ openDelayMs: 400, closeDelayMs: 100 });

  const label = resolvePaneArrangementLabel({
    isDesktopApp: getOmnyoDesktopInfo() !== null,
    isFullScreen,
  });

  const accessibleLabel = shortcut ? `${label} (${shortcut.label})` : label;
  const menuOpen = !isFullScreen && hoverOpen;
  const menuRef = useRef<HTMLDivElement>(null);

  const focusFirstMenuItem = () => {
    window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, 0);
  };

  const handleTriggerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowDown" || isFullScreen) return;
    event.preventDefault();
    handleOpenChange(true);
    focusFirstMenuItem();
  };

  useBrowserDimmingOverlay(menuOpen);

  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
        CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
        className,
      )}
      {...appCommandTarget(command)}
      aria-label={accessibleLabel}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      aria-pressed={isFullScreen}
      aria-haspopup={!isFullScreen ? "menu" : undefined}
      aria-expanded={!isFullScreen ? menuOpen : undefined}
      onKeyDown={handleTriggerKeyDown}
      onClick={() => {
        handleOpenChange(false);
        onToggleFullScreen();
      }}
      {...(!isFullScreen ? triggerHoverProps : {})}
    >
      <Icon name={isFullScreen ? "Minimize2" : "Maximize2"} />
    </Button>
  );

  if (isFullScreen) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="bottom">
          <span>{label}</span>
          {shortcut ? ` (${shortcut.label})` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={menuOpen} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>{button}</PopoverAnchor>
      <PopoverContent
        ref={menuRef}
        role="menu"
        aria-label="Pane arrangement"
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-52 space-y-1 rounded-lg p-1.5"
        {...contentHoverProps}
      >
        <button
          type="button"
          role="menuitem"
          className={MENU_ITEM_CLASS}
          onClick={() => {
            handleOpenChange(false);
            onToggleFullScreen();
          }}
        >
          <Icon name="Maximize2" />
          <span className="flex-1">{label}</span>
          {shortcut ? (
            <span className="text-subtle-foreground">{shortcut.label}</span>
          ) : null}
        </button>
        {onMoveToSide ? (
          <div className="border-t border-border-hairline pt-1.5">
            <div className="px-2 pb-0.5 text-2xs font-medium text-subtle-foreground">
              Move
            </div>
            <div className="grid grid-cols-4 gap-1" aria-label="Move pane">
              {ARRANGEMENT_ACTIONS.map((action) => (
                <Tooltip key={action.side}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={action.label}
                      className="flex h-11 cursor-pointer items-center justify-center rounded-md text-subtle-foreground outline-none transition-colors hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground focus-visible:outline-none"
                      onClick={() => {
                        handleOpenChange(false);
                        onMoveToSide(action.side);
                      }}
                    >
                      <ArrangementGlyph side={action.side} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{action.label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
