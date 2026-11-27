// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAudioLeadership,
  rememberSoundVersions,
  soundUrl,
  startAudioClient,
} from "./client-audio";

describe("audio client leadership", () => {
  beforeEach(() => localStorage.clear());

  it("allows one leader per origin until its lease expires", () => {
    expect(claimAudioLeadership("client-a", 1_000)).toBe(true);
    expect(claimAudioLeadership("client-b", 1_500)).toBe(false);
    expect(claimAudioLeadership("client-b", 3_001)).toBe(true);
  });

  it("lets the current leader renew its lease", () => {
    expect(claimAudioLeadership("client-a", 1_000)).toBe(true);
    expect(claimAudioLeadership("client-a", 2_500)).toBe(true);
    expect(claimAudioLeadership("client-b", 3_000)).toBe(false);
  });

  it("lets a visible client preempt a hidden leader", () => {
    expect(claimAudioLeadership("hidden-client", 1_000, 0)).toBe(true);
    expect(claimAudioLeadership("visible-client", 1_100, 1)).toBe(true);
    expect(claimAudioLeadership("hidden-client", 1_200, 0)).toBe(false);
  });
});

describe("completion audio", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "settled turn", settled: true, sounds: 1, flashes: 1 },
    {
      name: "Chat Topics card",
      settled: true,
      rowAttribute: "data-feed-row",
      sounds: 1,
      flashes: 1,
    },
    { name: "resumed turn", settled: false, sounds: 0, flashes: 0 },
    { name: "unavailable verification", settled: null, sounds: 0, flashes: 0 },
    { name: "blocked audio", settled: true, blocked: true, sounds: 0, flashes: 0 },
    { name: "hidden app", settled: true, hidden: true, sounds: 1, flashes: 0 },
    { name: "zero volume", settled: true, volume: 0, sounds: 1, flashes: 0 },
  ])("plays and highlights a completion: $name", async (scenario) => {
    vi.useFakeTimers();
    localStorage.clear();
    const rowAttribute = scenario.rowAttribute ?? "data-sidebar-rename-row";
    document.body.innerHTML = [
      `<div ${rowAttribute}><div><a data-sidebar-thread-id="thread-1"></a></div><p></p></div>`,
      `<div ${rowAttribute}><div><a data-sidebar-thread-id="thread-2"></a></div></div>`,
    ].join("");
    const [source, other] = document.querySelectorAll<HTMLElement>(`[${rowAttribute}]`);
    const sourceLink = source.querySelector("a")!;
    const cancel = vi.fn();
    const animateSource = vi.fn(() => ({ cancel, onfinish: null }));
    const animateOther = vi.fn();
    const animateLink = vi.fn();
    source.animate = animateSource as unknown as typeof source.animate;
    other.animate = animateOther;
    sourceLink.animate = animateLink;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(
      scenario.hidden ? "hidden" : "visible",
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const played: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        volume = 0;
        constructor(private readonly url: string) {}
        async play() {
          if (scenario.blocked) throw new Error("Audio blocked");
          played.push(this.url);
        }
      },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let delivered = false;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/presence")) return new Response(null, { status: 204 });
      if (url.includes("/completion")) {
        if (scenario.settled === null) return new Response(null, { status: 503 });
        return Response.json({ play: scenario.settled });
      }
      const events = delivered
        ? []
        : [
            {
              seq: 1,
              notification: {
                kind: "completed",
                threadId: "thread-1",
                projectId: "project-1",
                turnSeq: 99,
                timestamp: Date.now(),
              },
            },
            {
              seq: 2,
              notification: {
                kind: "started",
                threadId: "thread-2",
                projectId: "project-1",
                timestamp: Date.now(),
              },
            },
          ];
      delivered = true;
      return Response.json({
        cursor: 2,
        events,
        config: {
          enabled: true,
          volume: scenario.volume ?? 0.5,
          deliveryMode: "client",
          muteVisibleThread: false,
          mutedProjectIds: [],
          eventEnabled: { completed: true, started: true },
          eventSounds: { completed: "warm-resolve" },
        },
      });
    });
    const controller = new AbortController();
    const stop = startAudioClient("chime", controller.signal);
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(played.filter((url) => url.endsWith("sound-warm-resolve"))).toHaveLength(
        scenario.sounds,
      );
      expect(animateSource).toHaveBeenCalledTimes(scenario.flashes);
      expect(animateOther).not.toHaveBeenCalled();
      expect(animateLink).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      stop();
    }
    expect(cancel).toHaveBeenCalledTimes(scenario.flashes);
  });
});

describe("sound urls", () => {
  it("carry the content version so a changed sound bypasses the long-lived cache", () => {
    rememberSoundVersions({ "warm-resolve": "59729f7ea0e0f479", "soft-rise": "not a hash" });
    expect(soundUrl("chime-local", "warm-resolve")).toBe(
      "/api/v1/plugins/chime-local/http/sound-warm-resolve?v=59729f7ea0e0f479",
    );
    expect(soundUrl("chime-local", "soft-rise")).toBe(
      "/api/v1/plugins/chime-local/http/sound-soft-rise",
    );
  });
});
