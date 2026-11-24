import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginEnvironmentProviderCreateContext,
  PluginEnvironmentProviderRemoveContext,
} from "@omnyo/plugin-sdk/environment-provider";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  type FakePluginHarness,
} from "@omnyo/plugin-sdk/testing";
import type { PluginEnvironmentProviderRequirements } from "@omnyo/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fileKeySchema } from "./contract.js";
import { TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";
import plugin, { temporaryCopyInputsSchema } from "./server.js";

type HostRpcCall = FakePluginHarness["experimental_hostRpcCalls"][number];

const ORIGIN = "host-origin";

const TARGET = "host-target";

const THREAD_ID = "thr_1";

const SOURCE_PATH = "/checkouts/app";

const COPY_PATH = "/data/plugins/environment-temporary-copy/copies/thr_1";

const COMMIT = "a".repeat(40);

const TIP = "b".repeat(40);

const SHA = "c".repeat(64);

const ORIGIN_TIP = "d".repeat(40);

const ORIGIN_CHECKOUT = "/data/origin-checkouts/thr_1";

const KEPT_REF = `refs/omnyo/temporary-copy/thr_1/origin-HEAD`;

const RECORD = {
  threadId: THREAD_ID,
  sourceHostId: ORIGIN,
  sourcePath: SOURCE_PATH,
  targetHostId: TARGET,
  path: COPY_PATH,
  branch: "omnyo/plan-thr_1",
  baseRef: `omnyo-base/${THREAD_ID}`,
  baseCommit: COMMIT,
};

type Responder = (call: HostRpcCall) => unknown;

function hostResponder(overrides: Record<string, Responder> = {}): Responder {
  const defaults: Record<string, Responder> = {
    createSnapshot: () => ({ commit: COMMIT, size: 10, sha256: SHA }),
    readRelay: () => ({ dataBase64: "AAAA", sha256: SHA }),
    appendRelay: () => ({ ok: true }),
    deleteRelay: () => ({ ok: true }),
    materialize: () => ({ path: COPY_PATH }),
    prepareCopyBack: () => ({
      refs: [
        { name: "refs/heads/omnyo/plan-thr_1", sha: TIP },
        { name: "HEAD", sha: TIP },
      ],
      unsaved: null,
      size: 10,
      sha256: SHA,
    }),
    prepareOriginCheckout: () => ({ path: ORIGIN_CHECKOUT, kept: null }),
    readOriginCheckout: () => ({
      head: TIP,
      changes: [],
      newCommits: false,
      keptAt: null,
    }),
    writeOriginPack: () => ({ size: 10, sha256: SHA }),
    applyOriginPack: () => ({ fastForwarded: true }),
    removeOriginCheckout: () => ({ kept: null }),
    applyCopyBack: () => ({
      sideRefs: [
        {
          name: `refs/omnyo/temporary-copy/${THREAD_ID}/heads/omnyo/plan-thr_1`,
          sha: TIP,
        },
      ],
      branchUpdated: true,
    }),
    confirmCopyBack: () => ({ confirmed: true }),
    inspectCopy: () => ({ exists: true }),
    listSideRefs: () => ({ shas: [TIP] }),
    removeCopy: () => ({ ok: true }),
  };

  return (call) => {
    const respond = overrides[call.method] ?? defaults[call.method];

    if (respond === undefined) throw new Error(`unexpected ${call.method}`);

    return respond(call);
  };
}

type StepStatus = "exited" | "running" | "disconnected";

interface TerminalScript {
  output: string;
  exitCode: number | null;
  status: "exited" | "running";
  listed?: Array<{ id: string; status: StepStatus }>;
  listCreated?: boolean;
}

function terminalSession(id: string, status: StepStatus = "running") {
  return {
    id,
    threadId: null,
    environmentId: null,
    hostId: ORIGIN,
    title: "Step",
    initialCwd: ORIGIN_CHECKOUT,
    cols: 160,
    rows: 48,
    status,
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
  };
}

async function setup(
  responder: Responder = hostResponder(),
  script: TerminalScript = { output: "", exitCode: 0, status: "exited" },
) {
  const created: string[] = [];

  const { api, harness } = createFakePluginHost({
    experimental_callHostRpc: responder,
    sdk: {
      terminals: {
        create: async () => {
          const id = `term_${created.length + 1}`;
          created.push(id);

          return terminalSession(id);
        },
        output: async ({ sinceSeq }) => ({
          chunks:
            sinceSeq === 0 && script.output !== ""
              ? [
                  {
                    seq: 1,
                    dataBase64: Buffer.from(script.output).toString("base64"),
                  },
                ]
              : [],
          nextSeq: 2,
          truncated: false,
          status: script.status,
          exitCode: script.exitCode,
          closeReason: null,
        }),
        close: async ({ terminalId }) => terminalSession(terminalId),
        list: async () => ({
          sessions: script.listCreated
            ? created.map((id) => terminalSession(id, script.status))
            : (script.listed ?? []).map((entry) =>
                terminalSession(entry.id, entry.status),
              ),
        }),
      },
      hosts: {
        list: async () => [
          makeHostResponse({ id: ORIGIN, name: "Pro" }),
          makeHostResponse({ id: TARGET, name: "Air" }),
        ],
      },
    },
  });

  await plugin(api);

  const provider = harness.registrations.environmentProviders.get(
    TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID,
  );

  if (provider === undefined) throw new Error("Provider not registered");

  const createContext: PluginEnvironmentProviderCreateContext<
    PluginEnvironmentProviderRequirements,
    typeof temporaryCopyInputsSchema
  > = {
    thread: makeThreadResponse({ id: THREAD_ID, projectId: "proj-a" }),
    project: {
      id: "proj-a",
      kind: "standard",
      name: "app",
      gitRemoteUrl: null,
      createdAt: 1,
      updatedAt: 1,
    },
    host: makeHostResponse({ id: TARGET, name: "Air" }),
    projectCheckout: null,
    gitRemote: null,
    inputs: {
      sourceHostId: ORIGIN,
      sourcePath: SOURCE_PATH,
      worktree: { branch: { kind: "default" } },
    },
    suggestedBranchName: "omnyo/plan-thr_1",
    attempt: 1,
    pathKey: THREAD_ID,
    experimental_claimPath: async () => true,
    report: { step: () => undefined, log: () => undefined },
    signal: new AbortController().signal,
  };

  const removeContext: PluginEnvironmentProviderRemoveContext = {
    environment: null,
    hostId: TARGET,
    path: COPY_PATH,
    pathKey: THREAD_ID,
    resource: RECORD,
    attempt: 1,
    report: { step: () => undefined, log: () => undefined },
    signal: new AbortController().signal,
  };

  return { api, harness, provider, createContext, removeContext };
}

function calls(harness: FakePluginHarness) {
  return harness.experimental_hostRpcCalls.map(
    (call) => `${call.method}@${call.hostId}`,
  );
}

function prepareInput(harness: FakePluginHarness) {
  return harness.experimental_hostRpcCalls.find(
    (call) => call.method === "prepareCopyBack",
  )?.input;
}

describe("temporary copy provider", () => {
  it("snapshots on the original machine and builds the copy on the free one", async () => {
    const { api, harness, provider, createContext } = await setup();

    await expect(provider.create(createContext)).resolves.toEqual({
      status: "created",
      path: COPY_PATH,
      ownsPath: true,
      mergeBaseBranch: `omnyo-base/${THREAD_ID}`,
      resource: RECORD,
    });
    expect(calls(harness)).toEqual([
      `createSnapshot@${ORIGIN}`,
      `readRelay@${ORIGIN}`,
      `appendRelay@${TARGET}`,
      `materialize@${TARGET}`,
      `deleteRelay@${ORIGIN}`,
      `deleteRelay@${TARGET}`,
    ]);
    await expect(api.storage.kv.get(`copy:${THREAD_ID}`)).resolves.toEqual(
      RECORD,
    );
  });

  it("retries a failed chunk once", async () => {
    let appends = 0;

    const { provider, createContext } = await setup(
      hostResponder({
        appendRelay: () => {
          appends += 1;

          if (appends === 1) throw new Error("connection reset");

          return { ok: true };
        },
      }),
    );

    await expect(provider.create(createContext)).resolves.toMatchObject({
      status: "created",
    });
    expect(appends).toBe(2);
  });

  it("fails visibly when the original machine cannot be reached", async () => {
    const { harness, provider, createContext } = await setup(
      hostResponder({
        createSnapshot: () => {
          throw new Error("host offline");
        },
      }),
    );

    await expect(provider.create(createContext)).resolves.toEqual({
      status: "failed",
      message: "Could not copy the project: host offline",
    });
    expect(calls(harness)).not.toContain(`materialize@${TARGET}`);
  });

  it("deletes the copy only after the original machine confirms every ref", async () => {
    const { api, harness, provider, removeContext } = await setup();
    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    await expect(provider.remove(removeContext)).resolves.toEqual({
      status: "removed",
    });
    expect(calls(harness)).toEqual([
      `inspectCopy@${TARGET}`,
      `listSideRefs@${ORIGIN}`,
      `prepareCopyBack@${TARGET}`,
      `readRelay@${TARGET}`,
      `appendRelay@${ORIGIN}`,
      `applyCopyBack@${ORIGIN}`,
      `deleteRelay@${TARGET}`,
      `deleteRelay@${ORIGIN}`,
      `confirmCopyBack@${ORIGIN}`,
      `removeOriginCheckout@${ORIGIN}`,
      `removeCopy@${TARGET}`,
    ]);
    expect(prepareInput(harness)).toMatchObject({
      recordUnsaved: true,
      haves: [TIP],
    });
    await expect(
      api.storage.kv.get(`copy:${THREAD_ID}`),
    ).resolves.toBeUndefined();
  });

  it("tells only chats in a copy how to run steps on the original machine", async () => {
    const { harness, provider, createContext } = await setup();
    const instructions = harness.registrations.instructionProvider;

    if (instructions === null) throw new Error("No instructions provider");

    expect(instructions({ threadId: THREAD_ID, projectId: "proj-a" })).toBe(
      null,
    );

    await provider.create(createContext);

    const text = instructions({ threadId: THREAD_ID, projectId: "proj-a" });

    expect(text).toContain(
      "This chat runs in a temporary copy on Air; its original checkout is on Pro.",
    );
    expect(text).toContain(
      'omnyo temporary-copy run "$OMNYO_THREAD_ID" -- <command>',
    );
    expect(text?.length).toBeLessThanOrEqual(4096);
    expect(instructions({ threadId: "thr_other", projectId: "proj-a" })).toBe(
      null,
    );
  });

  it("accepts only plain file keys from the server", () => {
    expect(fileKeySchema.safeParse("thr_1-2").success).toBe(true);
    expect(fileKeySchema.safeParse("..").success).toBe(false);
    expect(fileKeySchema.safeParse(".").success).toBe(false);
    expect(fileKeySchema.safeParse("a/b").success).toBe(false);
  });

  it("keeps a copy whose saved details it cannot read", async () => {
    const { harness, provider, removeContext } = await setup();

    await expect(
      provider.remove({ ...removeContext, resource: { threadId: THREAD_ID } }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(calls(harness)).not.toContain(`removeCopy@${TARGET}`);
  });

  it("deletes a copy it built when saving its record fails", async () => {
    const { api, harness, provider, createContext } = await setup();
    vi.spyOn(api.storage.kv, "set").mockRejectedValueOnce(
      new Error("storage full"),
    );

    await expect(provider.create(createContext)).resolves.toMatchObject({
      status: "failed",
    });
    expect(calls(harness)).toContain(`removeCopy@${TARGET}`);
    await expect(
      api.storage.kv.get(`copy:${THREAD_ID}`),
    ).resolves.toBeUndefined();
  });

  it("finishes a removal whose copy is already gone", async () => {
    const { api, harness, provider, removeContext } = await setup(
      hostResponder({ inspectCopy: () => ({ exists: false }) }),
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    await expect(provider.remove(removeContext)).resolves.toEqual({
      status: "removed",
    });
    expect(calls(harness)).toEqual([
      `inspectCopy@${TARGET}`,
      `removeOriginCheckout@${ORIGIN}`,
    ]);
    await expect(
      api.storage.kv.get(`copy:${THREAD_ID}`),
    ).resolves.toBeUndefined();
  });

  it("resumes an interrupted deletion without copying back again", async () => {
    let removals = 0;

    const { api, harness, provider, removeContext } = await setup(
      hostResponder({
        removeCopy: () => {
          removals += 1;

          if (removals === 1) throw new Error("connection reset");

          return { ok: true };
        },
      }),
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    await expect(provider.remove(removeContext)).resolves.toEqual({
      status: "failed",
      message:
        "This chat's work is safe on its original machine, but deleting the temporary copy failed: connection reset",
    });
    await expect(api.storage.kv.get(`copy:${THREAD_ID}`)).resolves.toEqual({
      ...RECORD,
      removalConfirmedAt: expect.any(Number),
    });

    const firstAttempt = calls(harness).length;

    await expect(provider.remove(removeContext)).resolves.toEqual({
      status: "removed",
    });
    expect(calls(harness).slice(firstAttempt)).toEqual([
      `inspectCopy@${TARGET}`,
      `removeOriginCheckout@${ORIGIN}`,
      `removeCopy@${TARGET}`,
    ]);
    await expect(
      api.storage.kv.get(`copy:${THREAD_ID}`),
    ).resolves.toBeUndefined();
  });

  const removalFailures: Array<{
    name: string;
    overrides: Record<string, Responder>;
  }> = [
    {
      name: "the work cannot be confirmed",
      overrides: { confirmCopyBack: () => ({ confirmed: false }) },
    },
    {
      name: "the original machine is offline",
      overrides: {
        applyCopyBack: () => {
          throw new Error("host offline");
        },
      },
    },
  ];

  it.each(removalFailures)(
    "keeps the copy when $name",
    async ({ overrides }) => {
      const { api, harness, provider, removeContext } = await setup(
        hostResponder(overrides),
      );

      await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

      await expect(provider.remove(removeContext)).resolves.toMatchObject({
        status: "failed",
      });
      expect(calls(harness)).not.toContain(`removeCopy@${TARGET}`);
      await expect(api.storage.kv.get(`copy:${THREAD_ID}`)).resolves.toEqual(
        RECORD,
      );
    },
  );

  it("copies commits back after a turn ends", async () => {
    const { api, harness } = await setup();
    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD_ID }),
      lastAssistantText: null,
    });

    await vi.waitFor(() =>
      expect(calls(harness)).toContain(`applyCopyBack@${ORIGIN}`),
    );
    expect(prepareInput(harness)).toMatchObject({ recordUnsaved: false });
  });

  it("syncs on demand from the CLI", async () => {
    const { api, harness } = await setup();
    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    await expect(
      harness.behavior.runCli(["sync", THREAD_ID]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: `Copied to omnyo/plan-thr_1 in ${SOURCE_PATH} on the original machine.`,
    });
    await expect(
      harness.behavior.runCli(["sync", "thr_other"]),
    ).resolves.toMatchObject({
      exitCode: 1,
    });
  });
});

describe("running a step on the original machine", () => {
  it("syncs, runs the command there and reports the result", async () => {
    const { api, harness } = await setup(hostResponder(), {
      output: "Xcode 27.1\n",
      exitCode: 0,
      status: "exited",
    });

    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "xcodebuild -version",
    ]);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("Xcode 27.1");
    expect(result.stdout).toContain(
      `Ran on Pro in ${ORIGIN_CHECKOUT}: exit 0.`,
    );
    expect(harness.sdk.callsTo("terminals.create")).toEqual([
      [
        {
          cols: 160,
          rows: 48,
          title: `Step for ${THREAD_ID}`,
          scope: { kind: "host_path", hostId: ORIGIN, cwd: ORIGIN_CHECKOUT },
          start: {
            mode: "command",
            command: expect.stringMatching(
              /^export OMNYO_THREAD_ID=thr_1;[\s\S]*; xcodebuild -version$/u,
            ),
          },
        },
      ],
    ]);
    expect(prepareInput(harness)).toMatchObject({ recordUnsaved: true });
    expect(calls(harness)).toContain(`prepareOriginCheckout@${ORIGIN}`);
    expect(calls(harness)).not.toContain(`writeOriginPack@${ORIGIN}`);
    await expect(api.storage.kv.get(`copy:${THREAD_ID}`)).resolves.toEqual({
      ...RECORD,
      originCheckout: ORIGIN_CHECKOUT,
      originBase: TIP,
    });
  });

  it("brings back commits the command made and passes on its exit code", async () => {
    const { api, harness } = await setup(
      hostResponder({
        readOriginCheckout: () => ({
          head: ORIGIN_TIP,
          changes: ["dist/x"],
          newCommits: true,
          keptAt: KEPT_REF,
        }),
      }),
      { output: "released\n", exitCode: 3, status: "exited" },
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "pnpm",
      "private:ship",
      "--version",
      "1.0.0+private.1",
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain(
      `Brought back the commits it made; this copy is now at ${ORIGIN_TIP.slice(0, 12)}.`,
    );
    expect(result.stdout).toContain(
      "Uncommitted changes it left on Pro, not copied back: dist/x.",
    );
    expect(calls(harness)).toEqual(
      expect.arrayContaining([
        `writeOriginPack@${ORIGIN}`,
        `applyOriginPack@${TARGET}`,
      ]),
    );
    expect(
      harness.experimental_hostRpcCalls.find(
        (call) => call.method === "applyOriginPack",
      )?.input,
    ).toMatchObject({ tip: ORIGIN_TIP, expectedHead: TIP });
    expect(harness.sdk.callsTo("terminals.create")[0]?.[0]).toMatchObject({
      start: {
        command: expect.stringContaining(
          "; pnpm private:ship --version 1.0.0+private.1",
        ),
      },
    });
  });

  it("returns at once with the terminal id when detached, and pulls later", async () => {
    const { api, harness } = await setup(
      hostResponder({
        readOriginCheckout: () => ({
          head: ORIGIN_TIP,
          changes: [],
          newCommits: true,
          keptAt: KEPT_REF,
        }),
      }),
      { output: "", exitCode: null, status: "running" },
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    const started = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--detach",
      "--",
      "xcodebuild test",
    ]);

    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain("as terminal term_1");
    expect(harness.sdk.callsTo("terminals.output")).toEqual([]);

    const pulled = await harness.behavior.runCli(["pull", THREAD_ID]);

    expect(pulled).toMatchObject({ exitCode: 0 });
    expect(pulled.stdout).toContain(
      `this copy is now at ${ORIGIN_TIP.slice(0, 12)}`,
    );
  });

  it("fails visibly when the original machine cannot be reached", async () => {
    const { api, harness } = await setup(
      hostResponder({
        prepareOriginCheckout: () => {
          throw new Error("host offline");
        },
      }),
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "xcodebuild -version",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("host offline");
    expect(harness.sdk.callsTo("terminals.create")).toEqual([]);
  });

  it("refuses a new step while an earlier one still runs", async () => {
    const { api, harness } = await setup(hostResponder(), {
      output: "",
      exitCode: 0,
      status: "exited",
      listed: [{ id: "term_busy", status: "running" }],
    });

    await api.storage.kv.set(`copy:${THREAD_ID}`, {
      ...RECORD,
      originCheckout: ORIGIN_CHECKOUT,
      originBase: TIP,
    });

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "xcodebuild -version",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "still running on Pro as terminal term_busy",
    );
    expect(calls(harness)).not.toContain(`prepareCopyBack@${TARGET}`);
  });

  it("brings back commits an earlier step made before resetting the checkout", async () => {
    let reads = 0;

    const { api, harness } = await setup(
      hostResponder({
        readOriginCheckout: () => {
          reads += 1;

          return reads === 1
            ? {
                head: ORIGIN_TIP,
                changes: [],
                newCommits: true,
                keptAt: KEPT_REF,
              }
            : { head: TIP, changes: [], newCommits: false, keptAt: null };
        },
      }),
      {
        output: "ok\n",
        exitCode: 0,
        status: "exited",
        listed: [{ id: "term_done", status: "exited" }],
      },
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, {
      ...RECORD,
      originCheckout: ORIGIN_CHECKOUT,
      originBase: TIP,
    });

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "true",
    ]);

    const order = calls(harness);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Before running: Brought back the commits");
    expect(order.indexOf(`applyOriginPack@${TARGET}`)).toBeLessThan(
      order.indexOf(`prepareCopyBack@${TARGET}`),
    );
    expect(harness.sdk.callsTo("terminals.close")).toEqual([
      [{ terminalId: "term_done", mode: "force" }],
    ]);
  });

  it("removes the original-machine checkout before the copy", async () => {
    const { api, harness, provider, removeContext } = await setup(
      hostResponder(),
      {
        output: "",
        exitCode: 0,
        status: "exited",
        listed: [{ id: "term_old", status: "running" }],
      },
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, {
      ...RECORD,
      originCheckout: ORIGIN_CHECKOUT,
      originBase: TIP,
    });

    await expect(provider.remove(removeContext)).resolves.toEqual({
      status: "removed",
    });

    const order = calls(harness);

    expect(order.indexOf(`removeOriginCheckout@${ORIGIN}`)).toBeLessThan(
      order.indexOf(`removeCopy@${TARGET}`),
    );
    expect(harness.sdk.callsTo("terminals.list")).toEqual([
      [{ scope: { kind: "host_path", hostId: ORIGIN, cwd: ORIGIN_CHECKOUT } }],
    ]);
    expect(harness.sdk.callsTo("terminals.close")).toEqual([
      [{ terminalId: "term_old", mode: "force" }],
    ]);
  });
});

describe("keeping original-machine steps safe", () => {
  const WITH_CHECKOUT = {
    ...RECORD,
    originCheckout: ORIGIN_CHECKOUT,
    originBase: TIP,
  };

  const INCOMPLETE =
    "The step's commits build on history this copy does not have, so they cannot come back here.";

  const cannotComeBack = hostResponder({
    readOriginCheckout: () => ({
      head: ORIGIN_TIP,
      changes: [],
      newCommits: true,
      keptAt: KEPT_REF,
    }),
    applyOriginPack: () => {
      throw new Error(INCOMPLETE);
    },
  });

  it("reads the copy's record inside its queue, so a second first step waits for the first", async () => {
    const { api, harness } = await setup(hostResponder(), {
      output: "",
      exitCode: null,
      status: "running",
      listCreated: true,
    });

    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    const [first, second] = await Promise.all([
      harness.behavior.runCli(["run", THREAD_ID, "--detach", "--", "build"]),
      harness.behavior.runCli(["run", THREAD_ID, "--detach", "--", "true"]),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain("still running on Pro as terminal term_1");
    expect(harness.sdk.callsTo("terminals.create")).toHaveLength(1);
  });

  it("treats a step whose machine lost its connection as still running", async () => {
    const { api, harness } = await setup(hostResponder(), {
      output: "",
      exitCode: 0,
      status: "exited",
      listed: [{ id: "term_lost", status: "disconnected" }],
    });

    await api.storage.kv.set(`copy:${THREAD_ID}`, WITH_CHECKOUT);

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "true",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "lost its connection as terminal term_lost",
    );
    expect(harness.sdk.callsTo("terminals.close")).toEqual([]);
    expect(calls(harness)).not.toContain(`prepareOriginCheckout@${ORIGIN}`);
  });

  it("still runs a new step when an earlier step's commits cannot come back, and says where they are kept", async () => {
    const { api, harness } = await setup(cannotComeBack, {
      output: "ok\n",
      exitCode: 0,
      status: "exited",
      listed: [{ id: "term_done", status: "exited" }],
    });

    await api.storage.kv.set(`copy:${THREAD_ID}`, WITH_CHECKOUT);

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "true",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Before running: Could not bring back the commits the earlier step made: ${INCOMPLETE} They are kept at ${KEPT_REF} in ${SOURCE_PATH} on Pro.`,
    );
    expect(harness.sdk.callsTo("terminals.create")).toHaveLength(1);
  });

  it("keeps the command's exit code and says where its commits are kept when they cannot come back", async () => {
    const { api, harness } = await setup(cannotComeBack, {
      output: "pushed\n",
      exitCode: 0,
      status: "exited",
    });

    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "git push",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Could not bring back the commits it made: ${INCOMPLETE} They are kept at ${KEPT_REF} in ${SOURCE_PATH} on Pro.`,
    );
  });

  it("lists uncommitted changes an earlier step left even when no commits came back", async () => {
    const { api, harness } = await setup(
      hostResponder({
        readOriginCheckout: () => ({
          head: TIP,
          changes: ["left.txt"],
          newCommits: false,
          keptAt: null,
        }),
      }),
      {
        output: "",
        exitCode: 0,
        status: "exited",
        listed: [{ id: "term_done", status: "exited" }],
      },
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, WITH_CHECKOUT);

    const text = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "true",
    ]);

    expect(text.stdout).toContain(
      "Before running: The earlier step's uncommitted changes on Pro were discarded: left.txt.",
    );

    const json = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--json",
      "--",
      "true",
    ]);

    expect(JSON.parse(json.stdout)).toMatchObject({
      earlier: { pull: { changes: ["left.txt"] }, error: null, kept: null },
    });
  });

  it("refuses a pull while a step still runs", async () => {
    const { api, harness } = await setup(hostResponder(), {
      output: "",
      exitCode: null,
      status: "running",
      listed: [{ id: "term_busy", status: "running" }],
    });

    await api.storage.kv.set(`copy:${THREAD_ID}`, WITH_CHECKOUT);

    const result = await harness.behavior.runCli(["pull", THREAD_ID]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "still running on Pro as terminal term_busy",
    );
    expect(calls(harness)).not.toContain(`readOriginCheckout@${ORIGIN}`);
  });

  it("refuses to run while the copy is being removed", async () => {
    const { api, harness } = await setup();

    await api.storage.kv.set(`copy:${THREAD_ID}`, {
      ...WITH_CHECKOUT,
      removalConfirmedAt: 1,
    });

    const result = await harness.behavior.runCli([
      "run",
      THREAD_ID,
      "--",
      "true",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("is being removed");
    expect(calls(harness)).toEqual([]);
  });

  it("finishes a removal before a step queued behind it starts", async () => {
    const { api, harness, provider, removeContext } = await setup();
    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    const removal = provider.remove(removeContext);
    const run = harness.behavior.runCli(["run", THREAD_ID, "--", "true"]);

    await expect(removal).resolves.toEqual({ status: "removed" });

    const result = await run;

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("is not running in a temporary copy");
    expect(calls(harness)).not.toContain(`prepareOriginCheckout@${ORIGIN}`);
  });

  it("removes the original-machine checkout even when no run was recorded", async () => {
    const { api, harness, provider, removeContext } = await setup();
    await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);

    await expect(provider.remove(removeContext)).resolves.toEqual({
      status: "removed",
    });
    expect(
      harness.experimental_hostRpcCalls.find(
        (call) => call.method === "removeOriginCheckout",
      )?.input,
    ).toEqual({ sourcePath: SOURCE_PATH, threadId: THREAD_ID });
    expect(harness.sdk.callsTo("terminals.list")).toEqual([]);
  });

  it("keeps the copy while a step's machine is reconnecting", async () => {
    const { api, harness, provider, removeContext } = await setup(
      hostResponder(),
      {
        output: "",
        exitCode: 0,
        status: "exited",
        listed: [{ id: "term_lost", status: "disconnected" }],
      },
    );

    await api.storage.kv.set(`copy:${THREAD_ID}`, WITH_CHECKOUT);

    await expect(provider.remove(removeContext)).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining(
        "lost its connection as terminal term_lost",
      ),
    });
    expect(calls(harness)).not.toContain(`removeOriginCheckout@${ORIGIN}`);
    expect(calls(harness)).not.toContain(`removeCopy@${TARGET}`);
    expect(harness.sdk.callsTo("terminals.close")).toEqual([]);
  });
});

const terminalCommandRequestSchema = z.object({
  scope: z.object({ kind: z.literal("host_path"), cwd: z.string() }),
  start: z.object({ mode: z.literal("command"), command: z.string() }),
});

describe("finite setup hook owner V1", () => {
  it.each(["canonical", "legacy", "dual"])(
    "executes %s setup ownership before the requested command",
    async (kind) => {
      const path = await realpath(
        await mkdtemp(join(tmpdir(), "omnyo-copy-hook-")),
      );

      const canonical = join(path, ".omnyo-env-setup.sh");
      const legacy = join(path, ".bb-env-setup.sh");
      const files: { path: string; bytes: Buffer; mode: number }[] = [];

      try {
        for (const value of ["canonical", "legacy"]) {
          const file = value === "canonical" ? canonical : legacy;

          if (kind !== "dual" && value !== kind) continue;
          await writeFile(file, `printf '${value}' > hook-ran\n`, {
            mode: 0o600,
          });
          files.push({
            path: file,
            bytes: await readFile(file),
            mode: (await stat(file)).mode,
          });
        }

        const { api, harness } = await setup(
          hostResponder({
            prepareOriginCheckout: () => ({ path, kept: null }),
          }),
        );

        await api.storage.kv.set(`copy:${THREAD_ID}`, RECORD);
        await harness.behavior.runCli([
          "run",
          THREAD_ID,
          "--",
          "printf ran > command-ran",
        ]);

        const request = terminalCommandRequestSchema.parse(
          harness.sdk.callsTo("terminals.create")[0]?.[0],
        );

        expect(request.scope.cwd).toBe(path);

        const result = spawnSync("bash", ["-c", request.start.command], {
          cwd: request.scope.cwd,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", LC_ALL: "C" },
        });

        if (kind === "dual") {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toMatch(/both.*setup|setup.*conflict/iu);
          await expect(
            readFile(join(path, "command-ran")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await expect(readFile(join(path, "hook-ran"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(result.status).toBe(0);
          expect(await readFile(join(path, "hook-ran"), "utf8")).toBe(kind);
          expect(await readFile(join(path, "command-ran"), "utf8")).toBe("ran");
        }

        for (const file of files) {
          expect(await readFile(file.path)).toEqual(file.bytes);
          expect((await stat(file.path)).mode).toBe(file.mode);
        }
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    },
  );

  it("keeps existing legacy base refs and opaque user branches on sync", async () => {
    const { api, harness } = await setup();

    const legacy = {
      ...RECORD,
      baseRef: `bb-base/${THREAD_ID}`,
      branch: "omnyo/plan-thr_1",
    };

    await api.storage.kv.set(`copy:${THREAD_ID}`, legacy);
    const result = await harness.behavior.runCli(["sync", THREAD_ID]);
    expect(result.exitCode).toBe(0);
    expect(prepareInput(harness)).toMatchObject({ baseRef: legacy.baseRef });
    expect(
      harness.experimental_hostRpcCalls.find(
        (call) => call.method === "applyCopyBack",
      )?.input,
    ).toMatchObject({ branch: legacy.branch });
    await expect(api.storage.kv.get(`copy:${THREAD_ID}`)).resolves.toEqual(
      legacy,
    );
  });
});
