import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Action, ExternalToast } from "sonner";
import { Button } from "@omnyo/shared-ui/button";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  dismissNotification,
  openNotificationCenter,
  recordNotification,
} from "@/lib/notifications/notification-store";
import { withSonnerToast } from "./app-toast-runtime";

export type AppToastTone =
  | "message"
  | "success"
  | "warning"
  | "error"
  | "loading";

type AppToastForwardedOptionKey =
  | "className"
  | "classNames"
  | "dismissible"
  | "duration"
  | "id"
  | "invert"
  | "onAutoClose"
  | "onDismiss"
  | "position"
  | "richColors"
  | "style"
  | "unstyled";

export interface AppToastOptions extends Pick<
  ExternalToast,
  AppToastForwardedOptionKey
> {
  action?: Action;
  badge?: boolean;
  cancel?: Action;
  description?: ReactNode;
  undo?: () => void;
}

interface AppToastContentProps {
  action?: Action;
  cancel?: Action;
  description?: ReactNode;
  dismissible?: boolean;
  id?: number | string;
  notificationId?: string | null;
  onDismiss?: () => void;
  title: ReactNode;
  tone: AppToastTone;
  undo?: () => void;
}

interface AppToastOverflowTextProps {
  className?: string;
  content: ReactNode;
  notificationId: string | null;
  onShowMore: () => void;
  testId: string;
}

interface ShowAppToastParams {
  options?: AppToastOptions;
  title: ReactNode;
  tone: AppToastTone;
}

interface AppToastActionButtonProps {
  action: Action;
  emphasis: "soft" | "ghost";
  id?: number | string;
  priority: "primary" | "secondary";
}

type AppToastMethod = (
  title: ReactNode,
  options?: AppToastOptions,
) => string | number;

const DEFAULT_TOAST_DURATION = 4000;

const TONE_ICON_CLASS: Record<AppToastTone, string> = {
  error: "text-destructive",
  loading: "text-muted-foreground",
  message: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
};

export function iconForTone(tone: AppToastTone): IconName {
  switch (tone) {
    case "success":
      return "CircleCheck";
    case "warning":
      return "AlertTriangle";
    case "error":
      return "AlertCircle";
    case "loading":
      return "Loading";
    case "message":
      return "Info";
  }
}

function dismissToast(id: number | string | undefined): void {
  if (id === undefined) {
    return;
  }

  withSonnerToast((sonnerToast) => sonnerToast.dismiss(id));
}

function AppToastActionButton({
  action,
  emphasis,
  id,
  priority,
}: AppToastActionButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    action.onClick(event);

    if (priority === "primary" && event.defaultPrevented) {
      return;
    }

    dismissToast(id);
  };

  return (
    <Button
      type="button"
      variant={emphasis}
      size="xs"
      className={cn(
        "shrink-0",
        emphasis === "ghost" && "text-muted-foreground",
      )}
      onClick={handleClick}
    >
      {action.label}
    </Button>
  );
}

function AppToastOverflowText({
  className,
  content,
  notificationId,
  onShowMore,
  testId,
}: AppToastOverflowTextProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;

    if (body === null) {
      return;
    }

    const measure = () => {
      setTruncated(
        body.scrollHeight - body.clientHeight > 1 ||
          body.scrollWidth - body.clientWidth > 1,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);

    return () => observer.disconnect();
  }, [content]);

  return (
    <div className="min-w-0 w-full">
      <div
        ref={bodyRef}
        data-testid={testId}
        className={cn(
          "line-clamp-4 whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
          className,
        )}
      >
        {content}
      </div>
      {truncated && notificationId !== null ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto shrink-0 px-0 py-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={onShowMore}
        >
          Show more
        </Button>
      ) : null}
    </div>
  );
}

export function AppToastContent({
  action,
  cancel,
  description,
  dismissible = true,
  id,
  notificationId = null,
  onDismiss,
  title,
  tone,
  undo,
}: AppToastContentProps) {
  const hasActions =
    action !== undefined || undo !== undefined || cancel !== undefined;

  const showNotification = () => {
    dismissToast(id);
    openNotificationCenter(notificationId);
  };

  const actions = hasActions ? (
    <>
      {action ? (
        <AppToastActionButton
          action={action}
          emphasis="soft"
          id={id}
          priority="primary"
        />
      ) : null}
      {undo ? (
        <AppToastActionButton
          action={{
            label: "Undo",
            onClick: () => {
              undo();

              if (notificationId !== null) {
                dismissNotification(notificationId);
              }
            },
          }}
          emphasis={action === undefined ? "soft" : "ghost"}
          id={id}
          priority="secondary"
        />
      ) : null}
      {cancel ? (
        <AppToastActionButton
          action={cancel}
          emphasis="ghost"
          id={id}
          priority="secondary"
        />
      ) : null}
    </>
  ) : null;

  return (
    <div
      data-app-toast-surface=""
      className="w-[var(--width,320px)] max-w-[calc(100vw-32px)] shrink-0 rounded-xl bg-popover py-2.5 pr-2.5 pl-3 text-popover-foreground shadow-(--material-shadow-float) max-[600px]:w-[calc(100vw-32px-env(safe-area-inset-left)-env(safe-area-inset-right))]"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center",
            TONE_ICON_CLASS[tone],
          )}
        >
          <Icon
            name={iconForTone(tone)}
            className={cn("size-4", tone === "loading" && "animate-spin")}
            style={{ margin: 0 }}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <AppToastOverflowText
              className="text-sm font-medium leading-5"
              content={title}
              notificationId={notificationId}
              onShowMore={showNotification}
              testId="app-toast-title"
            />
          </div>
          {description || hasActions ? (
            <div className="mt-0.5 flex min-w-0 flex-col items-start gap-2 text-xs leading-5 text-muted-foreground">
              {description ? (
                <AppToastOverflowText
                  content={description}
                  notificationId={notificationId}
                  onShowMore={showNotification}
                  testId="app-toast-description"
                />
              ) : null}
              {hasActions ? (
                <div className="flex flex-wrap gap-1.5">{actions}</div>
              ) : null}
            </div>
          ) : null}
        </div>
        {dismissible ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 rounded-md text-muted-foreground"
            aria-label="Dismiss notification"
            onClick={() => (onDismiss ? onDismiss() : dismissToast(id))}
          >
            <Icon
              name="X"
              className="size-3.5"
              style={{ margin: 0 }}
              aria-hidden
            />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

let nextToastId = 0;

function showAppToast({
  options,
  title,
  tone,
}: ShowAppToastParams): string | number {
  const {
    action,
    badge = tone !== "success",
    cancel,
    className,
    description,
    dismissible = true,
    duration,
    undo,
    ...sonnerOptions
  } = options ?? {};

  const nextDuration =
    duration ?? (tone === "loading" ? Infinity : DEFAULT_TOAST_DURATION);

  const notificationId =
    tone === "loading"
      ? null
      : recordNotification({
          toastId: sonnerOptions.id ?? null,
          tone,
          title,
          description: description ?? null,
          actions:
            undo === undefined
              ? []
              : [{ kind: "undo", label: "Undo", run: () => undo() }],
          badge,
          createdAt: Date.now(),
        });

  const toastId = sonnerOptions.id ?? `app-toast-${(nextToastId += 1)}`;
  withSonnerToast((sonnerToast) =>
    sonnerToast.custom(
      (id) => (
        <AppToastContent
          action={action}
          cancel={cancel}
          description={description}
          dismissible={dismissible}
          id={id}
          notificationId={notificationId}
          title={title}
          tone={tone}
          undo={undo}
        />
      ),
      {
        ...sonnerOptions,
        id: toastId,
        className: cn("omnyo-app-toast", className),
        dismissible,
        duration: nextDuration,
      },
    ),
  );

  return toastId;
}

const showMessageToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "message" });

const showSuccessToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "success" });

const showWarningToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "warning" });

const showErrorToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "error" });

const showLoadingToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "loading" });

function dismissAppToast(id?: number | string): void {
  withSonnerToast((sonnerToast) => sonnerToast.dismiss(id));
}

export const appToast = {
  dismiss: dismissAppToast,
  error: showErrorToast,
  loading: showLoadingToast,
  message: showMessageToast,
  success: showSuccessToast,
  warning: showWarningToast,
};
