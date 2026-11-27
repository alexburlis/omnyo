import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import { Button } from "./button.tsx";

const ITEM =
  "flex min-h-8 cursor-pointer items-center rounded px-2 text-sm text-popover-foreground no-underline outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-state-hover pointer-coarse:min-h-10";

export function Menu({
  label,
  children,
  restoreFocus = true,
}: {
  label: string;
  children: ReactNode;
  restoreFocus?: boolean;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={label}>
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        align="end"
        sideOffset={4}
        onCloseAutoFocus={(event) => {
          if (!restoreFocus) event.preventDefault();
        }}
        className="z-50 min-w-52 rounded-md border border-border bg-popover p-1 shadow-md"
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  children,
  onSelect,
  disabled = false,
}: {
  children: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item className={ITEM} disabled={disabled} onSelect={onSelect}>
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuLink({ children, href }: { children: string; href: string }) {
  return (
    <DropdownMenu.Item asChild className={ITEM}>
      <a href={href}>{children}</a>
    </DropdownMenu.Item>
  );
}
