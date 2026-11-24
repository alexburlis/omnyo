import { useCallback, useRef } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import {
  PluginComposerPlusMenuEntry,
  type PluginComposerPlusMenuContribution,
  type PluginComposerPlusMenuSelection,
} from "@/components/plugin/PluginComposerActions";
import { useResolvedComposerPlusMenuItems } from "@/components/plugin/composer-slot-hooks";
import { useOptionalPluginComposerStaticView } from "@/components/plugin/plugin-composer-host";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { Switch } from "@omnyo/shared-ui/switch";
import { formatCompactTokenCount } from "@/components/thread/timeline/thread-context-window-usage";
import { COMPOSER_TOOL_BUTTON_CLASS } from "./composer-tool-button";
import {
  formatAutoCompactionTime,
  type AutoCompactionOffer,
  type CompactBeforeSendOffer,
} from "./CompactBeforeSendChip";
import type { ProviderPromptActionCommand } from "@omnyo/client-core";
import type { PermissionMode } from "@omnyo/domain";
import type { PickerOption } from "@/components/pickers/OptionPicker";

type PromptBoxActionKind = "skills" | "plan" | "goal";

export interface PromptBoxAction {
  kind: PromptBoxActionKind;
  text: string;
  command?: ProviderPromptActionCommand;
}

export interface PromptBoxApprovals {
  value: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
}

export interface PromptBoxChatMenu {
  approvals: PromptBoxApprovals | null;
  compactBeforeSend: CompactBeforeSendOffer | null;
  autoCompaction: AutoCompactionOffer | null;
  onShowTerminal: (() => void) | null;
}

interface PromptBoxActionsMenuProps {
  actions?: readonly PromptBoxAction[];
  onAttach?: () => void;
  onAction: (action: PromptBoxAction) => void;
  approvals?: PromptBoxApprovals;
  chat?: PromptBoxChatMenu;
  pluginItems?: readonly PluginComposerPlusMenuContribution[];
}

export function ComposerPlusMenuSlot(
  props: Omit<PromptBoxActionsMenuProps, "pluginItems">,
) {
  const view = useOptionalPluginComposerStaticView();

  const pluginItems = useResolvedComposerPlusMenuItems(
    view?.scope.kind ?? null,
  );

  return <PromptBoxActionsMenu {...props} pluginItems={pluginItems} />;
}

const PROMPT_ACTION_PRESENTATION = {
  skills: {
    label: "Skills",
    icon: "Zap",
  },
  plan: {
    label: "Plan",
    icon: "ListTodo",
  },
  goal: {
    label: "Goal",
    icon: "Target",
  },
} as const satisfies Record<
  PromptBoxActionKind,
  { label: string; icon: IconName }
>;

const PROMPT_ACTION_ORDER: readonly PromptBoxActionKind[] = [
  "skills",
  "plan",
  "goal",
];

function orderedPromptActions(
  actions: readonly PromptBoxAction[],
): PromptBoxAction[] {
  return PROMPT_ACTION_ORDER.flatMap((kind) => {
    const action = actions.find((candidate) => candidate.kind === kind);

    return action ? [action] : [];
  });
}

export function PromptBoxActionsMenu({
  actions = [],
  onAttach,
  onAction,
  approvals: menuApprovals,
  chat,
  pluginItems = [],
}: PromptBoxActionsMenuProps) {
  const isCompactViewport = useIsCompactViewport();
  const approvals = menuApprovals ?? chat?.approvals ?? null;
  const selectedItemRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const pluginSelectionRef = useRef<PluginComposerPlusMenuSelection | null>(
    null,
  );

  const visibleActions = orderedPromptActions(actions).filter(
    (action) => action.text.length > 0,
  );

  const clearSelectedActionAfterClose = useCallback(() => {
    const clear = () => {
      selectedItemRef.current = false;
      pluginSelectionRef.current = null;
    };

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(clear);

      return;
    }

    setTimeout(clear, 0);
  }, []);

  const restorePluginComposerFocus = useCallback(
    (selection: PluginComposerPlusMenuSelection) => {
      const activeElement = document.activeElement;

      const pluginMovedFocus =
        activeElement !== null &&
        activeElement !== document.body &&
        activeElement !== triggerRef.current &&
        activeElement !== selection.selectedElement &&
        activeElement.isConnected;

      if (!pluginMovedFocus) {
        selection.restoreComposerFocus();
      }
    },
    [],
  );

  const hasItems =
    visibleActions.length > 0 ||
    onAttach !== undefined ||
    pluginItems.length > 0;

  const compactBeforeSend = chat?.compactBeforeSend ?? null;

  const autoCompaction =
    compactBeforeSend === null ? (chat?.autoCompaction ?? null) : null;

  const onShowTerminal = chat?.onShowTerminal ?? null;

  const hasChatRows =
    compactBeforeSend !== null ||
    autoCompaction !== null ||
    onShowTerminal !== null;

  if (!hasItems && !hasChatRows && approvals === null) {
    return null;
  }

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          clearSelectedActionAfterClose();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Prompt actions"
          className={cn(COMPOSER_TOOL_BUTTON_CLASS, "-ml-1.5")}
        >
          <Icon name="Plus" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="Prompt actions"
        align="start"
        side="bottom"
        sideOffset={4}
        className={hasChatRows ? "w-64" : approvals === null ? "w-36" : "w-44"}
        mobileTitle="Prompt actions"
        onCloseAutoFocus={(event) => {
          if (selectedItemRef.current) {
            event.preventDefault();
            const pluginSelection = pluginSelectionRef.current;

            if (pluginSelection) {
              restorePluginComposerFocus(pluginSelection);
            }
          }
        }}
      >
        {onAttach ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                selectedItemRef.current = true;
                onAttach();
              }}
            >
              <Icon
                name="Paperclip"
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              Attach files
            </DropdownMenuItem>
            {visibleActions.length > 0 ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {visibleActions.map((action) => {
          const presentation = PROMPT_ACTION_PRESENTATION[action.kind];

          return (
            <DropdownMenuItem
              key={action.kind}
              onSelect={() => {
                selectedItemRef.current = true;
                onAction(action);
              }}
            >
              <Icon
                name={presentation.icon}
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              {presentation.label}
            </DropdownMenuItem>
          );
        })}
        {pluginItems.map((contribution) => (
          <PluginComposerPlusMenuEntry
            key={contribution.key}
            contribution={contribution}
            onSelected={(selection) => {
              selectedItemRef.current = true;
              pluginSelectionRef.current = selection;
              queueMicrotask(() => restorePluginComposerFocus(selection));
            }}
          />
        ))}
        {hasChatRows ? (
          <>
            {hasItems ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>This chat</DropdownMenuLabel>
            {compactBeforeSend === null ? null : (
              <ChatSwitchRow
                icon="CircleArrowShrink"
                label="Compact before sending"
                detail={`Prompt cache expired · ${formatCompactTokenCount(compactBeforeSend.tokens)} tokens`}
                checked={compactBeforeSend.compactFirst}
                disabled={false}
                onCheckedChange={compactBeforeSend.onCompactFirstChange}
              />
            )}
            {autoCompaction === null ? null : (
              <ChatSwitchRow
                icon="CircleArrowShrink"
                label="Keep full history"
                detail={
                  autoCompaction.keepFullHistory
                    ? "Automatic compaction is off"
                    : `Compacts automatically at ${formatAutoCompactionTime(autoCompaction.at)}`
                }
                checked={autoCompaction.keepFullHistory}
                disabled={autoCompaction.pending}
                onCheckedChange={autoCompaction.onKeepFullHistoryChange}
              />
            )}
            {onShowTerminal === null ? null : (
              <DropdownMenuItem
                onSelect={() => {
                  selectedItemRef.current = true;
                  onShowTerminal();
                }}
              >
                <Icon
                  name="Terminal"
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                Show terminal
              </DropdownMenuItem>
            )}
          </>
        ) : null}
        {approvals === null ? null : (
          <>
            {hasItems || hasChatRows ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>Approvals</DropdownMenuLabel>
            {isCompactViewport ? (
              approvals.options.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  role="menuitemradio"
                  aria-checked={option.value === approvals.value}
                  onSelect={() => approvals.onChange(option.value)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                  {option.value === approvals.value ? (
                    <Icon name="Check" aria-hidden />
                  ) : null}
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuRadioGroup
                value={approvals.value}
                onValueChange={(value) => {
                  const option = approvals.options.find(
                    (candidate) => candidate.value === value,
                  );

                  if (option !== undefined) approvals.onChange(option.value);
                }}
              >
                {approvals.options.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatSwitchRow({
  icon,
  label,
  detail,
  checked,
  disabled,
  onCheckedChange,
}: {
  icon: IconName;
  label: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      data-prompt-actions-chat-switch=""
      className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs has-disabled:opacity-50 max-md:pointer-coarse:py-2"
    >
      <Icon
        name={icon}
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-foreground">{label}</span>
        <span className="truncate text-2xs text-muted-foreground">
          {detail}
        </span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}
