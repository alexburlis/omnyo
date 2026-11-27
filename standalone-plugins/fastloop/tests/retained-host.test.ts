import { mkdtemp, realpath, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentalHostRpcContext } from "@omnyo/plugin-sdk";
import { expect, it } from "vitest";
import entry from "../host.js";
import { hostSignals, type ContextBinding } from "../contracts.js";

it("uses normal routing for existing checkouts and refuses archive identity substitution", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fastloop-retained-host-"));

  try {
    const root = await realpath(scratch);
    const second = join(root, "second");
    await mkdir(second);

    const binding: ContextBinding = {
      threadId: "thread",
      projectId: "project",
      environmentId: "environment",
      hostId: "host",
      canonicalRoot: join(root, "original"),
      workspaceId: "workspace",
      policyHash: "a".repeat(64),
      platform: process.platform,
      arch: process.arch,
    };

    const signal = new AbortController().signal;

    const context: ExperimentalHostRpcContext<typeof hostSignals> = {
      signal,
      lifecycle: { signal },
      experimental_paths: { dataDir: root, tempDir: root },
      async experimental_emitSignal() {},
      async experimental_watch() {
        throw new Error("unused");
      },
      experimental_retainWorker() {
        throw new Error("must not create runtime scope");
      },
    };

    const input = {
      binding,
      candidatePath: second,
      method: "result" as const,
      payload: { runId: "run" },
    };

    await expect(entry.handlers.retainedRead(input, context)).resolves.toEqual({ missing: false });
    await expect(
      entry.handlers.retainedRead(
        { ...input, candidatePath: join(root, "different-missing") },
        context,
      ),
    ).rejects.toThrow("WORKSPACE_CONTEXT_MISMATCH");
    await expect(
      entry.handlers.retainedRead(
        {
          ...input,
          candidatePath: binding.canonicalRoot,
          binding: { ...binding, platform: "unsupported" },
        },
        context,
      ),
    ).rejects.toThrow("PLATFORM_CONTEXT_CHANGED");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
