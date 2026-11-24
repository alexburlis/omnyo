import { Fragment } from "react";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { Switch } from "@omnyo/shared-ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@omnyo/shared-ui/toggle-group";
import { LIST_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "@omnyo/shared-ui/menu-item-hover";
import { cn } from "@omnyo/shared-ui/lib/utils";
import type {
  SessionOptionChoice,
  SessionOptionMenuSection,
} from "./SessionOptionsMenu";
import { FAVORITE_SEGMENTS_CLASS_NAME } from "./ModelFavoritesBar";
import {
  ModelPickerMatrix,
  type ModelPickerMatrixProps,
} from "./ModelPickerMatrix";

const OPTION_ROW_CLASS_NAME =
  "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-sm px-2 py-[0.3125rem] text-xs";

const CHOICE_ITEM_CLASS_NAME = cn(
  "h-6 min-w-0 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-normal text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground data-[state=on]:bg-state-active data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:hover:bg-state-active",
  "max-md:pointer-coarse:h-9 max-md:pointer-coarse:text-sm",
  LIST_HOVER_TRANSITION,
);

export interface ModelReasoningMenuProps {
  matrix: ModelPickerMatrixProps;
  agentSections: readonly SessionOptionMenuSection[];
  onAgentOptionChange: (optionId: string, value: SessionOptionChoice) => void;
  onStartHandoff: (() => void) | null;
}

export function ModelReasoningMenu({
  matrix,
  agentSections,
  onAgentOptionChange,
  onStartHandoff,
}: ModelReasoningMenuProps) {
  return (
    <MenuHoverProvider>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ModelPickerMatrix {...matrix} />

        {agentSections.map((section) => {
          const note = section.appliesOnNextTurn ? (
            <span className="ml-1.5 font-normal text-subtle-foreground">
              from the next turn
            </span>
          ) : null;

          const on = section.items.find((item) => item.value === true);

          if (on !== undefined) {
            return (
              <Fragment key={section.id}>
                <div className="shrink-0 border-t border-border" />
                <div className="shrink-0 p-1">
                  <div
                    className="flex items-center justify-between gap-3 rounded-sm px-2 py-[0.3125rem] text-xs"
                    title={section.description ?? undefined}
                  >
                    <span className="min-w-0 truncate">
                      {section.label}
                      {note}
                    </span>
                    <Switch
                      checked={on.selected}
                      onCheckedChange={(enabled) =>
                        onAgentOptionChange(section.id, enabled)
                      }
                      aria-label={section.label}
                      className={cn(LIST_HOVER_TRANSITION, "[&>span]:size-3.5")}
                    />
                  </div>
                </div>
              </Fragment>
            );
          }

          return (
            <Fragment key={section.id}>
              <div className="shrink-0 border-t border-border" />
              <div className="shrink-0 p-1">
                <div className={OPTION_ROW_CLASS_NAME}>
                  <span className="min-w-0">
                    {section.label}
                    {note}
                  </span>
                  <ToggleGroup
                    type="single"
                    aria-label={section.label}
                    value={
                      section.items.find((item) => item.selected)?.key ?? ""
                    }
                    onValueChange={(key) => {
                      const item = section.items.find(
                        (candidate) => candidate.key === key,
                      );

                      if (item !== undefined) {
                        onAgentOptionChange(section.id, item.value);
                      }
                    }}
                    className={cn(FAVORITE_SEGMENTS_CLASS_NAME, "flex-wrap")}
                  >
                    {section.items.map((item) => (
                      <ToggleGroupItem
                        key={item.key}
                        value={item.key}
                        title={item.description ?? undefined}
                        className={CHOICE_ITEM_CLASS_NAME}
                      >
                        {item.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </div>
            </Fragment>
          );
        })}

        {onStartHandoff ? (
          <>
            <div className="shrink-0 border-t border-border" />
            <div className="shrink-0 p-1">
              <MenuActionButton
                label="Handoff to new thread"
                iconName="MessageSquarePlus"
                onClick={onStartHandoff}
              />
            </div>
          </>
        ) : null}
      </div>
    </MenuHoverProvider>
  );
}

function MenuActionButton({
  label,
  iconName,
  onClick,
}: {
  label: string;
  iconName: IconName;
  onClick: () => void;
}) {
  const { hoverProps } = useMenuItemHover();

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 text-xs outline-none hover:bg-state-hover hover:text-foreground",
        LIST_HOVER_TRANSITION,
        MENU_ITEM_LAST_HOVERED_CLASS,
        "py-[0.3125rem] max-md:pointer-coarse:py-2",
      )}
      {...hoverProps}
    >
      <Icon name={iconName} className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
