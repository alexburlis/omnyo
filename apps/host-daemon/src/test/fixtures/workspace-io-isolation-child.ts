import {
  constants,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentRuntimeBridgeLaunch, AgentRuntime } from "@omnyo/agent-runtime";
import type { HostDaemonOnlineRpcResponseMessage } from "@omnyo/host-daemon-contract";
import { createHostDaemonApp } from "../../app.js";

const { root, fifo, marker, armed, providerArtifact } = z
  .object({
    root: z.string().min(1),
    fifo: z.string().min(1),
    marker: z.string().min(1),
    armed: z.string().min(1),
    providerArtifact: z.string().min(1),
  })
  .parse({
    root: process.env.WORKSPACE_IO_FAULT_ROOT,
    fifo: process.env.WORKSPACE_IO_FAULT_FIFO,
    marker: process.env.WORKSPACE_IO_FAULT_MARKER,
    armed: process.env.WORKSPACE_IO_FAULT_ARMED,
    providerArtifact: process.argv[2],
  });

const scenario = z
  .enum(["watch", "paths-exist", "write-file"])
  .parse(process.argv[3]);

const fullRuntimeOptions = {
  model: "test-model",
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} satisfies Parameters<AgentRuntime["startThread"]>[0]["options"];

let shutdownApp: (() => Promise<void>) | undefined;

let emergencyCleanupStarted = false;

function releaseFaultAndExit(): void {
  if (emergencyCleanupStarted) return;
  emergencyCleanupStarted = true;
  const writer = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);

  const exit = () => {
    closeSync(writer);
    process.exit(1);
  };

  setTimeout(exit, 500);
  void (shutdownApp?.() ?? Promise.resolve()).then(exit, exit);
}

process.once("disconnect", releaseFaultAndExit);

const watchdog = setTimeout(releaseFaultAndExit, 8_000);

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function until(check: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const poll = () => {
      if (check()) {
        resolve();

        return;
      }

      setTimeout(poll, 5).unref();
    };

    poll();
  });
}

const base = path.dirname(root);

const internal = path.join(base, "internal");

const dataDir = path.join(base, "daemon-data");

await fs.mkdir(internal, { recursive: true });

await fs.mkdir(root, { recursive: true });

const externalPaths = [root, `${root}-1`, `${root}-2`, `${root}-3`];

await Promise.all(
  externalPaths.map((target) => fs.mkdir(target, { recursive: true })),
);

const noop = () => undefined;

function createApp(instanceId: string) {
  return createHostDaemonApp({
    bridgeBundleDir: path.dirname(providerArtifact),
    dataDir,
    hostId: "host-workspace-io-fixture",
    hostName: "Workspace I/O fixture",
    hostKey: "fixture-host-key",
    instanceId,
    serverUrl: "http://127.0.0.1:49161",
    localApiConfig: null,
    releaseLock: async () => undefined,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    exitProcess: noop,
    runtimeShellEnv: { PATH: process.env.PATH ?? "" },
  });
}

const app = await createApp("workspace-io-fixture");

let successor: Awaited<ReturnType<typeof createApp>> | undefined;

shutdownApp = async () => {
  await app.daemon.shutdown("workspace-io-fixture", 0);
  await successor?.daemon.shutdown("workspace-io-successor", 0);
};

let blockedOperation: Promise<unknown> | undefined;

let admittedWrites: Promise<HostDaemonOnlineRpcResponseMessage>[] = [];

let firstTargetExpectedSha256: string | null = null;

let drainingMutationPid: number | undefined;

let successorWrite: Promise<HostDaemonOnlineRpcResponseMessage> | undefined;

let fixtureFailed = false;

function reportFailure(error: unknown): void {
  fixtureFailed = true;

  if (process.connected) {
    process.send?.(
      {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      },
      () => undefined,
    );
  }
}

function requireWriteResult(response: HostDaemonOnlineRpcResponseMessage) {
  if (!response.ok || response.commandType !== "host.write_file") {
    throw new Error("The mutation RPC did not return a file write result");
  }

  return response.result;
}

async function verifyMutationSerialization(): Promise<void> {
  const target = path.join(root, "fixture-output.txt");

  const first = requireWriteResult(
    await app.router.handleOnlineRpcRequest({
      type: "host-rpc.request",
      requestId: "guarded-cas-initial",
      command: {
        type: "host.write_file",
        path: target,
        content: "cas-initial",
        contentEncoding: "utf8",
        createParents: false,
        expectedSha256: null,
      },
    }),
  );

  if (first.outcome !== "written") {
    throw new Error("The initial synthetic CAS target was not written");
  }

  const alias = path.join(internal, "fixture-output-alias.txt");
  await fs.symlink(target, alias);

  const competitors = await Promise.all(
    [target, alias].map((targetPath, index) =>
      app.router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: `guarded-cas-${index}`,
        command: {
          type: "host.write_file",
          path: targetPath,
          content: `cas-competitor-${index}`,
          contentEncoding: "utf8",
          createParents: false,
          expectedSha256: first.sha256,
        },
      }),
    ),
  );

  const results = competitors.map(requireWriteResult);
  const outcomes = results.map((result) => result.outcome).sort();

  if (outcomes.join(",") !== "conflict,written") {
    throw new Error(
      "Concurrent writes across IPC did not preserve the canonical target CAS guard",
    );
  }

  for (const result of results) {
    if (result.outcome === "written") firstTargetExpectedSha256 = result.sha256;
  }

  if (process.connected)
    process.send?.({ kind: "cas-preserved" }, () => undefined);
}

function requireBlockedFilesystem(): number {
  const fault = z
    .object({
      pid: z.number().int().positive(),
      operation: z.string(),
      blockedCount: z.number().int().positive(),
    })
    .parse(JSON.parse(readFileSync(marker, "utf8")));

  process.kill(fault.pid, 0);

  if (scenario !== "watch" && fault.blockedCount !== 4) {
    throw new Error(
      "The readonly RPC did not fill all four native filesystem workers",
    );
  }

  if (existsSync(`${marker}.released`)) {
    throw new Error("The external filesystem operation was already released");
  }

  return fault.pid;
}

function text(): string {
  const messages: string[] = [];

  for (const { envelope } of app.eventSink.pendingEvents()) {
    const event = envelope.event;

    if (event.type === "item/completed" && event.item.type === "agentMessage") {
      messages.push(event.item.text);
    }
  }

  return messages.join("\n");
}

function completedTurns(): number {
  let count = 0;

  for (const { envelope } of app.eventSink.pendingEvents()) {
    if (envelope.event.type === "turn/completed") count += 1;
  }

  return count;
}

try {
  if (scenario === "write-file") await verifyMutationSerialization();

  writeFileSync(armed, "armed");

  if (scenario === "watch") {
    blockedOperation = app.watchManager.replaceAuthoritativeWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "external-workspace",
          workspaceContext: { workspacePath: root },
        },
      ],
      threadStorageTargets: [],
    });
  } else if (scenario === "paths-exist") {
    blockedOperation = app.router.handleOnlineRpcRequest({
      type: "host-rpc.request",
      requestId: "blocked-native-read",
      command: { type: "host.paths_exist", paths: externalPaths },
    });
  } else {
    admittedWrites = externalPaths.map((target, index) =>
      app.router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: `blocked-native-write-${index}`,
        command: {
          type: "host.write_file",
          path: path.join(target, "fixture-output.txt"),
          content: "synthetic-fixture",
          contentEncoding: "utf8",
          createParents: false,
          expectedSha256: index === 0 ? firstTargetExpectedSha256 : null,
        },
      }),
    );
    blockedOperation = Promise.all(admittedWrites);
  }

  void blockedOperation.catch(() => undefined);
  await within(
    until(() => existsSync(marker)),
    "The daemon did not enter the controlled external filesystem operation",
  );
  requireBlockedFilesystem();

  if (process.connected) {
    process.send?.({ kind: "fault-active" }, () => undefined);
  }

  const { runtime } = await within(
    app.runtimeManager.ensureEnvironment({
      environmentId: "internal-workspace",
      workspacePath: internal,
    }),
    "Unrelated chat startup was blocked by the external filesystem operation",
  );

  const bridgeLaunch: AgentRuntimeBridgeLaunch = {
    pluginId: "provider-scripted-echo",
    dataDir: path.join(base, "bridge-data"),
    source: {
      kind: "artifact",
      digest: "scripted-echo",
      artifactPath: providerArtifact,
    },
    capabilities: {
      providerInstallation: false,
      supportsServiceTier: false,
      permissionModes: ["accept-edits", "auto", "full"],
      supportsThreadArchive: true,
      supportsThreadRename: true,
      fork: "checkpoint",
    },
    providerOptions: {},
    envPassthrough: [],
  };

  await within(
    runtime.startThread({
      environmentId: "internal-workspace",
      threadId: "internal-thread",
      projectId: "internal-project",
      providerId: "fake",
      bridgeLaunch,
      options: fullRuntimeOptions,
    }),
    "Unrelated provider startup was blocked by the external filesystem operation",
  );

  async function turn(
    message: string,
    clientRequestId: "creq_222222222b" | "creq_222222222c",
  ) {
    requireBlockedFilesystem();
    const completedBefore = completedTurns();
    await runtime.runTurn({
      threadId: "internal-thread",
      clientRequestId,
      input: [{ type: "text", text: message, mentions: [] }],
      options: fullRuntimeOptions,
    });
    await until(
      () => text().includes(message) && completedTurns() > completedBefore,
    );
  }

  await within(
    turn("internal-start", "creq_222222222b"),
    "The actual provider bridge did not complete the first turn",
  );
  const first = text();
  await within(
    turn("internal-follow-up", "creq_222222222c"),
    "Unrelated chat messaging was blocked by the external filesystem operation",
  );
  requireBlockedFilesystem();

  if (process.connected) {
    process.send?.(
      { kind: "passed", first, followUp: text() },
      () => undefined,
    );
  }

  if (scenario === "write-file") {
    await within(
      app.daemon.shutdown("dispose-with-active-writes", 0),
      "Disposing the daemon waited for blocked filesystem mutations",
    );
    drainingMutationPid = requireBlockedFilesystem();

    const rejectedPath = path.join(internal, "rejected-after-disposal.txt");

    const rejected = await app.router.handleOnlineRpcRequest({
      type: "host-rpc.request",
      requestId: "mutation-after-disposal",
      command: {
        type: "host.write_file",
        path: rejectedPath,
        content: "must-not-write",
        contentEncoding: "utf8",
        createParents: false,
        expectedSha256: null,
      },
    });

    if (
      rejected.ok ||
      rejected.errorCode !== "filesystem_mutator_stopped" ||
      existsSync(rejectedPath)
    ) {
      throw new Error("A new filesystem mutation was admitted after disposal");
    }

    if (process.connected)
      process.send?.({ kind: "mutation-disposed" }, () => undefined);

    successor = await createApp("workspace-io-successor");
    successorWrite = successor.router.handleOnlineRpcRequest({
      type: "host-rpc.request",
      requestId: "successor-before-drain",
      command: {
        type: "host.write_file",
        path: path.join(root, "fixture-output.txt"),
        content: "must-not-race-draining-writer",
        contentEncoding: "utf8",
        createParents: false,
        expectedSha256: firstTargetExpectedSha256,
      },
    });

    const fenced = await within(
      successorWrite,
      "The successor writer waited for the blocked external filesystem",
    );

    if (fenced.ok || fenced.errorCode !== "filesystem_mutator_busy") {
      throw new Error(
        "The successor writer bypassed the draining writer fence",
      );
    }

    requireBlockedFilesystem();

    if (process.connected)
      process.send?.({ kind: "successor-fenced" }, () => undefined);
  }
} catch (error) {
  reportFailure(error);
} finally {
  if (process.connected) {
    process.send?.({ kind: "release-required" }, () => undefined);
  }

  await new Promise<void>((resolve) => {
    process.once("message", () => resolve());
  });
  clearTimeout(watchdog);

  try {
    await blockedOperation;
    await successorWrite;

    if (scenario === "write-file") {
      const results = (await Promise.all(admittedWrites)).map(
        requireWriteResult,
      );

      if (
        results.length !== 4 ||
        results.some((result) => result.outcome !== "written")
      ) {
        throw new Error("Disposal did not drain all four admitted file writes");
      }

      const mutationPid = drainingMutationPid;

      if (mutationPid === undefined) {
        throw new Error("The blocked filesystem mutator was not disposed");
      }

      await within(
        until(() => {
          try {
            process.kill(mutationPid, 0);

            return false;
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
              return true;
            throw error;
          }
        }),
        "The disposed filesystem mutator did not exit after its writes drained",
      );

      const first = results[0];
      const nextOwner = successor;

      if (!nextOwner || !first || first.outcome !== "written") {
        throw new Error("The successor writer was not prepared after drain");
      }

      const resumed = requireWriteResult(
        await nextOwner.router.handleOnlineRpcRequest({
          type: "host-rpc.request",
          requestId: "successor-after-drain",
          command: {
            type: "host.write_file",
            path: path.join(root, "fixture-output.txt"),
            content: "successor-after-drain",
            contentEncoding: "utf8",
            createParents: false,
            expectedSha256: first.sha256,
          },
        }),
      );

      if (resumed.outcome !== "written") {
        throw new Error(
          "The successor writer did not acquire the released fence",
        );
      }

      if (process.connected)
        process.send?.({ kind: "successor-recovered" }, () => undefined);

      if (process.connected)
        process.send?.({ kind: "writes-drained" }, () => undefined);
    }
  } catch (error) {
    reportFailure(error);
  }

  await shutdownApp();
  process.off("disconnect", releaseFaultAndExit);
  process.disconnect?.();
  process.exit(fixtureFailed ? 1 : 0);
}
