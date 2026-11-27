import { useRealtime } from "@omnyo/plugin-sdk/app";
import { realtimeCardSchema, realtimeChannel } from "../contract";
import { announceCardChange } from "../lib/changed-event";

export function CardChangeBroadcast() {
  useRealtime(realtimeChannel, (payload) => {
    const change = realtimeCardSchema.safeParse(payload);

    if (change.success) announceCardChange(window, change.data);
  });

  return null;
}
