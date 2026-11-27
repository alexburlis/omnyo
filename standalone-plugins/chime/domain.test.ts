import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  EVENT_KINDS,
  SOUND_IDS,
  THEME_IDS,
  THEME_SOUNDS,
  chooseStormNotification,
  matchingTheme,
  themeSoundOptions,
  normalizeConfig,
  shouldPlayNotification,
  visibleThreadId,
  type ChimeNotification,
} from "./domain";

const baseNotification: ChimeNotification = {
  kind: "completed",
  threadId: "thread-1",
  projectId: "project-1",
  timestamp: 10_000,
};

describe("notification policy", () => {
  it("normalizes unsafe persisted values", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      volume: 3,
      mutedProjectIds: ["one", "one", "two"],
      eventSounds: { ...DEFAULT_CONFIG.eventSounds, completed: "not-a-sound" as never },
    });

    expect(config.volume).toBe(1);
    expect(config.mutedProjectIds).toEqual(["one", "two"]);
    expect(config.eventSounds.completed).toBe(DEFAULT_CONFIG.eventSounds.completed);
  });

  it("rejects stale, muted, and visible-thread events", () => {
    expect(shouldPlayNotification(baseNotification, DEFAULT_CONFIG, 15_001, "/threads/elsewhere")).toBe(false);
    expect(shouldPlayNotification(baseNotification, { ...DEFAULT_CONFIG, mutedProjectIds: ["project-1"] }, 10_100, "/")).toBe(false);
    expect(shouldPlayNotification(baseNotification, { ...DEFAULT_CONFIG, muteVisibleThread: true }, 10_100, "/threads/thread-1")).toBe(false);
  });

  it("lets attention events override routine storm events", () => {
    const failed: ChimeNotification = { ...baseNotification, kind: "failed", timestamp: 10_050 };
    const started: ChimeNotification = { ...baseNotification, kind: "started", timestamp: 10_100 };
    expect(chooseStormNotification([baseNotification, failed, started])).toEqual(failed);
  });

  it("finds the visible Omnyo thread without exposing other route segments", () => {
    expect(visibleThreadId("/projects/proj_1/threads/thr_visible")).toBe("thr_visible");
    expect(visibleThreadId("/settings/plugins/chime")).toBeNull();
  });

  it("provides a complete, valid sound set for every theme", () => {
    for (const themeId of THEME_IDS) {
      expect(Object.keys(THEME_SOUNDS[themeId])).toEqual(EVENT_KINDS);
      expect(Object.values(THEME_SOUNDS[themeId]).every((soundId) => SOUND_IDS.includes(soundId))).toBe(true);
      expect(matchingTheme(THEME_SOUNDS[themeId])).toBe(themeId);
    }
  });

  it("keeps turn started and cancelled silent unless enabled", () => {
    expect(normalizeConfig(null).eventEnabled).toMatchObject({ started: false, cancelled: false, completed: true });
    expect(normalizeConfig({ eventEnabled: { started: true } as never }).eventEnabled.started).toBe(true);
  });

  it("offers the Omnyo alternatives under the Omnyo theme only", () => {
    const alternatives = ["omnyo-resolve-b", "omnyo-approval-b", "omnyo-warning-b"] as const;
    expect(themeSoundOptions("omnyo")).toEqual(expect.arrayContaining([...alternatives]));
    for (const themeId of THEME_IDS.filter((candidate) => candidate !== "omnyo")) {
      expect(themeSoundOptions(themeId).some((soundId) => soundId.startsWith("omnyo-"))).toBe(false);
    }
  });

  it("recognizes per-event changes as a custom theme", () => {
    expect(matchingTheme({ ...THEME_SOUNDS.calm, completed: THEME_SOUNDS.glass.completed })).toBe("custom");
  });
});
