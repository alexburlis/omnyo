import fs from "node:fs/promises";
import path from "node:path";
import { FileLockTimeoutError, withFileLock } from "@omnyo/config/file-lock";
import { enableInheritedProcessGroup } from "@omnyo/process-utils";
import { provisionWorkspace } from "@omnyo/host-workspace";
import { CommandMetadataCatalog } from "./command-metadata.js";
import { readWorkspaceAgentContext } from "./command-handlers/workspace-agent-context.js";
import { collectLocalSkillSource } from "./injected-skills.js";
import { executeReadonlyFilesystemCommand } from "./workspace-read-rpc.js";
import { executeFilesystemMutation } from "./workspace-mutation-rpc.js";
import { drainHostBranchRefreshes } from "./command-handlers/host-branches.js";
import { ExpectedCommandDispatchError } from "./command-errors.js";
import {
  workspaceReadRequestSchema,
  type WorkspaceReadRequest,
  type WorkspaceReadResponse,
} from "./workspace-read-protocol.js";

enableInheritedProcessGroup();

function send(message: WorkspaceReadResponse): void {
  if (process.connected) process.send?.(message, () => undefined);
}

function sendTerminal(message: WorkspaceReadResponse): Promise<void> {
  if (!process.connected) return Promise.resolve();

  return new Promise((resolve) => {
    try {
      process.send?.(message, () => resolve());
    } catch {
      resolve();
    }
  });
}

const catalog = new CommandMetadataCatalog({ mode: "observation-only" });

let mutationMode = false;

let activeMutations = 0;

let closing = false;

let finalizing = false;

let mutationOwnership: Promise<void> | null = null;

let mutationOwnershipFinished: Promise<void> = Promise.resolve();

let releaseMutationOwnership: (() => void) | null = null;

function acquireMutationOwnership(dataDir: string): Promise<void> {
  if (mutationOwnership !== null) return mutationOwnership;

  mutationOwnership = new Promise<void>((resolve, reject) => {
    mutationOwnershipFinished = withFileLock({
      path: path.join(dataDir, "workspace-mutations.lock"),
      timeoutMs: 0,
      work: () =>
        new Promise<void>((release) => {
          releaseMutationOwnership = release;
          resolve();
        }),
    }).catch((error: unknown) => {
      mutationOwnership = null;
      reject(
        error instanceof FileLockTimeoutError
          ? new ExpectedCommandDispatchError(
              "filesystem_mutator_busy",
              "A previous filesystem writer is still running",
            )
          : error,
      );
    });
  });

  return mutationOwnership;
}

function finishShutdown(): void {
  if (!closing || activeMutations !== 0 || finalizing) return;
  finalizing = true;
  releaseMutationOwnership?.();
  void Promise.all([
    catalog.dispose(),
    drainHostBranchRefreshes(),
    mutationOwnershipFinished,
  ]).finally(() => process.exit(0));
}

function shutdown(): void {
  closing = true;

  if (!mutationMode) {
    const deadline = setTimeout(() => process.exit(0), 1_000);
    deadline.unref();
  }

  finishShutdown();
}

function requestError(id: number, error: unknown): WorkspaceReadResponse {
  return {
    kind: "error",
    id,
    expected: error instanceof ExpectedCommandDispatchError,
    code:
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "command_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function handleRequest(request: WorkspaceReadRequest): Promise<void> {
  switch (request.kind) {
    case "invalidate":
      catalog.invalidate();

      return;
    case "shutdown":
      shutdown();

      return;
    case "mutate": {
      mutationMode = true;

      if (closing) {
        await sendTerminal(
          requestError(request.id, new Error("Filesystem mutator is draining")),
        );

        return;
      }

      activeMutations += 1;

      try {
        if (
          request.command.type !== "host.inspect_git_source" &&
          request.command.type !== "host.list_branch_options"
        ) {
          await acquireMutationOwnership(request.dataDir);
        }

        const result = await executeFilesystemMutation(request.command, {
          dataDir: request.dataDir,
          ...(request.shellPath === undefined
            ? {}
            : { shellPath: request.shellPath }),
        });

        await sendTerminal({ kind: "mutate", id: request.id, result });
      } catch (error) {
        await sendTerminal(requestError(request.id, error));
      } finally {
        activeMutations -= 1;
        finishShutdown();
      }

      return;
    }

    case "access":
    case "rpc":
    case "metadata":
    case "context":
    case "collect-local":
    case "provision":
      try {
        if (request.kind === "access") {
          const accessible = await fs.access(request.path).then(
            () => true,
            () => false,
          );

          send({ kind: "access", id: request.id, accessible });
        } else if (request.kind === "rpc") {
          const result = await executeReadonlyFilesystemCommand(
            request.command,
            request.shellPath,
          );

          send({ kind: "rpc", id: request.id, result });
        } else if (request.kind === "metadata") {
          const snapshot = await catalog.listSnapshot(request.command);
          send({ kind: "metadata", id: request.id, ...snapshot });
        } else if (request.kind === "context") {
          const result = await readWorkspaceAgentContext(request.command);
          send({ kind: "context", id: request.id, result });
        } else if (request.kind === "collect-local") {
          if (request.source.kind === "tree")
            throw new Error(
              "Local skill collection requires a filesystem source",
            );
          const result = await collectLocalSkillSource(request.source);
          send({ kind: "collect-local", id: request.id, result });
        } else {
          const workspace = await provisionWorkspace({
            path: request.path,
            ...(request.shellPath !== undefined
              ? { shellPath: request.shellPath }
              : {}),
          });

          send({
            kind: "provision",
            id: request.id,
            result: {
              path: workspace.path,
              isGitRepo: workspace.isGitRepo,
              isWorktree: workspace.isWorktree,
              additionalWorkspaceWriteRoots:
                await workspace.getAdditionalWorkspaceWriteRoots(),
            },
          });
        }
      } catch (error) {
        send(requestError(request.id, error));
      }

      return;
  }
}

process.on("message", (message: unknown) => {
  const parsed = workspaceReadRequestSchema.safeParse(message);

  if (!parsed.success) {
    process.exitCode = 1;
    shutdown();

    return;
  }

  void handleRequest(parsed.data);
});

process.on("disconnect", () => {
  shutdown();
});

send({ kind: "ready" });
