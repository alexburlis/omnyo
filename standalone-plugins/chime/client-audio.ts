import {
  chooseStormNotification,
  normalizeConfig,
  shouldPlayNotification,
  visibleThreadId,
  type ChimeConfig,
  type ChimeNotification,
  type QueuedChimeNotification,
  type SoundId,
} from "./domain";
import { StormBuffer } from "./storm-buffer";

const POLL_MS = 500;
const STORM_WINDOW_MS = 1_000;
const CHAT_HIGHLIGHT_MS = 1_200;
const LEASE_MS = 2_000;
const LEASE_KEY = "omnyo-plugin-chime-local:leader";
const AUDIO_STATUS_KEY = "omnyo-plugin-chime-local:audio-status";

interface PollResponse {
  cursor: number;
  events: QueuedChimeNotification[];
  config: ChimeConfig;
  soundVersions?: unknown;
}

const soundVersions = new Map<string, string>();

export function rememberSoundVersions(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [soundId, version] of Object.entries(value))
    if (typeof version === "string" && /^[a-f0-9]{8,64}$/u.test(version))
      soundVersions.set(soundId, version);
}

interface Lease {
  owner: string;
  expiresAt: number;
  priority: number;
}

function readLease(): Lease | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEASE_KEY) ?? "null") as Partial<Lease> | null;
    return parsed && typeof parsed.owner === "string" && typeof parsed.expiresAt === "number"
      ? {
          owner: parsed.owner,
          expiresAt: parsed.expiresAt,
          priority: typeof parsed.priority === "number" ? parsed.priority : 0,
        }
      : null;
  } catch {
    return null;
  }
}

export function claimAudioLeadership(clientId: string, now = Date.now(), priority = 0): boolean {
  const lease = readLease();
  if (lease && lease.owner !== clientId && lease.expiresAt > now && lease.priority >= priority)
    return false;
  localStorage.setItem(
    LEASE_KEY,
    JSON.stringify({ owner: clientId, expiresAt: now + LEASE_MS, priority }),
  );
  return readLease()?.owner === clientId;
}

export function soundUrl(pluginId: string, soundId: SoundId): string {
  const version = soundVersions.get(soundId);
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/sound-${soundId}${version ? `?v=${version}` : ""}`;
}

export async function playClientSound(
  pluginId: string,
  soundId: SoundId,
  volume: number,
): Promise<void> {
  const audio = new Audio(soundUrl(pluginId, soundId));
  audio.volume = volume;
  try {
    await audio.play();
    localStorage.setItem(AUDIO_STATUS_KEY, "active");
  } catch (error) {
    localStorage.setItem(AUDIO_STATUS_KEY, "blocked");
    throw error;
  }
}

export function audioActivationStatus(): "active" | "blocked" | "unknown" {
  const status = localStorage.getItem(AUDIO_STATUS_KEY);
  return status === "active" || status === "blocked" ? status : "unknown";
}

export function startAudioClient(pluginId: string, signal: AbortSignal): () => void {
  const clientId = crypto.randomUUID();
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latestConfig = normalizeConfig(null);
  const highlights = new Map<HTMLElement, Animation>();

  function highlightChat(threadId: string): void {
    if (signal.aborted || document.visibilityState !== "visible") return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const link of document.querySelectorAll<HTMLElement>("a[data-sidebar-thread-id]")) {
      if (link.dataset.sidebarThreadId !== threadId) continue;
      const row = link.closest<HTMLElement>("[data-sidebar-rename-row], [data-feed-row]") ?? link;
      highlights.get(row)?.cancel();
      const ownShadow = getComputedStyle(row).boxShadow;
      const restShadow = ownShadow === "" || ownShadow === "none" ? "" : `, ${ownShadow}`;
      const highlight = row.animate(
        [
          {
            boxShadow: `inset 0 0 0 9999px color-mix(in oklab, var(--attention) 30%, transparent)${restShadow}`,
          },
          { boxShadow: `inset 0 0 0 9999px transparent${restShadow}` },
        ],
        { duration: CHAT_HIGHLIGHT_MS, easing: reduceMotion ? "steps(1, end)" : "ease" },
      );
      highlights.set(row, highlight);
      highlight.onfinish = () => {
        if (highlights.get(row) === highlight) highlights.delete(row);
      };
    }
  }

  const storm = new StormBuffer<ChimeNotification>(
    STORM_WINDOW_MS,
    (notifications) =>
      chooseStormNotification(
        notifications.filter((notification) =>
          shouldPlayNotification(notification, latestConfig, Date.now(), window.location.pathname),
        ),
      ),
    (notification) =>
      void (async () => {
        if (notification.kind === "completed") {
          if (notification.turnSeq === undefined) return;
          const response = await fetch(
            `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/completion?threadId=${encodeURIComponent(notification.threadId)}&turnSeq=${notification.turnSeq}`,
            { cache: "no-store", signal },
          );
          if (!response.ok) throw new Error(`completion verification returned ${response.status}`);
          if ((await response.json()).play !== true) return;
        }
        if (signal.aborted) return;
        const { eventSounds, volume } = latestConfig;
        await playClientSound(pluginId, eventSounds[notification.kind], volume);
        if (volume > 0) highlightChat(notification.threadId);
      })().catch((error: unknown) => {
        if (!signal.aborted) console.warn("[plugin:chime-local] playback failed", error);
      }),
  );

  const poll = async () => {
    if (signal.aborted) return;
    try {
      const visibleThread =
        document.visibilityState === "visible"
          ? (visibleThreadId(window.location.pathname) ?? "")
          : "";
      await fetch(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/presence?client=${encodeURIComponent(clientId)}&visibleThread=${encodeURIComponent(visibleThread)}`,
        { cache: "no-store", signal },
      );
      if (
        claimAudioLeadership(clientId, Date.now(), document.visibilityState === "visible" ? 1 : 0)
      ) {
        const response = await fetch(
          `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/events?after=${cursor}`,
          { cache: "no-store", signal },
        );
        if (response.ok) {
          const payload = (await response.json()) as PollResponse;
          cursor = payload.cursor;
          latestConfig = normalizeConfig(payload.config);
          rememberSoundVersions(payload.soundVersions);
          for (const event of payload.events) storm.push(event.notification);
        }
      }
    } catch (error) {
      if (!signal.aborted) console.warn("[plugin:chime-local] event poll failed", error);
    } finally {
      if (!signal.aborted) timer = setTimeout(() => void poll(), POLL_MS);
    }
  };

  const attemptAudioActivation = () => {
    if (audioActivationStatus() === "active") return;
    const audio = new Audio(soundUrl(pluginId, "soft-rise"));
    audio.volume = 0;
    void audio
      .play()
      .then(() => localStorage.setItem(AUDIO_STATUS_KEY, "active"))
      .catch(() => localStorage.setItem(AUDIO_STATUS_KEY, "blocked"));
  };
  document.addEventListener("pointerdown", attemptAudioActivation, { once: true, signal });
  document.addEventListener("keydown", attemptAudioActivation, { once: true, signal });
  void poll();

  return () => {
    if (timer) clearTimeout(timer);
    storm.dispose();
    for (const highlight of highlights.values()) highlight.cancel();
    highlights.clear();
    const lease = readLease();
    if (lease?.owner === clientId) localStorage.removeItem(LEASE_KEY);
  };
}
