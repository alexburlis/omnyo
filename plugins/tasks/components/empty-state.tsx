import type { ReactNode } from "react";
import { EmptyStateBlock } from "@/components/ui/empty-state";
import type { IconName } from "@/components/ui/icon";

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
}: {
  icon: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div className="flex h-full min-h-64 items-center justify-center p-6">
      <EmptyStateBlock
        icon={icon}
        tone={tone}
        title={title}
        description={description}
        actions={action}
      />
    </div>
  );
}
