import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentalHostRpcContext } from "@omnyo/plugin-sdk";
import { expect, it } from "vitest";
import { SdkBridge } from "../bridge.js";
import { HostLeaseManager } from "../leases.js";
import { bindingFingerprint } from "../binding.js";
import { hostSignals, type ContextBinding } from "../contracts.js";

it("waits for owned disposal before serving a concurrent retained-result read", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastloop-session-scope-"));
  let manager: HostLeaseManager | undefined;

  try {
    const versions = join(homedir(), ".nvm/versions/node");

    const version = (await readdir(versions))
      .filter((name) => name.startsWith("v24."))
      .sort()
      .at(-1);

    if (!version) throw new Error("Node24 qualification is required");
    const nodeExecutable = join(versions, version, "bin/node");
    const sdkPath = join(root, "fixture-sdk.mjs");
    await writeFile(
      sdkPath,
      `export async function createClient(){return {lookupSubmission:async()=>null,submit:async()=>({runId:"run-a",sessionId:"session-a",state:"accepted"}),result:async()=>({runId:"run-a",state:"completed"}),events:async()=>({nextSequence:1,job:{runId:"run-a",state:"completed"}}),dispose:async()=>{await new Promise(r=>setTimeout(r,50))},close:async()=>{}}}`,
    );
    let retained = 0;
    const roots: (string | undefined)[] = [];

    const context: ExperimentalHostRpcContext<typeof hostSignals> = {
      signal: new AbortController().signal,
      lifecycle: { signal: new AbortController().signal },
      experimental_paths: { dataDir: root, tempDir: root },
      async experimental_emitSignal() {},
      async experimental_watch() {
        throw new Error("unused");
      },
      experimental_retainWorker() {
        retained++;

        return {
          async dispose() {
            retained--;
          },
        };
      },
    };

    manager = new HostLeaseManager({
      dataDir: root,
      openBridge: (options) => {
        roots.push(options.dataRoot);

        return SdkBridge.connect({
          nodeExecutable,
          sdkPath,
          projectRoot: root,
          dataRoot: root,
          clientId: options.clientId,
          onExit: options.onExit,
        });
      },
    });

    const binding: ContextBinding = {
      threadId: "thread-a",
      projectId: "project-a",
      environmentId: "environment-a",
      hostId: "host-a",
      canonicalRoot: root,
      workspaceId: "workspace",
      policyHash: "a".repeat(64),
      platform: "darwin",
      arch: "arm64",
    };

    await manager.invoke("submit", binding, { requestId: "request-a", submission: {} }, context);
    const closing = manager.release(binding);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(manager.invoke("result", binding, { runId: "run-a" }, context)).resolves.toEqual({
      runId: "run-a",
      state: "completed",
    });
    await closing;
    await manager.release(binding);
    expect(retained).toBe(0);
    expect(roots.length).toBeGreaterThan(1);
    expect(new Set(roots).size).toBe(1);
    expect(roots[0]).toMatch(new RegExp(`^${root}/projects/[a-f0-9]{64}$`));
    const legacy = { ...binding, threadId: "legacy-thread" };
    const clientId = `omnyo-${bindingFingerprint(legacy)}`;
    await writeFile(
      join(root, "leases", `${clientId}.json`),
      JSON.stringify({
        schema: 1,
        binding: legacy,
        clientId,
        state: "released",
        requests: [
          {
            requestId: "legacy-request",
            accepted: { runId: "run-a", sessionId: "session-a", state: "completed" },
          },
        ],
      }),
    );
    roots.length = 0;
    await expect(
      manager.invoke("result", legacy, { runId: "run-a" }, context),
    ).resolves.toMatchObject({ state: "completed" });
    expect(roots).toEqual([undefined]);
    await expect(
      manager.invoke("submit", legacy, { requestId: "new-request", submission: {} }, context),
    ).rejects.toThrow("DATA_ROOT_CONFLICT");
    await manager.close();
    expect(retained).toBe(0);
    const conflictBinding = { ...binding, threadId: "conflicting-thread" };

    const refusing = new HostLeaseManager({
      dataDir: root,
      async openBridge() {
        throw new Error("DATA_ROOT_CONFLICT");
      },
    });

    await expect(
      refusing.invoke(
        "submit",
        conflictBinding,
        { requestId: "conflict-request", submission: {} },
        context,
      ),
    ).rejects.toThrow("DATA_ROOT_CONFLICT");

    const conflictLedger = JSON.parse(
      await readFile(
        join(root, "leases", `omnyo-${bindingFingerprint(conflictBinding)}.json`),
        "utf8",
      ),
    );

    expect(conflictLedger.state).toBe("interrupted");
    expect(conflictLedger.requests).toEqual([]);
    expect(retained).toBe(0);
    await refusing.close();
  } finally {
    await manager?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

it.each([
  ["reads a retained bb-named ledger", "bb", true],
  ["refuses a ledger whose client id does not match its file name", "omnyo", false],
])("%s", async (_label, storedBrand, accepted) => {
  const root = await mkdtemp(join(tmpdir(), "fastloop-old-ledger-"));

  try {
    await mkdir(join(root, "leases"));

    const binding: ContextBinding = {
      threadId: "thread-old",
      projectId: "project-a",
      environmentId: "environment-a",
      hostId: "host-a",
      canonicalRoot: root,
      workspaceId: "workspace",
      policyHash: "a".repeat(64),
      platform: "darwin",
      arch: "arm64",
    };

    const fingerprint = bindingFingerprint(binding);
    const clientId = `${storedBrand}-${fingerprint}`;

    await writeFile(
      join(root, "leases", `bb-${fingerprint}.json`),
      JSON.stringify({ schema: 1, binding, clientId, state: "released", requests: [] }),
    );

    const context: ExperimentalHostRpcContext<typeof hostSignals> = {
      signal: new AbortController().signal,
      lifecycle: { signal: new AbortController().signal },
      experimental_paths: { dataDir: root, tempDir: root },
      async experimental_emitSignal() {},
      async experimental_watch() {
        throw new Error("unused");
      },
      experimental_retainWorker() {
        return { async dispose() {} };
      },
    };

    const manager = new HostLeaseManager({
      dataDir: root,
      async openBridge() {
        throw new Error("a released ledger needs no bridge");
      },
    });

    const released = manager.release(binding, context);

    if (accepted) await expect(released).resolves.toEqual({ released: true });
    else await expect(released).rejects.toThrow("RUNTIME_LEASE_LEDGER_INVALID");
    await manager.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
