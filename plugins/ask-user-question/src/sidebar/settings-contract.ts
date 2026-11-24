import type { PluginApi, PluginSettingDescriptor } from "@omnyo/plugin-sdk";

export const NEEDS_YOU_INTENSITIES = ["subtle", "bold"] as const;

export type NeedsYouIntensity = (typeof NEEDS_YOU_INTENSITIES)[number];

export type NeedsYouSettings = {
  needsInput: boolean;
  unreadFailed: boolean;
  unreadSuccess: boolean;
  queued: boolean;
  working: boolean;
  callbacks: boolean;
  callbackLinks: boolean;
  intensity: NeedsYouIntensity;
};

export const NEEDS_YOU_DEFAULTS: NeedsYouSettings = {
  needsInput: true,
  unreadFailed: true,
  unreadSuccess: true,
  queued: true,
  working: true,
  callbacks: true,
  callbackLinks: true,
  intensity: "subtle",
};

export const NEEDS_YOU_KEYS = {
  needsInput: "needsInput",
  unreadFailed: "unreadFailed",
  unreadSuccess: "unreadSuccess",
  queued: "queued",
  working: "working",
  callbacks: "callbacks",
  callbackLinks: "callbackLinks",
  intensity: "intensity",
} as const satisfies {
  [K in keyof NeedsYouSettings]: K;
};

export function defineNeedsYouSettings(api: PluginApi): void {
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
      description:
        "Draw the native callback state with a dimmed title and dashed rail.",
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
