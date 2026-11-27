// Setting keys, defaults and value shapes, shared by server.ts (which declares
// them) and app.tsx (which reads them back through useSettings). Keeping them
// in one module means a renamed key breaks the build instead of silently
// falling back to a default at runtime.

export const NEEDS_YOU_INTENSITIES = ["subtle", "bold"] as const;

export type NeedsYouIntensity = (typeof NEEDS_YOU_INTENSITIES)[number];

/** Effective, fully resolved settings. */
export type NeedsYouSettings = {
  /** Threads blocked on an approval or a question. */
  needsInput: boolean;
  /** Threads that failed while you were elsewhere and are still unread. */
  unreadFailed: boolean;
  /** Threads that succeeded while you were elsewhere and are still unread. */
  unreadSuccess: boolean;
  /** Messages waiting to send, or that failed to send. Best effort — see the skill. */
  queued: boolean;
  /** Threads the agent is actively working in. Dimmed, not coloured. */
  working: boolean;
  /** Durable waits for a reply from a named chat. */
  callbacks: boolean;
  /** Colour-coded callback groups, traced across projects on hover. */
  callbackLinks: boolean;
  /** `subtle` = colour rail and indicator. `bold` = adds a row tint. */
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

/**
 * Setting keys in the order Omnyo renders them.
 *
 * `satisfies { [K in keyof NeedsYouSettings]: K }` is what makes this module's
 * promise real rather than decorative: every key of NeedsYouSettings must be
 * present, no extra key is allowed, and each value must be its own key spelled
 * identically. app.tsx looks settings up through these constants and server.ts
 * declares its descriptors against the same keyof, so renaming a setting in one
 * place is a compile error rather than a toggle that silently stops working.
 */
export const NEEDS_YOU_KEYS = {
  needsInput: "needsInput",
  unreadFailed: "unreadFailed",
  unreadSuccess: "unreadSuccess",
  queued: "queued",
  working: "working",
  callbacks: "callbacks",
  callbackLinks: "callbackLinks",
  intensity: "intensity",
} as const satisfies { [K in keyof NeedsYouSettings]: K };
