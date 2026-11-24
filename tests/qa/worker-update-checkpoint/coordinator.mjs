import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { createTestAppHarness } from "../../../apps/server/test/helpers/test-app.ts";
import { minimalProviderRegistration } from "../../../apps/server/test/helpers/provider-registry.ts";
import { createApp } from "../../../apps/server/src/server.ts";
import { listBundledPluginRegistrations } from "../../../apps/server/src/services/plugins/builtin-registry.ts";
import { appendClientTurnEvent } from "../../../apps/server/src/services/threads/thread-events.ts";
import {
  createEnvironment,
  createProject,
  createThread,
  getHost,
  getLatestSessionForHost,
  listPendingInteractionsByThread,
  upsertHost,
} from "../../../packages/db/src/index.ts";
import { HOST_DAEMON_PROTOCOL_VERSION } from "../../../packages/host-daemon-contract/src/index.ts";

const config = JSON.parse(
  await readFile(process.env.OMNYO_CHECKPOINT_SMOKE_CONFIG, "utf8"),
);

const resolveFixtureModule = createRequire(import.meta.url);

function reportStartup(stage, sqliteVersion = null) {
  console.log(
    JSON.stringify({
      stage,
      pid: process.pid,
      node: process.version,
      sqliteModule: resolveFixtureModule.resolve("better-sqlite3"),
      sqliteVersion,
      nativeImages: process.report
        .getReport()
        .sharedObjects.filter((path) => path.endsWith(".node")),
    }),
  );
}

reportStartup("before-harness");

assert.equal(
  resolveFixtureModule.resolve("better-sqlite3"),
  config.nativeBindings["better-sqlite3"],
  "Static and background-checkpoint SQLite bindings must match",
);

const harness = await createTestAppHarness({
  databaseSource: config.database,
  seedFirstPartyProviders: false,
});

reportStartup(
  "harness-ready",
  harness.db.$client.prepare("SELECT sqlite_version() AS version").get()
    .version,
);

harness.deps.providerRegistry.register(
  minimalProviderRegistration({
    pluginId: "provider-scripted-checkpoint",
    info: {
      id: "checkpoint",
      pluginId: "provider-scripted-checkpoint",
      displayName: "Synthetic checkpoint bridge",
      logoUrl: null,
      maintenance: { health: false, usage: false, installation: false },
      capabilities: {
        supportsThreadArchive: true,
        supportsThreadRename: true,
        supportsServiceTier: false,
        supportsNativeUserQuestion: true,
        supportsFork: true,
        supportsSessionRewind: true,
        permissionModes: ["full"],
        modelCatalogScope: "workspace",
      },
      composerActions: [],
      completedTurnDisplay: "collapse",
      available: true,
    },
    serverCapabilities: {
      reasoningLevels: ["medium"],
      fork: "checkpoint",
      supportsManualCompaction: false,
    },
  }),
);

let entities;

if (HOST_DAEMON_PROTOCOL_VERSION === config.oldProtocol) {
  upsertHost(harness.db, harness.hub, {
    id: config.hostId,
    name: "Checkpoint smoke",
  });

  const { project } = createProject(harness.db, harness.hub, {
    name: "Checkpoint smoke",
    source: {
      type: "local_path",
      hostId: config.hostId,
      path: config.workspace,
    },
  });

  const environment = createEnvironment(harness.db, harness.hub, {
    providerOwnsPath: false,
    projectId: project.id,
    hostId: config.hostId,
    path: config.workspace,
    status: "ready",
    isGitRepo: false,
  });

  const thread = createThread(harness.db, harness.hub, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "checkpoint",
    title: "Checkpoint smoke",
    status: "idle",
  });

  const request = appendClientTurnEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    type: "client/turn/requested",
    input: [{ type: "text", text: "ask_user" }],
    target: { kind: "new-turn" },
    execution: {
      model: "fixture",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    initiator: "user",
    senderThreadId: null,
    requestMethod: "turn/start",
    source: "tell",
  });

  entities = {
    projectId: project.id,
    environmentId: environment.id,
    threadId: thread.id,
    clientRequestId: request.requestId,
  };
  await writeFile(config.entitiesFile, JSON.stringify(entities));
} else {
  entities = JSON.parse(await readFile(config.entitiesFile, "utf8"));
}

const active = createApp(harness.deps);

let startupHoldActive = true;

try {
  await active.pluginService.start({
    hold: {
      sources: listBundledPluginRegistrations().map(
        (plugin) => `builtin:${plugin.name}`,
      ),
      detail: "Builtin services are not started by the server test fixture",
      isActive: async () => startupHoldActive,
    },
  });
} finally {
  startupHoldActive = false;
}

reportStartup("app-ready");

let rejectedOldProtocol = 0;

let lostEventAck = false;

const sessionOpens = [];

let interruptionPosts = 0;

const eventFailures = [];

const isNext = HOST_DAEMON_PROTOCOL_VERSION !== config.oldProtocol;

const target = isNext ? config.next : config.old;

const server = serve({
  hostname: "127.0.0.1",
  port: config.serverPort,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;

    if (path === "/install/version")
      return Response.json({
        protocolVersion: target.protocol,
        version: target.version,
        artifactDigest: target.digest,
      });

    if (path === "/install/omnyo-app.tgz")
      return new Response(await readFile(target.tarball), {
        headers: { "x-omnyo-artifact-sha256": target.digest },
      });

    if (path === "/fixture/status") {
      const rows = harness.db.$client
        .prepare(
          "SELECT sequence,type,data FROM events WHERE thread_id = ? ORDER BY sequence",
        )
        .all(entities.threadId);

      return Response.json({
        protocol: HOST_DAEMON_PROTOCOL_VERSION,
        host: getHost(harness.db, config.hostId),
        session: getLatestSessionForHost(harness.db, { hostId: config.hostId }),
        pending: listPendingInteractionsByThread(harness.db, {
          threadId: entities.threadId,
        }).map((row) => ({ id: row.id, status: row.status })),
        output: rows
          .filter(
            (row) =>
              row.type === "item/agentMessage/delta" &&
              row.data.includes(config.outputMarker),
          )
          .map((row) => ({ sequence: row.sequence })),
        terminals: rows
          .filter((row) => row.type === "turn/completed")
          .map((row) => ({ sequence: row.sequence })),
        rejectedOldProtocol,
        lostEventAck,
        sessionOpens,
        interruptionPosts,
        eventFailures,
        inputAcceptedCount: rows.filter(
          (row) =>
            row.type === "turn/input/accepted" &&
            JSON.parse(row.data).clientRequestId === entities.clientRequestId,
        ).length,
        entities,
      });
    }

    let body;

    if (path === "/internal/session/open") {
      body = await request.clone().json();
      sessionOpens.push({
        instanceId: body.instanceId,
        protocolVersion: body.protocolVersion,
        undeliveredEventThreadIds: body.undeliveredEventThreadIds,
      });
    }

    if (path === "/internal/session/interactive-request/interrupt")
      interruptionPosts += 1;
    const response = await active.app.fetch(request);

    if (path === "/internal/session/events" && !response.ok) {
      const encoding = response.headers.get("content-encoding");
      const copy = response.clone();
      void copy
        .arrayBuffer()
        .then((bytes) => {
          assert.ok(encoding === null || encoding === "gzip");

          const body = JSON.parse(
            (encoding === "gzip"
              ? gunzipSync(Buffer.from(bytes))
              : Buffer.from(bytes)
            ).toString("utf8"),
          );

          const failure = {
            status: response.status,
            code: body.code,
            message: String(body.message).slice(0, 500),
          };

          eventFailures.push(failure);
          console.log(JSON.stringify({ stage: "event-failure", ...failure }));
        })
        .catch((error) => {
          eventFailures.push({
            status: response.status,
            diagnostic: error.name,
          });
        });
    }

    if (path === "/internal/session/open") {
      Object.assign(sessionOpens.at(-1), {
        responseStatus: response.status,
        contentEncoding: response.headers.get("content-encoding"),
      });
      console.log(
        JSON.stringify({ stage: "session-response", ...sessionOpens.at(-1) }),
      );
    }

    if (
      path === "/internal/session/open" &&
      body.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION &&
      response.status === 400
    )
      rejectedOldProtocol += 1;

    if (
      isNext &&
      path === "/internal/session/events" &&
      response.ok &&
      !lostEventAck
    ) {
      lostEventAck = true;
      await response.arrayBuffer();

      return Response.json(
        {
          message: "Fixture dropped the post-commit acknowledgment",
          code: "fixture_lost_ack",
          retryable: true,
        },
        { status: 503 },
      );
    }

    return response;
  },
});

active.injectWebSocket(server);

await writeFile(
  config.coordinatorReady,
  JSON.stringify({ pid: process.pid, protocol: HOST_DAEMON_PROTOCOL_VERSION }),
);

await appendFile(
  config.coordinatorStarts,
  JSON.stringify({ pid: process.pid, protocol: HOST_DAEMON_PROTOCOL_VERSION }) +
    "\n",
);

async function stop() {
  await active.closeWebSockets();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await active.pluginService.stop();
  await harness.cleanup();
  harness.db.$client.close();
  process.exit(0);
}

process.once("SIGTERM", () => {
  void stop().catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
