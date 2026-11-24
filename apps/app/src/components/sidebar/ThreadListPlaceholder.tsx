import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { cn } from "@omnyo/shared-ui/lib/utils";

export type ThreadListPlaceholderState =
  | { kind: "loading" }
  | { kind: "missing"; onReload: () => void }
  | { kind: "crashed"; pluginTitle: string; onReload: () => void };

function LoadingRow({ textWidthClassName }: { textWidthClassName: string }) {
  return (
    <div
      data-sidebar="navigation-loading-row"
      className="flex h-7 items-center gap-2 rounded-md"
    >
      <Skeleton className="size-4 shrink-0 rounded-md bg-sidebar-border/60" />
      <Skeleton
        className={cn(
          "h-3 rounded-sm bg-sidebar-border/50",
          textWidthClassName,
        )}
      />
    </div>
  );
}

export function ThreadListPlaceholder({
  state,
}: {
  state: ThreadListPlaceholderState;
}) {
  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading sidebar navigation"
        data-thread-list-placeholder="loading"
        className="p-2"
      >
        <div className="space-y-1.5 px-2 pt-1">
          <LoadingRow textWidthClassName="w-2/3" />
          <LoadingRow textWidthClassName="w-1/2" />
        </div>
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <ThreadListProblem
        role="status"
        placeholder="missing"
        icon="MessageSquare"
        title="Thread list unavailable."
        detail="Your threads are safe. The thread list plugin isn’t loaded. Retry, or check that it’s turned on in Plugins."
        actionLabel="Retry"
        onAction={state.onReload}
      />
    );
  }

  return (
    <ThreadListProblem
      role="alert"
      placeholder="crashed"
      icon="AlertTriangle"
      title={`${state.pluginTitle} stopped working.`}
      detail="Your threads are safe. Reload the list to show them again."
      actionLabel="Reload"
      onAction={state.onReload}
    />
  );
}

function ThreadListProblem({
  role,
  placeholder,
  icon,
  title,
  detail,
  actionLabel,
  onAction,
}: {
  role: "status" | "alert";
  placeholder: "missing" | "crashed";
  icon: "MessageSquare" | "AlertTriangle";
  title: string;
  detail: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="p-2">
      <div
        role={role}
        data-thread-list-placeholder={placeholder}
        className="flex flex-col gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-3"
      >
        <div className="flex items-start gap-2">
          <Icon
            name={icon}
            aria-hidden="true"
            className={cn(
              "mt-px size-4 shrink-0",
              placeholder === "crashed"
                ? "text-warning-text"
                : "text-muted-foreground",
            )}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-sidebar-foreground">
              {title}
            </span>
            <span className="text-xs text-muted-foreground">{detail}</span>
          </div>
        </div>
        <Button
          type="button"
          variant="soft"
          size="xs"
          className="self-start"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
