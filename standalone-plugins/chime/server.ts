import { createHash } from "node:crypto";
import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  EVENT_KINDS,
  SOUND_IDS,
  chooseStormNotification,
  normalizeConfig,
  type ChimeConfig,
  type ChimeNotification,
  type EventKind,
} from "./domain";
import { EventBroker, classifyIdleEvent, classifyPendingInteraction } from "./event-broker";
import { ClientPresence } from "./client-presence";
import { isServerPlaybackAvailable, playServerSound, readSoundAsset } from "./server-audio";
import { StormBuffer } from "./storm-buffer";

const callbackThreadsSchema = z.object({ waits: z.array(z.object({ threadId: z.string() })) });
const workerOwnersSchema = z.object({ ownerThreadIds: z.array(z.string()) });
const decisionThreadsSchema = z.object({
  threads: z.array(z.object({ threadId: z.string(), count: z.number() })),
});

const QUESTION_FRESH_MS = 60_000;

const eventKindSchema = z.enum(EVENT_KINDS);
const soundIdSchema = z.enum(SOUND_IDS);
const configSchema = z.object({
  enabled: z.boolean(),
  volume: z.number().min(0).max(1),
  deliveryMode: z.enum(["client", "server"]),
  muteVisibleThread: z.boolean(),
  mutedProjectIds: z.array(z.string()),
  eventEnabled: z.record(eventKindSchema, z.boolean()),
  eventSounds: z.record(eventKindSchema, soundIdSchema),
});
export const rpcContract = defineRpcContract({
  getConfig: {
    input: z.null(),
    output: z.object({
      config: configSchema,
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
      serverPlaybackAvailable: z.boolean(),
    }),
  },
  updateConfig: {
    input: configSchema,
    output: z.object({ config: configSchema }),
  },
  previewServer: {
    input: z.object({ soundId: soundIdSchema }),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
});

async function loadConfig(api: PluginApi): Promise<ChimeConfig> {
  return normalizeConfig(await api.storage.kv.get<Partial<ChimeConfig>>("config"));
}

export default async function plugin(api: PluginApi) {
  const broker = new EventBroker();
  let disposed = false;
  const publishedCompletions = new Map<string, number>();
  const awaitingCompletion = new Set<string>();
  const seenInteractionsByThread = new Map<string, Set<string>>();
  const scanningThreads = new Set<string>();
  const pendingRescans = new Set<string>();
  const clientPresence = new ClientPresence();
  const serverPlaybackAvailable = isServerPlaybackAvailable();
  const serverStorm = new StormBuffer<{ notification: ChimeNotification; config: ChimeConfig }>(
    1_000,
    (entries) => {
      const chosen = chooseStormNotification(entries.map(({ notification }) => notification));
      return chosen ? (entries.find(({ notification }) => notification === chosen) ?? null) : null;
    },
    ({ notification, config }) =>
      void (async () => {
        if (notification.kind === "completed" && !(await isCompletionCurrent(notification))) return;
        if (disposed) return;
        await playServerSound(config.eventSounds[notification.kind], config.volume);
      })().catch((error: unknown) => {
        if (disposed) return;
        api.log.warn(
          `server playback failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
  );

  async function publishChimeNotification(
    kind: EventKind,
    thread: { id: string; projectId: string; visibility: "visible" | "hidden" },
    interactionId?: string,
    turnSeq?: number,
  ): Promise<void> {
    if (thread.visibility === "hidden") return;
    const config = await loadConfig(api);
    if (
      !config.enabled ||
      !config.eventEnabled[kind] ||
      config.mutedProjectIds.includes(thread.projectId)
    ) {
      return;
    }
    if (kind === "completed" && turnSeq !== undefined) {
      if (publishedCompletions.get(thread.id) === turnSeq) return;
      publishedCompletions.set(thread.id, turnSeq);
    }
    const queued = broker.publish({
      kind,
      threadId: thread.id,
      projectId: thread.projectId,
      interactionId,
      turnSeq,
    });
    if (config.deliveryMode === "server" && serverPlaybackAvailable) {
      if (config.muteVisibleThread && clientPresence.isVisible(thread.id)) return;
      serverStorm.push({ notification: queued.notification, config });
    }
  }

  function latestTurnEvents(threadId: string) {
    return api.sdk.threads.events.list({
      threadId,
      limit: "1",
      order: "desc",
      types: ["turn/started", "turn/completed", "system/thread/interrupted"],
    });
  }

  async function sidebarAllowsCompletion(threadId: string): Promise<boolean> {
    const sidebar = await api.sdk.projects.sidebarBootstrap();
    const row = [
      ...sidebar.personalProject.threads,
      ...sidebar.projects.flatMap((project) => project.threads),
    ].find((thread) => thread.id === threadId);
    if (
      !row ||
      row.status !== "idle" ||
      row.runtime.displayStatus !== "idle" ||
      row.queuedWork !== "none" ||
      row.hasPendingInteraction ||
      row.latestAttentionAt <= (row.lastReadAt ?? 0) ||
      Object.values(row.activity).some((count) => count !== 0)
    )
      return false;

    // Read the same plugin-owned wait/worker/decision projections as the green rail.
    // An unavailable projection must never turn into a successful completion.
    const { plugins } = await api.sdk.plugins.list();
    const needsYou = plugins.find((candidate) => candidate.id === "needs-you" && candidate.enabled);
    if (!needsYou) return true;
    if (needsYou.status !== "running") return false;
    const [settings, callbacks, workers] = await Promise.all([
      api.sdk.plugins.getSettings({ pluginId: "needs-you" }),
      api.sdk.plugins.callRpc({
        pluginId: "needs-you",
        method: "callbacks.list",
        input: null,
        outputSchema: callbackThreadsSchema,
      }),
      api.sdk.plugins.callRpc({
        pluginId: "needs-you",
        method: "worker-activity.list",
        input: null,
        outputSchema: workerOwnersSchema,
      }),
    ]);
    if (
      settings.values.unreadSuccess !== true ||
      callbacks.waits.some((wait) => wait.threadId === threadId) ||
      workers.ownerThreadIds.includes(threadId)
    )
      return false;
    const decisions = plugins.find(
      (candidate) => candidate.id === "decisions" && candidate.enabled,
    );
    if (!decisions) return true;
    if (decisions.status !== "running") return false;
    const index = await api.sdk.plugins.callRpc({
      pluginId: "decisions",
      method: "open_index",
      input: null,
      outputSchema: decisionThreadsSchema,
    });
    return !index.threads.some((thread) => thread.threadId === threadId && thread.count > 0);
  }

  async function completionTurn(threadId: string): Promise<number | null> {
    const current = await api.sdk.threads.get({ threadId });
    if (
      current.visibility === "hidden" ||
      current.archivedAt !== null ||
      current.deletedAt !== null ||
      current.status !== "idle" ||
      current.runtime.displayStatus !== "idle" ||
      current.queuedMessageCount > 0 ||
      current.activeBackgroundAgentCount > 0
    )
      return null;
    const [events, goals, interactions] = await Promise.all([
      latestTurnEvents(threadId),
      api.sdk.threads.events.list({
        threadId,
        limit: "1",
        order: "desc",
        types: ["thread/goal/updated", "thread/goal/cleared"],
      }),
      api.sdk.threads.interactions.list({ threadId }),
    ]);
    if (classifyIdleEvent(events) !== "completed") return null;
    const goal = goals[0];
    if (goal?.type === "thread/goal/updated" && goal.data.status !== "complete") return null;
    if (interactions.some((interaction) => classifyPendingInteraction(interaction) !== null))
      return null;
    if (!(await sidebarAllowsCompletion(threadId))) return null;
    return [...events].sort((left, right) => right.seq - left.seq)[0]?.seq ?? null;
  }

  async function isCompletionCurrent(notification: ChimeNotification): Promise<boolean> {
    return (
      notification.turnSeq !== undefined &&
      (await completionTurn(notification.threadId)) === notification.turnSeq
    );
  }

  async function scanPendingInteractions(threadId: string): Promise<void> {
    if (scanningThreads.has(threadId)) {
      pendingRescans.add(threadId);
      return;
    }
    scanningThreads.add(threadId);
    try {
      do {
        pendingRescans.delete(threadId);
        const [interactions, thread, attention] = await Promise.all([
          api.sdk.threads.interactions.list({ threadId }),
          api.sdk.threads.get({ threadId }),
          api.sdk.experimental_attention.history({ threadId }),
        ]);
        const previouslySeen = seenInteractionsByThread.get(threadId) ?? new Set<string>();
        const pendingIds = new Set<string>();
        for (const interaction of interactions) {
          const kind = classifyPendingInteraction(interaction);
          if (!kind) continue;
          pendingIds.add(interaction.id);
          if (!previouslySeen.has(interaction.id)) {
            await publishChimeNotification(kind, thread, interaction.id);
          }
        }
        for (const question of attention.questions) {
          const id = `question:${question.id}`;
          if (question.state !== "open" || pendingIds.has(id)) continue;
          pendingIds.add(id);
          if (!previouslySeen.has(id) && Date.now() - question.createdAt <= QUESTION_FRESH_MS) {
            await publishChimeNotification("question", thread, id);
          }
        }
        if (pendingIds.size > 0) seenInteractionsByThread.set(threadId, pendingIds);
        else seenInteractionsByThread.delete(threadId);
      } while (pendingRescans.has(threadId));
    } finally {
      scanningThreads.delete(threadId);
    }
  }

  async function publishCompletion(threadId: string): Promise<void> {
    const turnSeq = await completionTurn(threadId);
    if (turnSeq === null || disposed) return;
    const thread = await api.sdk.threads.get({ threadId });
    await publishChimeNotification("completed", thread, undefined, turnSeq);
    awaitingCompletion.delete(threadId);
  }

  function recheckCompletion(threadId: string): void {
    if (!awaitingCompletion.has(threadId)) return;
    void publishCompletion(threadId).catch((error: unknown) => {
      if (!disposed)
        api.log.warn(
          `completion verification failed; no sound: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
  }

  api.events.on("thread.active", ({ thread }) => {
    awaitingCompletion.delete(thread.id);
    return publishChimeNotification("started", thread);
  });
  api.events.on("thread.idle", async ({ thread }) => {
    if (thread.visibility === "hidden") {
      if (thread.lifecycleOwnerThreadId) recheckCompletion(thread.lifecycleOwnerThreadId);
      return;
    }
    try {
      const events = await latestTurnEvents(thread.id);
      const kind = classifyIdleEvent(events);
      if (kind === "cancelled") await publishChimeNotification(kind, thread);
      if (kind === "completed") {
        awaitingCompletion.add(thread.id);
        await publishCompletion(thread.id);
      }
    } catch (error) {
      api.log.warn(
        `completion verification failed; no sound: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  api.events.on("thread.failed", ({ thread }) => publishChimeNotification("failed", thread));
  api.events.on("thread.archived", ({ thread }) => {
    seenInteractionsByThread.delete(thread.id);
    publishedCompletions.delete(thread.id);
    awaitingCompletion.delete(thread.id);
  });
  api.events.on("thread.deleted", ({ thread }) => {
    seenInteractionsByThread.delete(thread.id);
    publishedCompletions.delete(thread.id);
    awaitingCompletion.delete(thread.id);
  });

  const unsubscribe = api.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      if (!event.id) return;
      if (
        event.metadata?.backgroundActivityChanged ||
        event.changes.some((change) =>
          ["status-changed", "queue-changed", "interactions-changed", "events-appended"].includes(
            change,
          ),
        )
      )
        recheckCompletion(event.id);
      if (!event.changes.includes("interactions-changed")) return;
      void scanPendingInteractions(event.id).catch((error: unknown) => {
        api.log.warn(
          `interaction scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  });
  api.onDispose(unsubscribe);
  api.onDispose(() => {
    disposed = true;
    serverStorm.dispose();
  });

  api.rpc.register(rpcContract, {
    async getConfig() {
      const projects = await api.sdk.projects.list({ includePersonal: true });
      return {
        config: await loadConfig(api),
        projects: projects.map(({ id, name }) => ({ id, name })),
        serverPlaybackAvailable,
      };
    },
    async updateConfig(input) {
      const config = normalizeConfig(input);
      await api.storage.kv.set("config", config);
      return { config };
    },
    async previewServer({ soundId }) {
      if (!serverPlaybackAvailable)
        return { ok: false, error: "Server playback requires macOS and /usr/bin/afplay." };
      const config = await loadConfig(api);
      try {
        await playServerSound(soundId, config.volume);
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  const soundVersions = Object.fromEntries(
    SOUND_IDS.map((soundId) => [
      soundId,
      createHash("sha256").update(readSoundAsset(soundId)).digest("hex").slice(0, 16),
    ]),
  );

  api.http.route("GET", "/events", async (context) => {
    const afterText = context.req.query("after") ?? "0";
    const after = /^\d+$/.test(afterText) ? Number(afterText) : 0;
    const result = broker.after(after);
    return context.json({ ...result, config: await loadConfig(api), soundVersions });
  });

  api.http.route("GET", "/completion", async (context) => {
    const threadId = context.req.query("threadId");
    const turnSeqText = context.req.query("turnSeq") ?? "";
    if (!threadId || !/^\d+$/.test(turnSeqText)) return context.json({ play: false }, 400);
    const turnSeq = Number(turnSeqText);
    if (!Number.isSafeInteger(turnSeq)) return context.json({ play: false }, 400);
    return context.json({ play: (await completionTurn(threadId)) === turnSeq });
  });

  api.http.route("GET", "/presence", (context) => {
    const clientId = context.req.query("client");
    if (clientId) clientPresence.update(clientId, context.req.query("visibleThread") || null);
    return new Response(null, { status: 204 });
  });

  for (const soundId of SOUND_IDS) {
    api.http.route(
      "GET",
      `/sound-${soundId}`,
      () =>
        new Response(new Uint8Array(readSoundAsset(soundId)), {
          headers: {
            "content-type": "audio/wav",
            "cache-control": "public, max-age=31536000, immutable",
          },
        }),
    );
  }

  api.log.info(`loaded; server playback ${serverPlaybackAvailable ? "available" : "unavailable"}`);
}
