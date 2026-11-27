import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SdkBridge } from "../bridge.js";
import { bindingFingerprint } from "../binding.js";
import type { ContextBinding } from "../contracts.js";
import { HostLeaseManager } from "../leases.js";

it("delegates stale persisted active state to the readonly archive's quiescence authority", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fastloop-stale-lease-"));

  try {
    const root = await realpath(scratch);

    const binding: ContextBinding = {
      threadId: "thread",
      projectId: "project",
      environmentId: "environment",
      hostId: "host",
      canonicalRoot: join(root, "gone"),
      workspaceId: "workspace",
      policyHash: "a".repeat(64),
      platform: process.platform,
      arch: process.arch,
    };

    const dataRoot = join(
      root,
      "projects",
      createHash("sha256").update(binding.canonicalRoot).digest("hex"),
    );

    await mkdir(dataRoot, { recursive: true });
    await mkdir(join(root, "leases"));
    const clientId = `omnyo-${bindingFingerprint(binding)}`;
    await writeFile(
      join(root, "leases", clientId + ".json"),
      JSON.stringify({
        schema: 1,
        binding,
        clientId,
        dataRoot,
        state: "active",
        requests: [
          {
            requestId: "request",
            accepted: { runId: "run", sessionId: "session", state: "accepted" },
          },
        ],
      }),
    );
    const sdkPath = join(root, "sdk.mjs");
    await writeFile(
      sdkPath,
      `export async function openArchive(){return {result:async(runId)=>({runId,state:"cancelled",result:{verdict:"CANCELLED"}}),close:async()=>{}}}`,
    );
    const versions = join(homedir(), ".nvm/versions/node");

    const version = (await readdir(versions))
      .filter((name) => name.startsWith("v24."))
      .sort()
      .at(-1);

    if (!version) throw new Error("Node24 qualification required");
    let opens = 0;

    const manager = new HostLeaseManager({
      dataDir: root,
      openBridge(options) {
        opens++;

        return SdkBridge.connect({
          ...options,
          sdkPath,
          nodeExecutable: join(versions, version, "bin/node"),
        });
      },
    });

    await expect(manager.retainedRead(binding, "result", { runId: "foreign" })).rejects.toThrow(
      "RUN_NOT_OWNED",
    );
    expect(opens).toBe(0);
    await expect(manager.retainedRead(binding, "result", { runId: "run" })).resolves.toMatchObject({
      runId: "run",
      state: "cancelled",
      result: { verdict: "CANCELLED" },
    });
    expect(opens).toBe(1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 5000);
