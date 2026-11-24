import type { QueuedMessageWaitingOn } from "@omnyo/domain";
import { Icon } from "@omnyo/shared-ui/icon";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { useSecondTick } from "@/hooks/useSecondTick";
import { usePluginDisplayName } from "@/lib/plugin-logos";
import {
  describeQueuedMessageWait,
  queuedMessageWaitIcon,
} from "@/lib/queued-message-wait";

export interface QueuedSendForecast {
  waitingOn: QueuedMessageWaitingOn;
  sendAt: number | null;
}

const INLINE_PAYLOAD = { kind: "inline" } as const;

export function QueuedSendForecastHint({
  forecast,
}: {
  forecast: QueuedSendForecast;
}) {
  const now = useSecondTick();
  const { waitingOn, sendAt } = forecast;

  const pluginDisplayName = usePluginDisplayName(
    waitingOn.kind === "plugin" ? waitingOn.pluginId : "",
  );

  if (
    waitingOn.kind === "plugin" &&
    waitingOn.pluginId === "concurrency-limit"
  ) {
    return null;
  }

  const wait = { failureReason: null, payload: INLINE_PAYLOAD, waitingOn };

  const label =
    describeQueuedMessageWait({ ...wait, now, pluginDisplayName, sendAt }) ??
    "Queued until the current turn ends";

  const icon = queuedMessageWaitIcon(wait);

  return (
    <span
      role="status"
      data-send-forecast-hint=""
      title={label}
      className="flex min-w-0 max-w-48 items-center gap-1 px-1 text-2xs text-subtle-foreground sm:max-w-64"
    >
      {icon !== null ? (
        <Icon name={icon} className="size-3 shrink-0" aria-hidden />
      ) : waitingOn.kind === "plugin" ? (
        <PluginIcon
          pluginId={waitingOn.pluginId}
          icon={null}
          fallbackIcon={null}
          className="size-3"
        />
      ) : null}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
