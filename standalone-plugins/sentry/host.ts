import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";
import { hostContract } from "./contract";
import { GitHost } from "./src/git-host";
import { WorkflowHost } from "./src/workflow-host";

type Operation = { controller: AbortController; done: Promise<void> };

const operations = new Map<string, Operation>();

async function tracked<T>(
  runId: string,
  signal: AbortSignal,
  lifecycle: AbortSignal,
  action: (signal: AbortSignal) => Promise<T>,
) {
  if (operations.has(runId)) throw new Error("An operation for this run is already active");
  const controller = new AbortController();
  const pending = action(AbortSignal.any([signal, lifecycle, controller.signal]));

  const done = pending.then(
    () => {},
    () => {},
  );

  operations.set(runId, { controller, done });

  try {
    return await pending;
  } finally {
    operations.delete(runId);
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    discoverRepositories: (input, context) =>
      new GitHost(AbortSignal.any([context.signal, context.lifecycle.signal])).discoverRepositories(
        input.rootPath,
      ),
    inspectRepository: (input, context) =>
      new GitHost(AbortSignal.any([context.signal, context.lifecycle.signal])).inspectRepository(
        input.repositoryPath,
        input.baseRef,
        input.expectedRepository,
      ),
    coordinatorWorkspace: async ({ pathKey, action }, context) => {
      const path = join(context.experimental_paths.dataDir, "coordinators", pathKey);

      if (action === "ensure") await mkdir(path, { recursive: true });
      else {
        try {
          await rmdir(path);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }

      return { path };
    },
    worktreePath: async ({ pathKey }, context) => {
      const root = join(context.experimental_paths.dataDir, "worktrees");
      await mkdir(root, { recursive: true });

      return { path: join(root, pathKey) };
    },
    createWorktree: (input, context) =>
      new GitHost(AbortSignal.any([context.signal, context.lifecycle.signal])).createWorktree(
        input.sourcePath,
        input.path,
        input.branch,
        input.baseSha,
        input.restore,
      ),
    removeWorktree: (input, context) =>
      new GitHost(AbortSignal.any([context.signal, context.lifecycle.signal])).removeWorktree(
        input.sourcePath,
        input.path,
        input.branch,
      ),
    verify: (input, context) =>
      tracked(input.runId, context.signal, context.lifecycle.signal, (signal) =>
        new GitHost(signal).verify(
          input.path,
          input.baseSha,
          input.head,
          input.changedFiles,
          input.checks,
          input.repairBranch,
        ),
      ),
    publish: (input, context) =>
      tracked(input.runId, context.signal, context.lifecycle.signal, (signal) =>
        new GitHost(signal).publish(
          input.path,
          input.repository,
          input.head,
          input.branch,
          input.baseBranch,
          input.runId,
          input.title,
          input.body,
        ),
      ),
    workflowWorktreePath: (input, context) =>
      new WorkflowHost(
        join(context.experimental_paths.dataDir, "workflows"),
        AbortSignal.any([context.signal, context.lifecycle.signal]),
      ).worktreePath(input),
    workflowMerge: (input, context) =>
      tracked(input.runId, context.signal, context.lifecycle.signal, (signal) =>
        new WorkflowHost(join(context.experimental_paths.dataDir, "workflows"), signal).merge(
          input,
        ),
      ),
    workflowPlan: (input, context) =>
      tracked(input.runId, context.signal, context.lifecycle.signal, (signal) =>
        new WorkflowHost(join(context.experimental_paths.dataDir, "workflows"), signal).plan(input),
      ),
    workflowRelease: (input, context) =>
      tracked(input.runId, context.signal, context.lifecycle.signal, (signal) =>
        new WorkflowHost(join(context.experimental_paths.dataDir, "workflows"), signal).release(
          input,
        ),
      ),
    workflowDeliver: (input, context) =>
      tracked(input.runId, context.signal, context.lifecycle.signal, (signal) =>
        new WorkflowHost(join(context.experimental_paths.dataDir, "workflows"), signal).deliver(
          input,
        ),
      ),
    workflowPluginTargets: (input, context) =>
      tracked(input.runId, context.signal, context.lifecycle.signal, (signal) =>
        new WorkflowHost(
          join(context.experimental_paths.dataDir, "workflows"),
          signal,
        ).pluginTargets(input),
      ),
    workflowVerify: (input, context) =>
      tracked(input.runId, context.signal, context.lifecycle.signal, (signal) =>
        new WorkflowHost(join(context.experimental_paths.dataDir, "workflows"), signal).verify(
          input,
        ),
      ),
    stop: async ({ runId }) => {
      const operation = operations.get(runId);
      operation?.controller.abort();
      await operation?.done;

      return { stopped: true as const };
    },
  },
  dispose: async () => {
    const active = [...operations.values()];

    for (const operation of active) operation.controller.abort();
    await Promise.all(active.map((operation) => operation.done));
  },
});
