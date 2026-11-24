import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

export type ThreadListNoticeTone = "empty" | "loading" | "error";

const NOTICE_ICON: Record<ThreadListNoticeTone, string> = {
  empty: "MessageSquare",
  loading: "Spinner",
  error: "AlertCircle",
};

export function ThreadListNotice({
  tone,
  children,
  detail,
  className,
}: {
  tone: ThreadListNoticeTone;
  children: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-thread-list-notice={tone}
      className={cn(
        "flex min-h-7 min-w-0 items-start gap-1.5 rounded-md py-1.5 pr-2 pl-2 text-xs leading-4",
        tone === "error" ? "text-destructive-text" : "text-subtle-foreground",
        className,
      )}
    >
      <Icon
        name={NOTICE_ICON[tone]}
        aria-hidden="true"
        className={cn(
          "mt-px size-3.5 shrink-0",
          tone === "loading" && "animate-spin motion-reduce:animate-none",
        )}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="min-w-0">{children}</span>
        {detail === undefined ? null : (
          <span className="min-w-0 text-subtle-foreground">{detail}</span>
        )}
      </span>
    </div>
  );
}
