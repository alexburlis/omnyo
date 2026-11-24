import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { EmptyStateBlock } from "@omnyo/shared-ui/empty-state";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@omnyo/shared-ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { HOVER_REVEAL_NO_HOVER_VISIBLE_CLASS } from "@omnyo/shared-ui/hover-reveal";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import {
  appToast,
  iconForTone,
  type AppToastTone,
} from "@/components/ui/app-toast";
import { CopyButton } from "@/components/ui/copy-button";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  clearNotifications,
  closeNotificationCenter,
  dismissNotification,
  toggleNotificationCenter,
  useNotificationCenterState,
  useNotifications,
  type AppNotification,
} from "@/lib/notifications/notification-store";

interface NotificationRowProps {
  focused: boolean;
  notification: AppNotification;
  now: number;
}

const ROW_ACTION_CLASS =
  "size-6 rounded-md p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground";

const ROW_ACTIONS_REVEAL_CLASS = cn(
  "absolute top-2.5 right-2.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/notification:opacity-100 group-has-[:focus-visible]/notification:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:-mt-0.5 [@media(hover:none)]:shrink-0",
  HOVER_REVEAL_NO_HOVER_VISIBLE_CLASS,
);

const ROW_TIME_HIDE_CLASS =
  "transition-opacity group-hover/notification:opacity-0 group-has-[:focus-visible]/notification:opacity-0 [@media(hover:none)]:opacity-100";

const TONE_BADGE_CLASS: Record<AppToastTone, string> = {
  error: "bg-destructive/10 text-destructive-text",
  loading: "bg-state-hover text-muted-foreground",
  message: "bg-state-hover text-muted-foreground",
  success: "bg-success/12 text-success",
  warning: "bg-warning/15 text-warning-text",
};

function NotificationCopyButton({
  bodyRef,
  notification,
  now,
}: {
  bodyRef: { current: HTMLDivElement | null };
  notification: AppNotification;
  now: number;
}) {
  const [text, setText] = useState("");

  useLayoutEffect(() => {
    setText(bodyRef.current?.textContent ?? "");
  }, [bodyRef, notification, now]);

  return (
    <CopyButton
      text={text}
      label="Copy notification"
      className={cn(ROW_ACTION_CLASS, "size-auto")}
      iconClassName="size-3.5"
    />
  );
}

function NotificationRow({ focused, notification, now }: NotificationRowProps) {
  const rowRef = useRef<HTMLLIElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focused) {
      return;
    }

    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <li
      ref={rowRef}
      data-testid="notification-row"
      data-focused={focused}
      className={cn(
        "group/notification relative flex items-start gap-3 px-3.5 py-3",
        focused && "bg-state-hover",
      )}
    >
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          TONE_BADGE_CLASS[notification.tone],
        )}
      >
        <Icon
          name={iconForTone(notification.tone)}
          aria-hidden
          className={cn(
            "size-3.5",
            notification.tone === "loading" && "animate-spin",
          )}
        />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div ref={bodyRef}>
          <div className="flex min-w-0 items-baseline gap-2">
            <div className="min-w-0 flex-1 break-words text-sm font-medium leading-5">
              {notification.title}
            </div>
            <div
              className={cn(
                "shrink-0 text-xs leading-5 text-subtle-foreground tabular-nums",
                ROW_TIME_HIDE_CLASS,
              )}
            >
              {formatRelativeTime({ timestamp: notification.createdAt, now })}
            </div>
          </div>
          {notification.description === null ? null : (
            <div className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">
              {notification.description}
            </div>
          )}
        </div>
        {notification.actions.length === 0 ? null : (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {notification.actions.map((action) => (
              <Button
                key={action.kind}
                type="button"
                size="xs"
                variant="soft"
                onClick={(event) => {
                  action.run(event);

                  if (action.kind === "undo") {
                    dismissNotification(notification.id);

                    return;
                  }

                  closeNotificationCenter();
                }}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className={ROW_ACTIONS_REVEAL_CLASS}>
        <NotificationCopyButton
          bodyRef={bodyRef}
          notification={notification}
          now={now}
        />
        <button
          type="button"
          aria-label="Dismiss notification"
          className={ROW_ACTION_CLASS}
          onClick={() => {
            dismissNotification(notification.id);
          }}
        >
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

interface HeaderActionProps {
  disabled: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}

function HeaderAction({ disabled, icon, label, onClick }: HeaderActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground"
          onClick={onClick}
        >
          <Icon name={icon} aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export function NotificationCenter() {
  const { open, focusedId } = useNotificationCenterState();
  const notifications = useNotifications();
  const now = Date.now();

  useAppCommandHandler("notifications.open", () => {
    toggleNotificationCenter();

    return true;
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    appToast.dismiss();
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeNotificationCenter();
        }
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden="true"
          className="pointer-events-none fixed right-[calc(env(safe-area-inset-right)_+_1rem)] bottom-[calc(var(--omnyo-app-footer-height,0px)_+_env(safe-area-inset-bottom)_+_1rem)] size-0"
        />
      </PopoverAnchor>
      <PopoverContent
        dismissOnOutsideInteraction={false}
        side="top"
        align="end"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        mobileTitle="Notifications"
        aria-label="Notifications"
        data-testid="notification-center"
        className="w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border-0 bg-popover bg-[linear-gradient(var(--material-raised),var(--material-raised))] p-0 shadow-(--material-shadow-float)"
      >
        <div className="flex items-center justify-between gap-2 border-b-[0.5px] border-(--material-line) py-2 pr-2 pl-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="text-sm font-semibold leading-5">Notifications</div>
            {notifications.length === 0 ? null : (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-state-hover px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
                {notifications.length}
              </span>
            )}
          </div>
          <TooltipProvider delayDuration={300} disableHoverableContent>
            <div className="flex items-center gap-0.5">
              <HeaderAction
                icon="Trash2"
                label="Clear all"
                disabled={notifications.length === 0}
                onClick={clearNotifications}
              />
              <HeaderAction
                icon="X"
                label="Hide notifications"
                disabled={false}
                onClick={closeNotificationCenter}
              />
            </div>
          </TooltipProvider>
        </div>
        {notifications.length === 0 ? (
          <EmptyStateBlock
            icon="Bell"
            title="You’re all caught up"
            description="Messages from Omnyo collect here. Closing this list clears the ones you’ve seen."
            className="py-8"
          />
        ) : (
          <ul className="max-h-[min(60vh,26rem)] divide-y-[0.5px] divide-(--material-line) overflow-y-auto">
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                focused={notification.id === focusedId}
                notification={notification}
                now={now}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
