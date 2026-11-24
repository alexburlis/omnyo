import { useEffect, useRef } from "react";
import { FooterItemControls } from "@/components/settings/SidebarFooterSettings";
import { SidebarFooterCustomizeHeader } from "./SidebarFooterCustomizeHeader";
import type { SidebarFooterPlacement } from "./sidebarFooterPreferences";

export type SidebarFooterCustomizePlacement = SidebarFooterPlacement;

export interface SidebarFooterCustomizeProps {
  onDone: () => void;
  placement?: SidebarFooterCustomizePlacement;
  onReorderingChange?: (reordering: boolean) => void;
}

export function SidebarFooterCustomize({
  onDone,
  placement = "sidebar",
  onReorderingChange,
}: SidebarFooterCustomizeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current
      ?.querySelector<HTMLButtonElement>('[role="switch"]')
      ?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      className="space-y-2 py-1"
      data-testid="sidebar-footer-customize-inline"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onDone();
      }}
    >
      <SidebarFooterCustomizeHeader onDone={onDone} />
      <FooterItemControls
        placement={placement}
        onReorderingChange={onReorderingChange}
      />
    </div>
  );
}
