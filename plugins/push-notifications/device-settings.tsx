import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusBadge, type StatusTone } from "@/components/ui/status-row";
import { SuccessCheck } from "@/components/ui/success-check";
import type { ClientChannel } from "./client.js";

export interface NotificationSettingsMessage {
  tone: "success" | "error";
  text: string;
}

export interface NotificationDeviceSettingsViewProps {
  channel: ClientChannel;
  permission: NotificationPermission | "unsupported";
  enabled: boolean;
  busy: boolean;
  message: NotificationSettingsMessage | null;
  onAllow: () => void;
  onTest: () => void;
}

export function NotificationDeviceSettingsView({
  channel,
  permission,
  enabled,
  busy,
  message,
  onAllow,
  onTest,
}: NotificationDeviceSettingsViewProps) {
  const permissionPresentation: {
    tone: StatusTone;
    label: string;
    detail: string;
  } =
    permission === "unsupported"
      ? {
          tone: "neutral",
          label: "Unavailable",
          detail:
            "System notifications are unavailable here. Use a supported browser over HTTPS or localhost.",
        }
      : permission === "denied"
        ? {
            tone: "error",
            label: "Blocked",
            detail:
              "Notifications are blocked. Allow them in your browser or system notification settings, then return here.",
          }
        : permission === "granted"
          ? {
              tone: "success",
              label: "Allowed",
              detail:
                "Notifications allowed. Your system notification settings also apply.",
            }
          : {
              tone: "pending",
              label: "Not allowed yet",
              detail:
                "Allow notifications on this device to hear when a chat finishes or needs you.",
            };

  const deviceLabel =
    channel === "desktop" ? "This desktop app" : "This browser";

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-3.5 py-3">
        <span
          aria-hidden
          className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground"
        >
          <Icon
            name={channel === "desktop" ? "Laptop" : "Browser"}
            className="size-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="font-medium text-foreground">{deviceLabel}</h3>
            <StatusBadge tone={permissionPresentation.tone}>
              {permissionPresentation.label}
            </StatusBadge>
          </div>
          <p
            className="mt-0.5 text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            {permissionPresentation.detail}
          </p>
        </div>
        {permission === "default" ? (
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            disabled={busy || !enabled}
            onClick={onAllow}
          >
            Allow notifications
          </Button>
        ) : null}
        {permission === "granted" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={busy || !enabled}
            onClick={onTest}
          >
            Send test notification
          </Button>
        ) : null}
      </div>
      {!enabled ? (
        <Alert variant="warning">
          <Icon name="AlertTriangle" />
          <AlertDescription>
            Turn on {channel === "desktop" ? "desktop" : "web"} notifications
            above first. Until then this{" "}
            {channel === "desktop" ? "app" : "browser"} receives nothing.
          </AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <p
          role="status"
          className={
            message.tone === "error"
              ? "flex items-start gap-1.5 text-xs text-destructive-text"
              : "flex items-start gap-1.5 text-xs text-muted-foreground"
          }
        >
          {message.tone === "error" ? (
            <Icon name="AlertCircle" className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <SuccessCheck animate size="sm" className="mt-0.5" />
          )}
          {message.text}
        </p>
      ) : null}
      <p className="text-xs text-subtle-foreground">
        Notification switches on this page apply to the whole Omnyo server. Each
        browser and desktop app also asks for its own permission. Clicking a
        notification opens its chat.
      </p>
    </div>
  );
}
