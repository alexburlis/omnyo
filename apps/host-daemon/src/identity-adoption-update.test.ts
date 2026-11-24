import { createOmnyoWorkerRuntimeFixture } from "@omnyo/server-archive/test/omnyo-worker-runtime-fixture";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readMaintenanceHold,
  writeMaintenanceHold,
} from "@omnyo/server-archive";
import {
  ServerMoveService,
  defaultServerMoveServiceOptions,
} from "./server-move/service.js";
import {
  prepareWorkerIdentityAdoptionRestart,
  WORKER_IDENTITY_ADOPTION_REQUEST_V1,
} from "./identity-adoption-update.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-worker-idle-"));
  roots.push(dataDir);
  const runtimeRoot = join(dataDir, "npm", "node_modules", "omnyo-app");

  const identity = await createOmnyoWorkerRuntimeFixture(runtimeRoot, {
    runtimeVersion: "1.0.0+private.1",
    hostDaemonProtocolVersion: 123,
  });

  const binding = {
    version: 1,
    ownerKind: "worker",
    sourceDataDir: dataDir,
    destinationDataDir: join(dataDir, "..", "canonical-fixture"),
    jobDir: join(dataDir, "..", "protected-fixture"),
    runtimeRoot,
    runtimeSha256: identity.runtimeSha256,
    archiveSha256: "a".repeat(64),
  };

  await writeFile(
    join(dataDir, WORKER_IDENTITY_ADOPTION_REQUEST_V1),
    JSON.stringify(binding),
  );

  const activity = {
    commands: 0,
    runtimes: 0,
    terminals: 0,
    pluginHosts: 0,
    interactions: 0,
  };

  const serverMove = new ServerMoveService({
    ...defaultServerMoveServiceOptions(),
    dataDir,
    homeDir: dataDir,
    hostId: "host_worker_fixture",
    instanceId: "instance_fixture",
    serverUrl: "https://server.example.test",
    hostKey: "synthetic-fixture-key",
    serverHeaders: {},
    hostDaemonPort: null,
    autoUpdate: true,
    supervised: true,
    getRuntimeUpdateActivity: () => activity,
    logger: { info() {}, error() {}, warn() {} },
    isServerSessionOpen: () => false,
    getShellEnv: () => ({}),
    emitProgress() {},
    async requestShutdown() {},
  });

  const args = {
    dataDir,
    hostId: "host_worker_fixture",
    instanceId: "instance_fixture",
    updateOwner: "self-update:instance_fixture",
    serverMove,
    target: {
      version: "1.0.0+private.1",
      protocolVersion: 123,
      artifactDigest: binding.archiveSha256,
    },
  };

  return { args, activity, binding, runtimeRoot };
}

test("persists only its genuinely acquired idle owner and replays the same receipt without changing it", async () => {
  const fixtureValue = await fixture();
  const { args, activity } = fixtureValue;
  await expect(prepareWorkerIdentityAdoptionRestart(args)).rejects.toThrow(
    /idle admission/,
  );
  expect(readMaintenanceHold(args.dataDir)).toBeNull();
  expect(args.serverMove.tryAcquireRuntimeUpdateHold(0, args.updateOwner)).toBe(
    true,
  );
  await prepareWorkerIdentityAdoptionRestart(args);
  const path = join(args.dataDir, "server-maintenance-hold.json");
  const receipt = await readFile(path);
  expect(readMaintenanceHold(args.dataDir)).toMatchObject({
    kind: "desktop-update",
    phase: "held",
    id: "worker_identity_instance_fixture",
    ownerId: args.updateOwner,
    serverHostId: args.hostId,
    artifact: {
      archiveSha256: fixtureValue.binding.archiveSha256,
      runtimeSha256: fixtureValue.binding.runtimeSha256,
    },
  });
  await prepareWorkerIdentityAdoptionRestart(args);
  expect(await readFile(path)).toEqual(receipt);
  activity.runtimes = 1;
  await expect(prepareWorkerIdentityAdoptionRestart(args)).rejects.toThrow(
    /idle admission/,
  );
  expect(await readFile(path)).toEqual(receipt);
});

test("refuses a changed runtime or foreign hold without overwriting protected ownership", async () => {
  const { args, runtimeRoot } = await fixture();
  expect(args.serverMove.tryAcquireRuntimeUpdateHold(0, args.updateOwner)).toBe(
    true,
  );
  const entry = join(runtimeRoot, "dist/omnyo.js");
  const original = await readFile(entry);
  await writeFile(entry, "changed runtime bytes");
  await expect(prepareWorkerIdentityAdoptionRestart(args)).rejects.toThrow(
    /inventory digest/,
  );
  expect(readMaintenanceHold(args.dataDir)).toBeNull();
  await writeFile(entry, original);
  await writeMaintenanceHold(args.dataDir, {
    version: 1,
    id: "foreign",
    ownerId: "foreign",
    kind: "desktop-update",
    phase: "held",
    serverHostId: args.hostId,
    createdAt: 17,
    artifact: null,
  });
  const path = join(args.dataDir, "server-maintenance-hold.json");
  const foreign = await readFile(path);
  await expect(prepareWorkerIdentityAdoptionRestart(args)).rejects.toThrow(
    /foreign maintenance/,
  );
  expect(await readFile(path)).toEqual(foreign);
});
