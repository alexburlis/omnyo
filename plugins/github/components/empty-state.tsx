import type { ComponentProps } from "react";
import { EmptyStateBlock } from "@/components/ui/empty-state";

type EmptyStateIcon = NonNullable<
  ComponentProps<typeof EmptyStateBlock>["icon"]
>;

export function EmptyState({
  title,
  message,
  icon = "Github",
  tone = "neutral",
}: {
  title: string;
  message: string;
  icon?: EmptyStateIcon;
  tone?: "neutral" | "error";
}) {
  return (
    <div role={tone === "error" ? "alert" : undefined} className="py-6">
      <EmptyStateBlock
        icon={icon}
        tone={tone}
        title={title}
        description={message}
      />
    </div>
  );
}
