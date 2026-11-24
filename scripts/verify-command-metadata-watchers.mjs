import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const source = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const scratchParent = path.join(os.homedir(), "scratch/omnyo");

await fs.mkdir(scratchParent, { recursive: true });

const scratch = await fs.mkdtemp(
  path.join(scratchParent, "fswatch-native-proof-"),
);

const nativeLog = path.join(scratch, "native.jsonl");

const preload = path.join(scratch, "preload.cjs");

const idleDelay = 2500;

const children = new Set();

const readers = new Set();

let readerStarts = 0;

const originalFork = childProcess.fork;

const originalTimeout = globalThis.setTimeout;

const report = {
  nativeBackend: "@parcel/watcher",
  platform: process.platform,
  node: process.version,
  idleDelayMs: idleDelay,
};

const sourceFiles = [
  "apps/host-daemon/src/workspace-read-client.ts",
  "apps/host-daemon/src/workspace-read-child.ts",
  "apps/host-daemon/src/command-metadata.ts",
  "apps/host-daemon/src/catalog-watch-owner.ts",
  "apps/host-daemon/src/workspace-read-protocol.ts",
  "packages/host-watcher/src/catalog-cache.ts",
  "packages/host-watcher/src/index.ts",
  "scripts/verify-command-metadata-watchers.mjs",
];

const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => {
        const bytes = await fs
          .readFile(path.join(source, file))
          .catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });

        return [
          file,
          bytes === null
            ? "absent"
            : createHash("sha256").update(bytes).digest("hex"),
        ];
      }),
    ),
  );

const deadline = originalTimeout(() => {
  report.deadlineExceeded = true;
  process.exitCode = 1;

  for (const child of children) child.kill("SIGKILL");
}, 45_000);

let catalog;

let observer;

const preloadSource = `const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { createRequire, syncBuiltinESMExports } = require("node:module");
const log = (event) => fs.appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
const fork = cp.fork;
cp.fork = function (entry, args, options) {
  return fork.call(this, entry, args, { ...options, execArgv: ["--require", __filename, ...(options?.execArgv ?? [])] });
};
syncBuiltinESMExports();
const native = createRequire(${JSON.stringify(path.join(source, "packages/host-watcher/package.json"))})("@parcel/watcher");
const subscribe = native.subscribe;
native.subscribe = async function (root, callback, options) {
  const subscription = await subscribe.call(this, root, (error, events) => {
    log({ kind: "events", root, errors: error ? 1 : 0, count: events.length });
    callback(error, events);
  }, options);
  log({ kind: "subscribe", root });
  const unsubscribe = subscription.unsubscribe.bind(subscription);
  subscription.unsubscribe = async () => { await unsubscribe(); log({ kind: "unsubscribe", root }); };
  return subscription;
};
`;

childProcess.fork = function (entry, args, options) {
  const child = originalFork.call(this, entry, args, {
    ...options,
    execArgv: ["--require", preload, ...(options?.execArgv ?? [])],
  });

  if (/workspace-read-child\.[cm]?[jt]s$/.test(String(entry))) {
    readerStarts++;
    readers.add(child);
    child.once("exit", () => readers.delete(child));
  }

  children.add(child);
  child.once("exit", () => children.delete(child));

  return child;
};

globalThis.setTimeout = function (callback, milliseconds, ...args) {
  return originalTimeout(
    callback,
    milliseconds === 60_000 ? idleDelay : milliseconds,
    ...args,
  );
};

syncBuiltinESMExports();

const readNative = async () =>
  (await fs.readFile(nativeLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const countNative = (events, kind, root) =>
  events.filter((event) => event.kind === kind && event.root === root).length;

const waitFor = async (predicate, milliseconds = 3000) => {
  const deadline = Date.now() + milliseconds;

  while (!(await predicate()) && Date.now() < deadline) await delay(25);
};

const emptyRoots = { user: [], project: [] };

const writeSkill = (root, description) =>
  fs.writeFile(
    path.join(root, "test-skill/SKILL.md"),
    `---\nname: test-skill\ndescription: ${description}\n---\n`,
  );

const commandFor = (cwd, root) => ({
  type: "host.list_command_metadata",
  providerId: "native-proof",
  cwd,
  nativeRoots: {
    skills: emptyRoots,
    commands: emptyRoots,
    resolved: { skills: [], commands: [], watchPaths: [] },
  },
  sharedSkillRoots: {
    user: [
      {
        path: path.relative(os.homedir(), root),
        recursive: false,
        ancestors: false,
        namePrefix: "",
      },
    ],
    project: [],
  },
  projectSkillRead: { limit: 1000, maxFileBytes: 1048576, excludeNames: [] },
});

const dispose = async () => {
  await catalog?.dispose();
  await observer?.shutdown();
  catalog = undefined;
  observer = undefined;
};

try {
  report.sourceHashes = await sourceHashes();
  await Promise.all([
    fs.writeFile(nativeLog, ""),
    fs.writeFile(preload, preloadSource),
  ]);

  const { IsolatedCommandMetadataCatalog } = await import(
    pathToFileURL(
      path.join(source, "apps/host-daemon/src/workspace-read-client.ts"),
    )
  );

  const { createIsolatedWatchManager } = await import(
    pathToFileURL(
      path.join(source, "apps/host-daemon/src/workspace-observer-client.ts"),
    )
  );

  const shared = path.join(scratch, "shared");
  const unrelated = path.join(scratch, "unrelated");

  const cwds = Array.from({ length: 3 }, (_, index) =>
    path.join(scratch, `workspace-${index}`),
  );

  await Promise.all(
    [...cwds, shared, unrelated].map((root) =>
      fs.mkdir(path.join(root, "test-skill"), { recursive: true }),
    ),
  );
  await Promise.all([
    writeSkill(shared, "before"),
    writeSkill(unrelated, "unrelated"),
  ]);
  const changes = [];
  const warnings = [];

  const start = () => {
    observer = createIsolatedWatchManager({
      logger: { warn: () => warnings.push("observer-warning") },
    });
    catalog = new IsolatedCommandMetadataCatalog((scopes) => {
      changes.push(scopes ?? []);
    }, observer.hostWatcher);
  };

  const verify = async (command, description) => {
    const result = await catalog.list(command);
    assert.equal(
      result.sharedSkills.find((skill) => skill.name === "test-skill")
        ?.description,
      description,
    );
  };

  const commands = cwds.map((cwd, index) =>
    commandFor(cwd, index === 2 ? unrelated : shared),
  );

  start();
  await verify(commands[0], "before");
  report.oneCwdSharedSubscriptions = countNative(
    await readNative(),
    "subscribe",
    shared,
  );
  await dispose();
  const offset = (await readNative()).length;
  changes.length = 0;
  start();
  await Promise.all(
    commands.map((command, index) =>
      verify(command, index === 2 ? "unrelated" : "before"),
    ),
  );
  const afterWarm = (await readNative()).slice(offset);
  report.threeCwdSharedSubscriptions = countNative(
    afterWarm,
    "subscribe",
    shared,
  );
  report.threeCwdUnrelatedSubscriptions = countNative(
    afterWarm,
    "subscribe",
    unrelated,
  );
  await delay(200);
  changes.length = 0;
  await writeSkill(shared, "edited");
  await waitFor(() => changes.length > 0);
  await delay(200);
  const firstChanges = changes.splice(0);
  report.editNotifications = firstChanges.map((scopes) =>
    scopes.map((scope) => ({
      cwd: cwds.indexOf(scope.cwd),
      providerId: scope.providerId,
    })),
  );
  await Promise.all(
    commands.slice(0, 2).map((command) => verify(command, "edited")),
  );
  const beforeIdleStarts = readerStarts;
  await delay(idleDelay + 500);
  await waitFor(() => readers.size === 0);
  report.readersRemainingAfterIdle = readers.size;
  report.idleReaderStarts = readerStarts - beforeIdleStarts;
  report.idleNotifications = changes.splice(0).length;
  report.sharedUnsubscriptionsAfterIdle = countNative(
    (await readNative()).slice(offset),
    "unsubscribe",
    shared,
  );
  await writeSkill(shared, "after-idle");
  await waitFor(() => changes.length > 0, 1500);
  await delay(200);
  const idleChanges = changes.splice(0);
  report.postIdleEditNotifications = idleChanges.map((scopes) =>
    scopes.map((scope) => ({
      cwd: cwds.indexOf(scope.cwd),
      providerId: scope.providerId,
    })),
  );
  await Promise.all(
    commands.map((command, index) =>
      verify(command, index === 2 ? "unrelated" : "after-idle"),
    ),
  );
  report.sharedSubscriptionsAfterFinalRead = countNative(
    (await readNative()).slice(offset),
    "subscribe",
    shared,
  );
  await dispose();
  const events = (await readNative()).slice(offset);
  report.finalSharedUnsubscriptions = countNative(
    events,
    "unsubscribe",
    shared,
  );
  report.nativeErrors = events.filter((event) => event.errors).length;
  report.sharedNativeEventBatches = countNative(events, "events", shared);
  report.unrelatedNativeEventBatches = countNative(events, "events", unrelated);
  report.observerWarnings = warnings.length;

  const expectedScopes = [0, 1].map((cwd) => ({
    cwd,
    providerId: "native-proof",
  }));

  const normalized = (notifications) =>
    notifications.map((scopes) => scopes.sort((a, b) => a.cwd - b.cwd));

  const checks = {
    oneSharedSubscription: report.oneCwdSharedSubscriptions === 1,
    sharedSubscriptionIndependentOfCwds:
      report.threeCwdSharedSubscriptions === 1,
    unrelatedSubscription: report.threeCwdUnrelatedSubscriptions === 1,
    editScopedOnce:
      JSON.stringify(normalized(report.editNotifications)) ===
      JSON.stringify([expectedScopes]),
    idleWorkersRetiredWithoutRespawn:
      readerStarts >= 4 &&
      report.readersRemainingAfterIdle === 0 &&
      report.idleReaderStarts === 0,
    idleQuiet:
      report.idleNotifications === 0 &&
      report.sharedUnsubscriptionsAfterIdle === 0,
    postIdleEditScopedOnce:
      JSON.stringify(normalized(report.postIdleEditNotifications)) ===
      JSON.stringify([expectedScopes]),
    noIdleReregistration: report.sharedSubscriptionsAfterFinalRead === 1,
    disposeUnsubscribes: report.finalSharedUnsubscriptions === 1,
    noErrors: report.nativeErrors === 0 && report.observerWarnings === 0,
    sourceStable:
      JSON.stringify(report.sourceHashes) ===
      JSON.stringify(await sourceHashes()),
  };

  report.checks = checks;
  report.passed = Object.values(checks).every(Boolean);

  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await dispose();
  clearTimeout(deadline);
  childProcess.fork = originalFork;
  globalThis.setTimeout = originalTimeout;
  syncBuiltinESMExports();

  for (const child of children) child.kill("SIGKILL");
  await waitFor(() => children.size === 0, 2000);

  if (children.size > 0) {
    report.cleanup = "owned child processes did not exit";
    report.retainedScratch = scratch;
    process.exitCode = 1;
  } else {
    await fs.rm(scratch, { recursive: true });
    report.cleanup = "removed owned scratch";
  }

  console.log(JSON.stringify(report, null, 2));
}
