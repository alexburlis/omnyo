import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useState, type MouseEvent, type PointerEvent, type ReactElement } from "react";
import {
  ALWAYS_SHOWN_SECTION,
  INBOX_SECTION_LABEL,
  isDefaultSections,
  resetInboxSections,
  setInboxSectionShown,
  setInboxShowEmpty,
  useInboxSections,
} from "../lib/inbox-order.ts";

export const PORTAL_SCOPE = {
  "data-omnyo-portaled-overlay": "",
  "data-omnyo-plugin-root": "",
  "data-omnyo-plugin": "chat-topics",
} as const;

const TEXT_FIELDS = "input, textarea, select, [contenteditable]";

function skipForeignTargets(event: MouseEvent<HTMLElement>) {
  const target = event.target;

  if (!(target instanceof Element) || !event.currentTarget.contains(target)) {
    event.stopPropagation();

    return;
  }

  if (target.closest(TEXT_FIELDS) !== null) event.stopPropagation();
}

export function ignoreSecondaryRelease(event: PointerEvent<HTMLDivElement>) {
  if (event.button !== 0) event.preventDefault();
}

function Check() {
  return (
    <span className="ct-view-menu-check">
      <ContextMenu.ItemIndicator>
        <Icon name="Check" aria-hidden className="size-3.5" />
      </ContextMenu.ItemIndicator>
    </span>
  );
}

function InboxViewItems() {
  const sections = useInboxSections();

  return (
    <>
      <ContextMenu.Label className="ct-view-menu-label">Show in Inbox</ContextMenu.Label>
      {sections.order.map((key) => (
        <ContextMenu.CheckboxItem
          key={key}
          className="ct-view-menu-item"
          data-view-section={key}
          checked={!sections.hidden.has(key)}
          disabled={key === ALWAYS_SHOWN_SECTION}
          onCheckedChange={(checked) => setInboxSectionShown(key, checked)}
        >
          {INBOX_SECTION_LABEL[key]}
          <Check />
        </ContextMenu.CheckboxItem>
      ))}
      <ContextMenu.Separator className="ct-view-menu-separator" />
      <ContextMenu.CheckboxItem
        className="ct-view-menu-item"
        data-view-option="show-empty"
        checked={sections.showEmpty}
        onCheckedChange={setInboxShowEmpty}
      >
        Show empty sections
        <Check />
      </ContextMenu.CheckboxItem>
      <ContextMenu.Separator className="ct-view-menu-separator" />
      <ContextMenu.Item
        className="ct-view-menu-item"
        data-view-option="reset"
        disabled={isDefaultSections(sections)}
        onSelect={resetInboxSections}
      >
        Reset to default
      </ContextMenu.Item>
    </>
  );
}

interface InboxViewMenuProps {
  disabled: boolean;
  children: ReactElement;
}

export function InboxViewMenu({ disabled, children }: InboxViewMenuProps) {
  const [mouse, setMouse] = useState(true);

  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger
        asChild
        disabled={disabled || !mouse}
        onPointerDownCapture={(event) => setMouse(event.pointerType === "mouse")}
        onContextMenuCapture={skipForeignTargets}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...PORTAL_SCOPE}
          className="ct-view-menu"
          aria-label="Inbox view"
          collisionPadding={8}
          onPointerUpCapture={ignoreSecondaryRelease}
        >
          <InboxViewItems />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
