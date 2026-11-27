import fs from "node:fs/promises";
import path from "node:path";
import { scratchDirectory } from "./managed-test-fixture.js";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  defineRpcContract,
  experimental_defineHostEntry,
} from "@omnyo/plugin-sdk";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import {
  createHousekeepingHost,
  housekeepingHelpers,
} from "./housekeeping-host.js";
import {
  defaultHousekeepingBudget,
  housekeepingHostContract,
  type HousekeepingRun,
} from "./housekeeping-contract.js";

const directories: string[] = [];

const completions: Promise<void>[] = [];

const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(completions.splice(0));

  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true });
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

function run(overrides: Partial<HousekeepingRun> = {}): HousekeepingRun {
  return {
    id: randomUUID(),
    mode: "apply",
    state: "planned",
    startedAt: Date.now(),
    finishedAt: null,
    registrationRevision: null,
    bindingsDigest: null,
    budget: { ...defaultHousekeepingBudget },
    reserved: { items: 0, bytes: 0 },
    stages: [],
    reason: null,
    ...overrides,
  };
}

async function directory() {
  const directory = await scratchDirectory("housekeeping-host-fixture-");

  directories.push(directory);

  return directory;
}

function completion() {
  let resolve = () => {};

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  completions.push(promise);

  return { promise, resolve };
}

it("has no external policy by default and retains one worker through a concurrent apply", async () => {
  const dataDir = await directory();
  let release = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  releases.push(release);
  const closed = completion();
  let entered = () => {};

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let recoveries = 0;
  let leases = 0;

  const native = createHousekeepingHost({
    dataDir,
    retainWorker: () => {
      leases++;

      return {
        dispose() {
          leases--;
          closed.resolve();
        },
      };
    },
    recoverTemps: async () => {
      recoveries++;
      entered();
      await gate;

      return [];
    },
  });

  expect(await native.state()).toEqual({
    registration: null,
    currentRun: null,
    lastRun: null,
  });
  const request = run();

  const [first, duplicate] = await Promise.all([
    native.start({ run: request }),
    native.start({ run: request }),
  ]);

  expect(first.id).toBe(duplicate.id);
  expect(leases).toBe(1);
  await started;
  expect(recoveries).toBe(1);
  await expect(native.start({ run: run() })).rejects.toThrow("already active");
  release();
  await closed.promise;
  expect(leases).toBe(0);
  const state = await native.state();
  expect(state.currentRun).toBeNull();
  expect(state.lastRun).toMatchObject({
    id: request.id,
    state: "completed",
    stages: [
      { name: "process-private-temp", state: "complete" },
      { name: "local-policy", state: "deferred" },
    ],
  });
  expect(state.registration).toBeNull();
});

it("preserves every completed run identity after later runs and process restart", async () => {
  const dataDir = await directory();
  let recoveries = 0;
  const terminal = new Map<string, () => void>();

  const native = createHousekeepingHost({
    dataDir,
    retainWorker: () => ({ dispose() {} }),
    recoverTemps: async () => {
      recoveries++;

      return [];
    },
    changed: (id) => {
      void native.run({ id }).then((value) => {
        if (value.finishedAt !== null) terminal.get(id)?.();
      });
    },
  });

  const first = run();
  const firstDone = completion();
  terminal.set(first.id, firstDone.resolve);
  await native.start({ run: first });
  await firstDone.promise;
  const second = run();
  const secondDone = completion();
  terminal.set(second.id, secondDone.resolve);
  await native.start({ run: second });
  await secondDone.promise;

  const restarted = createHousekeepingHost({
    dataDir,
    retainWorker: () => ({ dispose() {} }),
    recoverTemps: async () => {
      recoveries++;

      return [];
    },
  });

  expect(await restarted.start({ run: first })).toMatchObject({
    id: first.id,
    state: "completed",
  });
  expect(await restarted.run({ id: first.id })).toMatchObject({
    id: first.id,
    state: "completed",
  });
  expect(recoveries).toBe(2);
});

it.each([
  { label: "worker stopped mid-stage", state: "running" as const },
  { label: "uncertain failure", state: "held" as const },
])(
  "holds a process temporary stage left running ($label) without replay and admits the next run",
  async ({ state }) => {
    const dataDir = await directory();

    const pending = run({
      state,
      finishedAt: state === "held" ? Date.now() : null,
      reason:
        state === "held"
          ? "The cleanup outcome is uncertain. Reconcile the existing run; no cleanup was replayed."
          : null,
      stages: [
        {
          name: "process-private-temp",
          state: "running",
          reason: null,
          items: 0,
          bytes: 0,
        },
      ],
    });

    await fs.mkdir(path.join(dataDir, "housekeeping-v1"));
    await fs.writeFile(
      path.join(dataDir, "housekeeping-v1", "state.json"),
      JSON.stringify({
        registration: null,
        currentRun: pending,
        lastRun: null,
        preview: null,
      }),
    );
    let recoveries = 0;
    const closed = completion();

    const native = createHousekeepingHost({
      dataDir,
      retainWorker: () => ({
        dispose() {
          closed.resolve();
        },
      }),
      recoverTemps: async () => {
        recoveries++;

        return [];
      },
    });

    const reconciled = await native.state();
    expect(reconciled.currentRun).toBeNull();
    expect(reconciled.lastRun).toMatchObject({
      id: pending.id,
      state: "held",
      reserved: { items: 0, bytes: 0 },
      stages: [
        {
          name: "process-private-temp",
          state: "held",
          items: null,
          bytes: null,
          reason: expect.stringContaining("not replayed"),
        },
      ],
    });
    expect(await native.run({ id: pending.id })).toMatchObject({
      state: "held",
      stages: [{ name: "process-private-temp", state: "held" }],
    });
    expect(recoveries).toBe(0);

    const next = run();
    expect(await native.start({ run: next })).toMatchObject({
      id: next.id,
      state: "planned",
    });
    await closed.promise;
    expect(recoveries).toBe(1);
    expect((await native.state()).lastRun).toMatchObject({
      id: next.id,
      state: "completed",
    });
  },
);

it("holds a reserved journal left running after restart and never launches its replacement", async () => {
  const dataDir = await directory();

  const pending = run({
    state: "running",
    reserved: { items: 3, bytes: 1024 },
    stages: [],
  });

  await fs.mkdir(path.join(dataDir, "housekeeping-v1"));
  await fs.writeFile(
    path.join(dataDir, "housekeeping-v1", "state.json"),
    JSON.stringify({
      registration: null,
      currentRun: pending,
      lastRun: null,
      preview: null,
    }),
  );
  let recoveries = 0;

  const native = createHousekeepingHost({
    dataDir,
    retainWorker: () => ({ dispose() {} }),
    recoverTemps: async () => {
      recoveries++;

      return [];
    },
  });

  expect((await native.state()).currentRun).toMatchObject({
    id: pending.id,
    state: "held",
    reason: expect.stringContaining("not replayed"),
  });
  await expect(native.start({ run: run() })).rejects.toThrow("already active");
  expect(recoveries).toBe(0);
});

it("preview uses only inspection and leaves active provider allocations untouched", async () => {
  const dataDir = await directory();
  const closed = completion();
  let applies = 0;

  const native = createHousekeepingHost({
    dataDir,
    retainWorker: () => ({
      dispose() {
        closed.resolve();
      },
    }),
    inspectTemps: async () => [
      {
        allocationId: "provider-active",
        pluginId: "provider",
        origin: "provider-bridge",
        tempDir: "/unused-active-provider",
        status: "active",
        reason: "The provider process is still running.",
        sizeBytes: null,
      },
    ],
    recoverTemps: async () => {
      applies++;

      return [];
    },
  });

  const request = run({ mode: "preview" });
  await native.start({ run: request });
  await closed.promise;
  expect(await native.run({ id: request.id })).toMatchObject({
    state: "completed",
    stages: [
      { name: "process-private-temp", items: 0, bytes: 0 },
      { name: "local-policy", state: "deferred" },
    ],
  });
  expect(applies).toBe(0);
});

async function sourceFixture(root: string) {
  const sourceDirectory = path.join(root, "source");
  await fs.mkdir(sourceDirectory);

  for (const name of housekeepingHelpers)
    await fs.writeFile(path.join(sourceDirectory, name), "\n");

  for (const name of ["review-policy.toml", "storage-watch.toml"])
    await fs.writeFile(path.join(root, name), "\n");
  const policyPath = path.join(root, "policy.toml");
  await fs.writeFile(policyPath, "approved = true\n");

  return {
    sourceDirectory,
    policyPath,
    pythonPath: await fs.realpath("/usr/bin/python3"),
  };
}

it.runIf(process.platform === "darwin")(
  "reports a stopped Kasten daemon as skipped with zero removals",
  async () => {
    const root = await directory();
    const source = await sourceFixture(root);
    const policyPath = path.join(root, "policy-docker-kasten.toml");
    await fs.writeFile(policyPath, "approved_kasten = true\n");
    await fs.writeFile(
      path.join(source.sourceDirectory, "housekeeping.py"),
      [
        "import hashlib, json, pathlib, sys",
        "args = dict(zip(sys.argv[2::2], sys.argv[3::2]))",
        "receipt = json.dumps({'mode': 'apply', 'docker': {'status': 'local-daemon-stopped'}}).encode()",
        "pathlib.Path(args['--state-directory'], args['--run-id'] + '-docker-kasten.json').write_bytes(receipt)",
        "stage = {'name': 'docker-kasten', 'state': 'complete', 'reason': 'native-removal-counts-and-bytes-unmeasured', 'items': None, 'bytes': None, 'reportSha256': hashlib.sha256(receipt).hexdigest()}",
        "print(json.dumps({'schema': 1, 'runId': args['--run-id'], 'state': 'completed', 'bindingsDigest': args['--expected-bindings'], 'stages': [stage], 'reserved': {'items': 0, 'bytes': 0}}))",
      ].join("\n"),
    );
    const closed = completion();

    const native = createHousekeepingHost({
      dataDir: path.join(root, "data"),
      retainWorker: () => ({ dispose: closed.resolve }),
      recoverTemps: async () => [],
    });

    const preview = await native.adapterPreview({
      ...source,
      namedPolicies: { "docker-kasten": policyPath },
    });

    const registration = await native.adapterAdopt({
      revision: preview.revision,
      previewDigest: preview.previewDigest,
    });

    const request = run({
      registrationRevision: registration.revision,
      bindingsDigest: registration.bindingsDigest,
    });

    await native.start({ run: request });
    await closed.promise;
    expect(await native.run({ id: request.id })).toMatchObject({
      state: "completed",
      stages: expect.arrayContaining([
        {
          name: "docker-kasten",
          state: "skipped",
          reason: "local-daemon-stopped",
          items: 0,
          bytes: 0,
        },
      ]),
    });
  },
);

it.runIf(process.platform === "darwin")(
  "binds the named Kasten policy separately and refuses changed profile bytes",
  async () => {
    const root = await directory();
    const source = await sourceFixture(root);
    const policyPath = path.join(root, "policy-docker-kasten.toml");
    await fs.writeFile(policyPath, "approved_kasten = true\n");

    const native = createHousekeepingHost({
      dataDir: path.join(root, "data"),
      retainWorker: () => ({ dispose() {} }),
    });

    const preview = await native.adapterPreview({
      ...source,
      namedPolicies: { "docker-kasten": policyPath },
    });

    expect(preview.bindings.namedPolicies["docker-kasten"]?.path).toBe(
      policyPath,
    );
    expect(preview.stages).toContain("docker-kasten");
    expect(preview.stages).toContain("runtime-discovery");
    await fs.appendFile(policyPath, "changed = true\n");
    await expect(
      native.adapterAdopt({
        revision: preview.revision,
        previewDigest: preview.previewDigest,
      }),
    ).rejects.toThrow("changed");
    expect((await native.state()).registration).toBeNull();
  },
);

it.runIf(process.platform === "darwin")(
  "requires exact fresh preview and hashes physical runtime, policy, helpers and configuration",
  async () => {
    const root = await directory();
    const source = await sourceFixture(root);

    const native = createHousekeepingHost({
      dataDir: path.join(root, "data"),
      retainWorker: () => ({ dispose() {} }),
    });

    const preview = await native.adapterPreview(source);
    expect(Object.keys(preview.bindings.helpers)).toHaveLength(17);
    expect(Object.keys(preview.bindings.configuration)).toEqual([
      "review-policy.toml",
      "storage-watch.toml",
    ]);
    await expect(
      native.adapterAdopt({
        revision: 1,
        previewDigest: preview.previewDigest,
      }),
    ).rejects.toThrow("changed");
    await fs.appendFile(source.policyPath, "changed = true\n");
    await expect(
      native.adapterAdopt({
        revision: 0,
        previewDigest: preview.previewDigest,
      }),
    ).rejects.toThrow("inputs changed");
    const fresh = await native.adapterPreview(source);
    const before = await fs.readFile(source.policyPath, "utf8");

    const registration = await native.adapterAdopt({
      revision: 0,
      previewDigest: fresh.previewDigest,
    });

    expect(registration).toMatchObject({
      revision: 1,
      bindingsDigest: fresh.bindingsDigest,
    });
    expect(await fs.readFile(source.policyPath, "utf8")).toBe(before);
    await fs.appendFile(
      path.join(source.sourceDirectory, "cleanup.py"),
      "changed\n",
    );
    expect(
      await native.start({
        run: run({
          registrationRevision: registration.revision,
          bindingsDigest: registration.bindingsDigest,
        }),
      }),
    ).toMatchObject({
      state: "held",
      reason: expect.stringContaining("changed"),
    });
    expect((await native.state()).currentRun).toBeNull();
  },
);

it.runIf(process.platform === "darwin")(
  "refuses symbolic-link source and helper adoption and confirms exact removal",
  async () => {
    const root = await directory();
    const source = await sourceFixture(root);

    const native = createHousekeepingHost({
      dataDir: path.join(root, "data"),
      retainWorker: () => ({ dispose() {} }),
    });

    const linked = path.join(root, "linked");
    await fs.symlink(source.sourceDirectory, linked);
    await expect(
      native.adapterPreview({ ...source, sourceDirectory: linked }),
    ).rejects.toThrow("physical");
    const preview = await native.adapterPreview(source);
    await native.adapterAdopt({
      revision: 0,
      previewDigest: preview.previewDigest,
    });
    await expect(
      native.adapterRemove({
        revision: 1,
        previewDigest: preview.previewDigest,
      }),
    ).rejects.toThrow("fresh preview");
    const removal = await native.adapterPreview(source);
    await native.adapterRemove({
      revision: 1,
      previewDigest: removal.previewDigest,
    });
    expect((await native.state()).registration).toBeNull();
    const helper = path.join(source.sourceDirectory, "cleanup.py");
    await fs.unlink(helper);
    await fs.symlink(source.policyPath, helper);
    await expect(native.adapterPreview(source)).rejects.toThrow("physical");
  },
);

it.runIf(process.platform === "darwin")(
  "a real Python child finishes after caller cancellation and releases its worker only after its receipt",
  async () => {
    const root = await directory();
    const source = await sourceFixture(root);
    await fs.writeFile(
      path.join(source.sourceDirectory, "housekeeping.py"),
      [
        "import json, pathlib, sys, time",
        "args = dict(zip(sys.argv[2::2], sys.argv[3::2]))",
        "time.sleep(0.08)",
        "pathlib.Path(args['--state-directory'], 'child-finished').write_text('finished')",
        "result = {'schema': 1, 'runId': args['--run-id'], 'state': 'completed', 'reason': None, 'bindingsDigest': args['--expected-bindings'], 'stages': [{'name': 'periodic', 'state': 'complete', 'reason': None, 'items': 0, 'bytes': 0}], 'reserved': {'items': 0, 'bytes': 0}}",
        "print(json.dumps(result))",
      ].join("\n"),
    );
    const closed = completion();
    let leases = 0;
    let inspectionEntered = () => {};

    const inspected = new Promise<void>((resolve) => {
      inspectionEntered = resolve;
    });

    const native = createHousekeepingHost({
      dataDir: path.join(root, "data"),
      retainWorker: () => {
        throw new Error("This fixture requires an active SDK worker lease.");
      },
      inspectTemps: async () => {
        inspectionEntered();

        return [];
      },
    });

    const preview = await native.adapterPreview(source);

    const registration = await native.adapterAdopt({
      revision: preview.revision,
      previewDigest: preview.previewDigest,
    });

    const controller = new AbortController();

    const entry = experimental_defineHostEntry({
      contract: defineRpcContract({
        start: housekeepingHostContract.housekeepingHostStart,
      }),
      handlers: {
        async start(input, context) {
          const result = await native.start(input, () => {
            const lease = context.experimental_retainWorker();
            leases++;

            return {
              dispose() {
                void lease.dispose().then(() => {
                  leases--;
                  closed.resolve();
                });
              },
            };
          });

          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else
              context.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });

          return result;
        },
      },
    });

    const harness = experimental_createHostEntryHarness(entry);

    const request = run({
      mode: "preview",
      registrationRevision: registration.revision,
      bindingsDigest: registration.bindingsDigest,
    });

    const launch = harness.experimental_call(
      "start",
      { run: request },
      { signal: controller.signal },
    );

    await inspected;
    controller.abort();
    await launch;
    expect(leases).toBe(1);
    await closed.promise;
    expect(leases).toBe(0);
    expect(
      await fs.readFile(
        path.join(root, "data", "housekeeping-v1", "child-finished"),
        "utf8",
      ),
    ).toBe("finished");
    expect(await native.run({ id: request.id })).toMatchObject({
      state: "completed",
      stages: [
        { name: "process-private-temp", state: "complete" },
        { name: "periodic", state: "complete" },
      ],
    });
    await harness.experimental_dispose();
  },
);

it.runIf(process.platform === "darwin")(
  "a failed process temporary stage stays held while local policy stages still run",
  async () => {
    const root = await directory();
    const source = await sourceFixture(root);
    await fs.writeFile(
      path.join(source.sourceDirectory, "housekeeping.py"),
      [
        "import json, sys",
        "args = dict(zip(sys.argv[2::2], sys.argv[3::2]))",
        "result = {'schema': 1, 'runId': args['--run-id'], 'state': 'completed', 'reason': None, 'bindingsDigest': args['--expected-bindings'], 'stages': [{'name': 'worktrees', 'state': 'complete', 'reason': None, 'items': 2, 'bytes': 2048}], 'reserved': {'items': 0, 'bytes': 0}}",
        "print(json.dumps(result))",
      ].join("\n"),
    );
    const closed = completion();
    let recoveries = 0;

    const native = createHousekeepingHost({
      dataDir: path.join(root, "data"),
      retainWorker: () => ({
        dispose() {
          closed.resolve();
        },
      }),
      recoverTemps: async () => {
        recoveries++;
        throw new Error("ENOENT: journal closed during the scan");
      },
    });

    const preview = await native.adapterPreview(source);

    const registration = await native.adapterAdopt({
      revision: preview.revision,
      previewDigest: preview.previewDigest,
    });

    const request = run({
      registrationRevision: registration.revision,
      bindingsDigest: registration.bindingsDigest,
    });

    await native.start({ run: request });
    await closed.promise;
    const state = await native.state();
    expect(state.currentRun).toBeNull();
    expect(state.lastRun).toMatchObject({
      id: request.id,
      state: "held",
      reserved: { items: 0, bytes: 0 },
      stages: [
        {
          name: "process-private-temp",
          state: "held",
          items: null,
          bytes: null,
          reason: expect.stringContaining(
            "ENOENT: journal closed during the scan",
          ),
        },
        { name: "worktrees", state: "complete", items: 2, bytes: 2048 },
      ],
    });
    expect(recoveries).toBe(1);
  },
);

it.runIf(process.platform === "darwin").each([
  {
    label: "native",
    stageName: "devtools",
    reserved: { items: 0, bytes: 0 },
    terminal: true,
  },
  {
    label: "shared",
    stageName: "periodic",
    reserved: { items: 17, bytes: 1024 },
    terminal: false,
  },
])(
  "preserves authoritative $label reservations and future admission across restart",
  async ({ stageName, reserved, terminal }) => {
    const root = await directory();
    const source = await sourceFixture(root);

    const receipt = {
      schema: 1,
      state: "held",
      reason: "stage-outcome-requires-reconciliation",
      stages: [
        {
          name: stageName,
          state: "held",
          reason: "Removal accounting is unavailable.",
          items: null,
          bytes: null,
          uncertain: true,
          reportPath: "/private/report",
          childPid: 123,
          reservation: reserved,
        },
      ],
      reserved,
    };

    await fs.writeFile(
      path.join(source.sourceDirectory, "housekeeping.py"),
      [
        "import json, sys",
        "args = dict(zip(sys.argv[2::2], sys.argv[3::2]))",
        `result = json.loads(${JSON.stringify(JSON.stringify(receipt))})`,
        "result.update(runId=args['--run-id'], bindingsDigest=args['--expected-bindings'])",
        "print(json.dumps(result))",
      ].join("\n"),
    );
    const closed = completion();

    const native = createHousekeepingHost({
      dataDir: path.join(root, "data"),
      retainWorker: () => ({
        dispose() {
          closed.resolve();
        },
      }),
      recoverTemps: async () => [],
    });

    const preview = await native.adapterPreview(source);

    const registration = await native.adapterAdopt({
      revision: 0,
      previewDigest: preview.previewDigest,
    });

    const request = run({
      registrationRevision: registration.revision,
      bindingsDigest: registration.bindingsDigest,
    });

    await native.start({ run: request });
    await closed.promise;
    const first = await native.state();
    const observed = terminal ? first.lastRun : first.currentRun;
    expect(observed).toMatchObject({
      state: "held",
      reserved,
      stages: [
        { name: "process-private-temp" },
        {
          name: stageName,
          items: null,
          bytes: null,
          reason: "Removal accounting is unavailable.",
        },
      ],
    });

    if (terminal) expect(first.currentRun).toBeNull();
    expect(observed?.stages[1]).not.toHaveProperty("reportPath");
    expect(observed?.stages[1]).not.toHaveProperty("childPid");

    const restarted = createHousekeepingHost({
      dataDir: path.join(root, "data"),
      retainWorker: () => ({ dispose() {} }),
      recoverTemps: async () => [],
    });

    const status = await restarted.state();
    expect(terminal ? status.lastRun : status.currentRun).toMatchObject({
      id: request.id,
      state: "held",
      reserved,
    });

    const next = run({
      registrationRevision: registration.revision,
      bindingsDigest: registration.bindingsDigest,
    });

    if (terminal) {
      expect(status.currentRun).toBeNull();
      const nextClosed = completion();
      expect(
        await restarted.start({ run: next }, () => ({
          dispose() {
            nextClosed.resolve();
          },
        })),
      ).toMatchObject({ id: next.id, state: "planned" });
      await nextClosed.promise;
      expect((await restarted.state()).lastRun?.id).toBe(next.id);
    } else
      await expect(restarted.start({ run: next })).rejects.toThrow(
        "already active",
      );
  },
);

it
  .runIf(process.platform === "darwin")
  .each([
    "zero-reservation",
    "shared-reservation",
    "wrong-run",
    "wrong-binding",
    "running-state",
    "running-stage",
    "symlink",
    "hardlink",
    "missing",
    "malformed-reservation",
    "oversized",
  ])(
  "source drift accepts only a bound physical terminal receipt: %s",
  async (variant) => {
    const root = await directory();
    const source = await sourceFixture(root);
    const dataDir = path.join(root, "data");

    const native = createHousekeepingHost({
      dataDir,
      retainWorker: () => ({ dispose() {} }),
    });

    const preview = await native.adapterPreview(source);

    const registration = await native.adapterAdopt({
      revision: 0,
      previewDigest: preview.previewDigest,
    });

    const pending = run({
      registrationRevision: registration.revision,
      bindingsDigest: registration.bindingsDigest,
      state: "held",
      reserved: { items: 100, bytes: 10 * 1024 ** 3 },
      stages: [
        {
          name: "local-policy",
          state: "running",
          reason: null,
          items: null,
          bytes: null,
        },
      ],
    });

    const stateDirectory = path.join(dataDir, "housekeeping-v1");
    await fs.writeFile(
      path.join(stateDirectory, "state.json"),
      JSON.stringify({
        registration,
        currentRun: pending,
        lastRun: null,
        preview: null,
      }),
    );

    const receipt = {
      schema: 1,
      runId: variant === "wrong-run" ? randomUUID() : pending.id,
      state: variant === "running-state" ? "running" : "held",
      bindingsDigest:
        variant === "wrong-binding"
          ? "f".repeat(64)
          : registration.bindingsDigest,
      reason: "The native stage outcome remains unknown.",
      stages: [
        {
          name: "simulators",
          state: variant === "running-stage" ? "running" : "held",
          reason:
            "The original native outcome remains unknown and must not replay.",
          items: null,
          bytes: null,
          uncertain: true,
        },
      ],
      reserved:
        variant === "shared-reservation"
          ? { items: 17, bytes: 1024 }
          : variant === "malformed-reservation"
            ? { items: -1, bytes: 0 }
            : { items: 0, bytes: 0 },
    };

    const text =
      JSON.stringify(receipt) +
      (variant === "oversized" ? " ".repeat(1024 * 1024) : "");

    const receiptPath = path.join(stateDirectory, `${pending.id}.json`);

    if (variant === "symlink" || variant === "hardlink") {
      const external = path.join(root, "external-receipt.json");
      await fs.writeFile(external, text);

      if (variant === "symlink") await fs.symlink(external, receiptPath);
      else await fs.link(external, receiptPath);
    } else if (variant !== "missing") await fs.writeFile(receiptPath, text);
    await fs.appendFile(
      path.join(source.sourceDirectory, "cleanup.py"),
      "source changed\n",
    );
    const result = await native.state();

    if (variant === "zero-reservation") {
      expect(result.currentRun).toBeNull();
      expect(result.lastRun).toMatchObject({
        id: pending.id,
        state: "held",
        reserved: { items: 0, bytes: 0 },
        reason: expect.stringContaining(
          "Recovered the original source-bound terminal receipt",
        ),
        stages: [
          {
            name: "simulators",
            state: "held",
            reason:
              "The original native outcome remains unknown and must not replay.",
          },
        ],
      });
    } else if (variant === "shared-reservation")
      expect(result.currentRun).toMatchObject({
        id: pending.id,
        state: "held",
        reserved: { items: 17, bytes: 1024 },
        reason: expect.stringContaining(
          "Recovered the original source-bound terminal receipt",
        ),
      });
    else
      expect(result.currentRun).toMatchObject({
        id: pending.id,
        state: "held",
        reserved: pending.reserved,
        reason:
          "The registered run could not be reconciled. Its reservations remain held.",
      });

    if (variant !== "missing")
      expect(await fs.readFile(receiptPath, "utf8")).toBe(text);
  },
);
