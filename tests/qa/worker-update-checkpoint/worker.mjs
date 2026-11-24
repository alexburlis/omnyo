import { appendFile, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHostDaemonApp } from "../../../apps/host-daemon/src/app.ts";
import { createAgentRuntime } from "../../../packages/agent-runtime/src/runtime.ts";
import { turnScope } from "../../../packages/domain/src/index.ts";
import { HOST_DAEMON_PROTOCOL_VERSION } from "../../../packages/host-daemon-contract/src/index.ts";

const config = JSON.parse(
  await readFile(process.env.OMNYO_CHECKPOINT_SMOKE_CONFIG, "utf8"),
);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const { version } = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);

const instanceId = randomUUID();

const logger = {
  debug() {},
  info() {},
  warn() {},
  error(...args) {
    console.error(...args);
  },
};

let latestTurn = null;

let runtime = null;

await appendFile(
  join(config.dataDir, "worker-starts.jsonl"),
  JSON.stringify({
    pid: process.pid,
    instanceId,
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    version,
  }) + "\n",
);

const app = await createHostDaemonApp({
  dataDir: config.dataDir,
  serverUrl: config.serverUrl,
  hostKey: config.hostKey,
  hostId: config.hostId,
  hostName: "Checkpoint smoke",
  instanceId,
  logger,
  autoUpdate: true,
  supervised: true,
  releaseLock: async () => undefined,
  localApiConfig: {
    bindHost: "127.0.0.1",
    healthPath: "/health",
    healthValue: "ok",
    port: config.daemonPort,
  },
  bridgeBundleDir: join(packageRoot, "host-daemon/dist"),
  runtimeShellEnv: { PATH: process.env.PATH, HOME: config.home },
  createRuntime: (options) => {
    runtime = createAgentRuntime({
      ...options,
      onEvent: (event) => {
        if (event.type === "turn/started") latestTurn = event;

        options.onEvent(event);
      },
    });

    return runtime;
  },
  exitProcess: (code) => process.exit(code),
});

await app.daemon.start();

if (version === config.oldVersion) {
  const deadline = Date.now() + 20_000;
  let entities;

  while (Date.now() < deadline) {
    const status = await fetch(
      `http://127.0.0.1:${config.daemonPort}/status`,
    ).then((r) => r.json());

    if (status.connected) {
      entities = JSON.parse(await readFile(config.entitiesFile, "utf8"));
      break;
    }

    await delay(25);
  }

  if (!entities)
    throw new Error("Old worker did not connect before provider setup");

  const entry = await app.runtimeManager.ensureEnvironment({
    environmentId: entities.environmentId,
    workspacePath: config.workspace,
  });

  const artifactPath = join(
    packageRoot,
    "host-daemon/dist/scripted-echo-provider.mjs",
  );

  const bridgeLaunch = {
    pluginId: "provider-scripted-checkpoint",
    dataDir: join(config.dataDir, "scripted-provider"),
    source: {
      kind: "artifact",
      artifactPath,
      digest: createHash("sha256")
        .update(await readFile(artifactPath))
        .digest("hex"),
    },
    capabilities: {
      providerInstallation: false,
      supportsServiceTier: false,
      permissionModes: ["full"],
      supportsThreadArchive: true,
      supportsThreadRename: true,
      fork: "checkpoint",
    },
    providerOptions: { scripted: { identifyProcess: true } },
    envPassthrough: ["SCRIPTED_ECHO_PROCESS_LOG_PATH"],
  };

  const options = {
    model: "fixture",
    serviceTier: "default",
    reasoningLevel: "medium",
    providerOptions: {},
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  };

  await entry.runtime.startThread({
    bridgeLaunch,
    environmentId: entities.environmentId,
    threadId: entities.threadId,
    projectId: entities.projectId,
    providerId: "checkpoint",
    options,
  });
  await entry.runtime.runTurn({
    threadId: entities.threadId,
    clientRequestId: entities.clientRequestId,
    input: [{ type: "text", text: "ask_user" }],
    options,
  });

  while (Date.now() < deadline + 30_000) {
    try {
      await readFile(config.emitSignal);

      if (!latestTurn || !runtime)
        throw new Error("No actual turn was started");
      app.eventSink.emit({
        threadId: entities.threadId,
        event: {
          type: "item/agentMessage/delta",
          threadId: entities.threadId,
          providerThreadId: latestTurn.providerThreadId,
          itemId: "checkpoint-output",
          delta: config.outputMarker,
          scope: turnScope(latestTurn.scope.turnId),
        },
      });
      await writeFile(
        config.emittedSignal,
        JSON.stringify({
          threadId: entities.threadId,
          turnId: latestTurn.scope.turnId,
        }),
      );
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await delay(25);
  }
}

await app.daemon.waitUntilStopped();
