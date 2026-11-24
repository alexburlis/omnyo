import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@omnyo/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { CompactLongPressMenu } from "@omnyo/shared-ui/compact-long-press-menu";
import { PluginComposerPlusMenuEntry } from "@/components/plugin/PluginComposerActions";
import { useResolvedComposerSendMenuItems } from "@/components/plugin/composer-slot-hooks";
import { useOptionalPluginComposerView } from "@/components/plugin/plugin-composer-host";

export interface ComposerSendMenuAction {
  key: string;
  label: string;
  icon: IconName;
  shortcutLabel?: string;
  onSelect: () => void;
}

export function ComposerSendMenu({
  actions = [],
  children,
  isPointerCoarse,
  includePluginContributions,
  queue,
  hasInput,
  canSubmit,
  canSend,
  onSubmit,
}: {
  actions?: readonly ComposerSendMenuAction[];
  children: ReactNode;
  isPointerCoarse: boolean;
  includePluginContributions: boolean;
  queue: boolean;
  hasInput: boolean;
  canSubmit: boolean;
  canSend: boolean;
  onSubmit: (() => void) | undefined;
}) {
  const isCompactViewport = useIsCompactViewport();
  const view = useOptionalPluginComposerView();

  const contributions = useResolvedComposerSendMenuItems(
    includePluginContributions ? (view?.scope.kind ?? null) : null,
  );

  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!canSubmit) setOpen(false);
  }, [canSubmit]);

  const handleOpenChange = (nextOpen: boolean) =>
    setOpen(nextOpen && canSubmit);

  if (!onSubmit && actions.length === 0 && contributions.length === 0)
    return children;

  const items = canSubmit ? (
    <>
      {onSubmit ? (
        <DropdownMenuItem disabled={!canSubmit} onSelect={onSubmit}>
          <Icon
            name={queue ? "ListEnd" : "CornerDownRight"}
            className={cn("size-4", queue && "-scale-x-100")}
          />
          {queue ? "Queue" : "Steer"}
        </DropdownMenuItem>
      ) : null}
      {actions.map((action) => (
        <DropdownMenuItem key={action.key} onSelect={action.onSelect}>
          <Icon name={action.icon} className="size-4" />
          {action.label}
          {action.shortcutLabel ? (
            <span className="ml-auto pl-4 text-xs text-muted-foreground">
              {action.shortcutLabel}
            </span>
          ) : null}
        </DropdownMenuItem>
      ))}
      {contributions.map((contribution) => (
        <PluginComposerPlusMenuEntry
          key={contribution.key}
          contribution={contribution}
          slotKind="composerSendMenuItem"
        />
      ))}
    </>
  ) : null;

  if (isPointerCoarse && isCompactViewport) {
    if (!canSubmit) return children;

    return (
      <CompactLongPressMenu
        label="Send options"
        onOpenChange={handleOpenChange}
        items={items}
      >
        <span
          className="inline-flex"
          onPointerUpCapture={(event) => {
            if (!open) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {children}
        </span>
      </CompactLongPressMenu>
    );
  }

  return (
    <div
      data-promptbox-send-menu=""
      className={cn(
        "group/send ml-1 inline-flex items-center rounded-full [&_[data-promptbox-submit-action]]:ml-0",
        CONTROL_HOVER_TRANSITION,
        "[&_button]:!bg-transparent [&_button]:!text-inherit [&_button]:!opacity-100",
        hasInput && "[&_[data-promptbox-submit-action]]:rounded-r-none",
        canSend
          ? "bg-foreground text-background [&_button:hover]:!bg-background/15 [&_button[data-state=open]]:!bg-background/15"
          : "bg-surface-recessed text-subtle-foreground",
      )}
    >
      {children}
      <DropdownMenu open={open && canSubmit} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Send options"
            disabled={!canSubmit}
            aria-hidden={hasInput ? undefined : true}
            className={cn(
              "h-7.5 min-w-0 overflow-hidden rounded-l-none rounded-r-full px-0 transition-[width,scale] ease-smooth motion-reduce:transition-none max-md:pointer-coarse:h-10",
              hasInput
                ? "w-6 duration-(--motion-duration-base)"
                : "w-0 duration-(--motion-duration-fast)",
            )}
          >
            <Icon
              name="ChevronDown"
              className="opacity-50 transition-opacity duration-(--motion-duration-fast) group-hover/send:opacity-100 group-focus-within/send:opacity-100 motion-reduce:transition-none"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" mobileTitle="Send options">
          {items}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
