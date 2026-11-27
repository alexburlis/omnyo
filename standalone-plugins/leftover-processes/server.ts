import { createUsageReader } from "./usage";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { CLI_COMMANDS, runCli } from "./cli";
import { hostContract, rpcContract } from "./contract";
import { createCuaService } from "./cua-service";
import { CUA_CLI_COMMANDS, runCuaCli } from "./cua-cli";
import { hasOpenWork, threadStateOf } from "./policy";
import { CHANGED_CHANNEL } from "./lib/names";
import { createStore } from "./store";
import { createSweeper } from "./sweeper";

const HISTORY_DEFAULT = 50;

export default function plugin(api: PluginApi) {
  const settings = api.settings.define({
    autoStop: {
      type: "boolean",
      label: "Stop leftovers automatically",
      description: "When off, sweeps still report what chats left running and stop nothing.",
      default: true,
    },
    idleHours: {
      type: "number",
      label: "Hours a chat stays idle before its leftovers stop",
      default: 24,
      experimental_schema: z.number().min(1).max(720),
    },
  });

  const lifetime = new AbortController();

  api.onDispose(() => lifetime.abort());

  const store = createStore(api.storage);
  const host = api.hosts.experimental_client({ contract: hostContract });

  const usage = createUsageReader({
    hosts: () => api.sdk.hosts.list({ signal: lifetime.signal }),
    read: (hostId) =>
      host.call("usage", {}, { hostId, signal: lifetime.signal, timeoutMs: 10_000 }),
  });

  const cua = createCuaService({
    store: store.cua,
    host: {
      inspect: (hostId, config) =>
        host.call("cuaInspect", { config }, { hostId, signal: lifetime.signal, timeoutMs: 30_000 }),
      stop: (hostId, input) =>
        host.call("cuaStop", input, { hostId, signal: lifetime.signal, timeoutMs: 60_000 }),
      reconcile: (hostId, vm) =>
        host.call("cuaReconcile", { vm }, { hostId, signal: lifetime.signal, timeoutMs: 10_000 }),
    },
    ownerStatus: async (threadId) => {
      try {
        const thread = await api.sdk.threads.get({ threadId, signal: lifetime.signal });

        if (threadStateOf(thread).kind === "running") return "active";
        const work = await api.sdk.threads.experimental_work({ threadId, signal: lifetime.signal });

        return hasOpenWork(work) ? "active" : "finished";
      } catch (error) {
        lifetime.signal.throwIfAborted();

        return z.object({ code: z.literal("thread_not_found") }).safeParse(error).success
          ? "finished"
          : "unknown";
      }
    },
  });

  const sweeper = createSweeper(api, store, () => settings.get(), lifetime.signal);

  async function changed<T>(work: () => Promise<T>): Promise<T> {
    const result = await work();
    api.realtime.publish(CHANGED_CHANNEL, { at: Date.now() });

    return result;
  }

  const cuaCommands = {
    ...cua,
    register: (input: Parameters<typeof cua.register>[0]) => changed(() => cua.register(input)),
    acquire: (input: Parameters<typeof cua.acquire>[0]) => changed(() => cua.acquire(input)),
    release: (input: Parameters<typeof cua.release>[0]) => changed(() => cua.release(input)),
    keep: (input: Parameters<typeof cua.keep>[0]) => changed(() => cua.keep(input)),
    reconcile: (input: Parameters<typeof cua.reconcile>[0]) => changed(() => cua.reconcile(input)),
  };

  async function listAll(input: NonNullable<Parameters<typeof sweeper.list>[0]> = {}) {
    const [processes, resources] = await Promise.all([
      sweeper.list(input),
      cua.list({ hostId: input.hostId }),
    ]);

    return {
      ...processes,
      cuaResources: resources.resources.filter(
        (resource) =>
          input.threadId === undefined ||
          resource.ownerThreadId === input.threadId ||
          resource.consumers.some((consumer) => consumer.ownerThreadId === input.threadId),
      ),
    };
  }

  api.onDispose(async () => {
    lifetime.abort();
    await cua.settled();
  });

  api.rpc.register(rpcContract, {
    list: listAll,
    usage,
    cuaRegister: cuaCommands.register,
    cuaAcquire: cuaCommands.acquire,
    cuaRelease: cuaCommands.release,
    cuaKeep: cuaCommands.keep,
    cuaReconcile: cuaCommands.reconcile,
    cuaList: (input) => cua.list(input),
    cuaObserve: (input) => cua.observe(input),
    stop: ({ hostId, identities }) => sweeper.stop(hostId, identities),
    keep: ({ hostId, identity }) => sweeper.keep(hostId, identity),
    unkeep: ({ hostId, identity }) => sweeper.unkeep(hostId, identity),
    sweep: (input) => sweeper.sweep(input),
    history: ({ limit }) => ({ entries: sweeper.history(limit ?? HISTORY_DEFAULT) }),
  });

  api.cli.register({
    name: "leftover-processes",
    summary: "Measure chat CPU and memory, and manage leftover processes",
    commands: [...CLI_COMMANDS, ...CUA_CLI_COMMANDS],
    run: (argv, context) =>
      argv[0] === "cua"
        ? runCuaCli(cuaCommands, argv.slice(1), {
            threadId: context.threadId ?? null,
            defaultHostId: null,
          })
        : runCli({ ...sweeper, list: listAll, usage }, argv),
  });

  api.background.schedule("sweep", "*/5 * * * *", async () => {
    await sweeper.sweepOnSchedule();
    const { autoStop } = await settings.get();
    await changed(() => cua.sweep({ allowStop: autoStop }));
  });

  api.log.info("leftover-processes loaded");
}
