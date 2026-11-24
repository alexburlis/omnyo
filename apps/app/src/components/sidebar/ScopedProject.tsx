import { cn } from "@omnyo/shared-ui/lib/utils";
import { useProjectRailCatalog } from "./project-rail-catalog";
import { useSidebarScope } from "./sidebarScope";

function useScopedProjectEntry() {
  const scope = useSidebarScope();
  const { entries } = useProjectRailCatalog();

  return scope.kind === "project"
    ? entries.find(({ project }) => project.id === scope.projectId)
    : undefined;
}

export function ScopedProjectTitle({ className }: { className?: string }) {
  const entry = useScopedProjectEntry();

  if (entry === undefined) return null;

  return (
    <span
      data-testid="window-title-project"
      title={entry.project.name}
      className={cn(
        "min-w-0 truncate text-sm font-semibold text-sidebar-foreground/85 select-none",
        className,
      )}
    >
      {entry.project.name}
    </span>
  );
}
