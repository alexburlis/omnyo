import * as Menu from "@radix-ui/react-dropdown-menu";
import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import type { ReactNode } from "react";

interface ChatMenuProps {
  title: string;
  children: ReactNode;
}

export function ChatMenu({ title, children }: ChatMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button type="button" className="cg-row-menu" aria-label={`Chat actions for ${title}`}>
          <Icon name="MoreHorizontal" aria-hidden className="size-4" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="cg-menu"
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          {children}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

interface ChatMenuItemProps {
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export function ChatMenuItem({ children, onSelect, disabled }: ChatMenuItemProps) {
  return (
    <Menu.Item className="cg-menu-item" onSelect={onSelect} disabled={disabled}>
      {children}
    </Menu.Item>
  );
}
