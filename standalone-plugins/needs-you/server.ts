// omnyo-plugin-needs-you — backend entry.
//
// Declare visual settings and adopt legacy callback records into native Omnyo.
import type { PluginApi, PluginSettingDescriptor } from "@omnyo/plugin-sdk";
import {
  NEEDS_YOU_DEFAULTS,
  NEEDS_YOU_INTENSITIES,
  NEEDS_YOU_KEYS,
  type NeedsYouSettings,
} from "./settings-contract";

export default async function plugin(api: PluginApi): Promise<void> {
  await api.sdk.experimental_attention.adopt({ pluginId: "needs-you" });

  // Keys are the NEEDS_YOU_KEYS constants, not literals, so renaming a setting
  // in the shared type breaks this file too rather than leaving behind a
  // descriptor that nothing reads — or, worse, a missing one that app.tsx
  // silently papers over with a default at runtime.
  //
  // The annotation does all three jobs at once: it supplies the contextual type
  // that keeps `type: "boolean"` a literal instead of widening to `string`, it
  // requires every key of NeedsYouSettings, and it rejects any key that is not
  // one.
  const descriptors: Record<keyof NeedsYouSettings, PluginSettingDescriptor> = {
    [NEEDS_YOU_KEYS.needsInput]: {
      type: "boolean",
      label: "Needs your input",
      description: "Threads with an approval, question or open decision.",
      default: NEEDS_YOU_DEFAULTS.needsInput,
    },
    [NEEDS_YOU_KEYS.unreadFailed]: {
      type: "boolean",
      label: "Finished with an error, unread",
      description: "Threads that failed while you were somewhere else.",
      default: NEEDS_YOU_DEFAULTS.unreadFailed,
    },
    [NEEDS_YOU_KEYS.unreadSuccess]: {
      type: "boolean",
      label: "Finished, unread",
      description: "Threads that succeeded while you were somewhere else.",
      default: NEEDS_YOU_DEFAULTS.unreadSuccess,
    },
    [NEEDS_YOU_KEYS.queued]: {
      type: "boolean",
      label: "Queued messages",
      description:
        "Messages waiting to send, or that failed to send. Uses Omnyo’s native queued indicator.",
      default: NEEDS_YOU_DEFAULTS.queued,
    },
    [NEEDS_YOU_KEYS.working]: {
      type: "boolean",
      label: "Working right now",
      description:
        "Dim the threads the agent is still working in, so the rows that want you stand out against them.",
      default: NEEDS_YOU_DEFAULTS.working,
    },
    [NEEDS_YOU_KEYS.callbacks]: {
      type: "boolean",
      label: "Waiting for a callback",
      description: "Draw the native callback state with a dimmed title and dashed rail.",
      default: NEEDS_YOU_DEFAULTS.callbacks,
    },
    [NEEDS_YOU_KEYS.callbackLinks]: {
      type: "boolean",
      label: "Callback groups",
      description:
        "Mark chats linked by callbacks with a coloured dot and lane per group. Hover one to trace what it waits for and who it calls back, across projects.",
      default: NEEDS_YOU_DEFAULTS.callbackLinks,
    },
    [NEEDS_YOU_KEYS.intensity]: {
      type: "select",
      label: "Intensity",
      description:
        "Subtle draws a colour rail, recolours Omnyo's own indicator and dims working rows a little. Bold adds a tint across the row and dims working rows further.",
      options: [...NEEDS_YOU_INTENSITIES],
      default: NEEDS_YOU_DEFAULTS.intensity,
    },
  };

  api.settings.define(descriptors);
}
