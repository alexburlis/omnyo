import { experimental_ResponsiveDrawerShell as ResponsiveDrawerShell } from "@omnyo/plugin-sdk/app";
import type { ReactNode } from "react";

import { useIsCompactViewport } from "../ui/components/ui/hooks/use-compact-viewport";

export function ProjectDrawer({
  open,
  onOpenChange,
  label,
  className,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  className: string;
  children: ReactNode;
}) {
  const compact = useIsCompactViewport();

  const content = (
    <aside
      className={className}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      style={
        compact
          ? {
              position: "relative",
              inset: "auto",
              width: "100%",
              maxWidth: "none",
              maxHeight: "none",
              minHeight: 0,
              overflowY: "auto",
              boxSizing: "border-box",
              border: 0,
              borderRadius: 0,
              boxShadow: "none",
            }
          : undefined
      }
    >
      {children}
    </aside>
  );

  if (!compact) return open ? content : null;

  return (
    <ResponsiveDrawerShell
      open={open}
      onOpenChange={onOpenChange}
      srLabel={label}
      contentClassName="min-h-0 overflow-hidden"
    >
      {content}
    </ResponsiveDrawerShell>
  );
}
