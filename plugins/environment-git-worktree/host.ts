import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { createHostProgress } from "omnyo-environment-provider-host/progress";
import { worktreeHostContract, worktreeHostSignals } from "./contract.js";
import type { StorageSharingResult, StorageWorktree } from "./contract.js";
import { tryWithCheckoutMutationLock } from "omnyo-environment-provider-host/locks";
import {
  shareFreshWorktree,
  reclaimWorktreeStorage,
} from "./host/share-storage.js";
import {
  readDefaultBranchRefs,
  resolveDefaultBaseBranch,
  type GitProcessOptions,
} from "omnyo-environment-provider-host/git";
import { resolveWorktreeBaseBranch } from "./host/base-branch.js";
import {
  resolveWorktreeChildPath,
  resolveWorktreesRoot,
  resolveWorktreeAttemptRoot,
  resolveWorktreeTargetPath,
} from "./host/paths.js";
import {
  createWorktree,
  listAdoptableWorktrees,
  removeWorktree,
  resolveAdoptableWorktree,
} from "./host/worktree.js";
import {
  inspectMissingRegistration,
  removeMissingRegistration,
} from "./host/missing-registration.js";

function completionPathForWorktree(worktreePath: string): string {
  return `${worktreePath}.completed`;
}

function signalOptions(
  signal: AbortSignal,
): GitProcessOptions & { signal: AbortSignal } {
  return { signal };
}

async function worktreePathsForPathKey(args: {
  dataDir: string;
  pathKey: string;
}): Promise<string[]> {
  const root = resolveWorktreeAttemptRoot(args);

  try {
    const entries = await readdir(root, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        resolveWorktreeChildPath({
          dataDir: args.dataDir,
          pathKey: args.pathKey,
          childName: entry.name,
        }),
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export function createWorktreeHostEntry() {
  const sharing = new Map<string, AbortController>();
  const cancelled = new Set<string>();

  function beginSharing(operationId: string, signal: AbortSignal) {
    const controller = new AbortController();

    if (cancelled.delete(operationId)) controller.abort();
    sharing.set(operationId, controller);

    return {
      signal: AbortSignal.any([signal, controller.signal]),
      finish: () => {
        sharing.delete(operationId);
        cancelled.delete(operationId);
      },
    };
  }

  return experimental_defineHostEntry({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
    handlers: {
      cancelStorageSharing({ operationId }) {
        const operation = sharing.get(operationId);

        if (operation) operation.abort();
        else {
          cancelled.add(operationId);
          const oldest = cancelled.values().next();

          if (cancelled.size > 256 && !oldest.done)
            cancelled.delete(oldest.value);
        }

        return { cancelled: true };
      },
      async reclaimWorktreeStorage(
        input,
        context,
      ): Promise<StorageSharingResult> {
        const skippedWorktrees: StorageSharingResult["skippedWorktrees"] = [];

        const resolved = await Promise.all(
          input.worktrees.map(async (row) => {
            try {
              return { ...row, path: await realpath(row.path) };
            } catch (error) {
              if (
                !(
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ENOENT"
                )
              )
                throw error;
              skippedWorktrees.push({
                path: row.path,
                reason: "The selected worktree is missing.",
              });

              return null;
            }
          }),
        );

        const byPath = new Map<string, StorageWorktree>();

        for (const row of resolved) if (row) byPath.set(row.path, row);

        const worktrees = [...byPath.values()].sort((a, b) =>
          a.path.localeCompare(b.path),
        );

        const protectedPaths = new Set(
          await Promise.all(
            input.protectedPaths.map((path) =>
              realpath(path).catch((error: unknown) => {
                if (
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ENOENT"
                )
                  return path;
                throw error;
              }),
            ),
          ),
        );

        const operation = beginSharing(input.operationId, context.signal);
        let mutating = false;

        async function locked(
          index: number,
          eligible: StorageWorktree[],
        ): Promise<StorageSharingResult> {
          const worktree = worktrees[index];

          if (!worktree) {
            if (operation.signal.aborted)
              return {
                status: "cancelled",
                sharedFiles: 0,
                privateBytesReleased: 0,
                skippedFiles: 0,
                skippedWorktrees,
              };
            mutating = true;

            const result = await reclaimWorktreeStorage({
              worktrees: eligible,
              dataDir: context.experimental_paths.dataDir,
              signal: operation.signal,
            });

            return {
              ...result,
              status: operation.signal.aborted ? "cancelled" : result.status,
              skippedWorktrees: [
                ...skippedWorktrees,
                ...result.skippedWorktrees,
              ],
            };
          }

          const result = await tryWithCheckoutMutationLock(
            worktree.path,
            async () => {
              const canonical = await realpath(worktree.path);

              if (
                [...protectedPaths].some((protectedPath) => {
                  const child = relative(canonical, protectedPath);

                  return (
                    child === "" ||
                    (child !== ".." &&
                      !child.startsWith(`..${sep}`) &&
                      !isAbsolute(child))
                  );
                })
              ) {
                skippedWorktrees.push({
                  path: worktree.path,
                  reason:
                    "The worktree belongs to an active environment or thread.",
                });

                return locked(index + 1, eligible);
              }

              return locked(index + 1, [...eligible, worktree]);
            },
            operation.signal,
            signalOptions(operation.signal),
          );

          if (result !== null) return result;
          skippedWorktrees.push({
            path: worktree.path,
            reason: "The worktree is no longer a Git checkout.",
          });

          return locked(index + 1, eligible);
        }

        try {
          return await locked(0, []);
        } catch (error) {
          if (!operation.signal.aborted || mutating) throw error;

          return {
            status: "cancelled",
            sharedFiles: 0,
            privateBytesReleased: 0,
            skippedFiles: 0,
            skippedWorktrees,
          };
        } finally {
          operation.finish();
        }
      },
      inspectMissingRegistration: (input, context) => {
        if (
          input.path !==
          resolveWorktreeTargetPath({
            dataDir: context.experimental_paths.dataDir,
            pathKey: input.pathKey,
            sourcePath: input.sourcePath,
          })
        )
          throw new Error("The folder is not the provider-owned worktree.");

        return inspectMissingRegistration(input, context.signal);
      },
      async defaultBaseBranch(input) {
        const refs = await readDefaultBranchRefs(input.sourcePath);

        return {
          branch: resolveDefaultBaseBranch({
            defaultBranch: refs.defaultBranch ?? null,
            originDefaultBranch: refs.originDefaultBranch ?? null,
            defaultBranchRelation: refs.defaultBranchRelation ?? null,
          }),
        };
      },
      async listWorktrees(input, context) {
        const worktrees = await listAdoptableWorktrees({
          sourcePath: input.sourcePath,
          managedRoot: resolveWorktreesRoot(context.experimental_paths.dataDir),
        });

        return {
          worktrees: worktrees.map((entry) => ({
            path: entry.path,
            branch: entry.branch,
            locked: entry.locked,
            prunable: entry.prunable,
          })),
        };
      },
      async resolveExistingWorktree(input, context) {
        return resolveAdoptableWorktree({
          sourcePath: input.sourcePath,
          path: input.path,
          managedRoot: resolveWorktreesRoot(context.experimental_paths.dataDir),
        });
      },
      async create(input, context) {
        const targetPath = resolveWorktreeTargetPath({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
          sourcePath: input.sourcePath,
        });

        const sharingOperation = input.shareWorktreeStorage
          ? beginSharing(input.operationId, context.signal)
          : null;

        const progress = createHostProgress({
          operationId: input.operationId,
          emit: (payload) =>
            context.experimental_emitSignal("progress", payload),
        });

        const reportStopped = () =>
          progress({
            type: "step",
            key: "worktree-storage-sharing",
            status: "completed",
            text: "Storage sharing stopped",
          });

        try {
          const baseBranch = await resolveWorktreeBaseBranch(
            input.sourcePath,
            input.baseBranch,
          );

          const created = await createWorktree({
            sourcePath: input.sourcePath,
            targetPath,
            completionPath: completionPathForWorktree(targetPath),
            ownWorktreesRoot: resolveWorktreesRoot(
              context.experimental_paths.dataDir,
            ),
            branchName: input.branchName,
            baseBranch,
            branchMode: input.branchMode,
            ...(sharingOperation
              ? {
                  shareStorage: async () => {
                    if (sharingOperation.signal.aborted) return reportStopped();
                    let result;

                    try {
                      result = await tryWithCheckoutMutationLock(
                        targetPath,
                        () =>
                          shareFreshWorktree({
                            sourcePath: input.sourcePath,
                            targetPath,
                            dataDir: context.experimental_paths.dataDir,
                            signal: sharingOperation.signal,
                          }),
                        sharingOperation.signal,
                        signalOptions(sharingOperation.signal),
                      );
                    } catch (error) {
                      if (
                        !sharingOperation.signal.aborted ||
                        context.signal.aborted
                      )
                        throw error;
                      reportStopped();

                      return;
                    }

                    progress({
                      type: "step",
                      key: "worktree-storage-sharing",
                      status: "completed",
                      text: sharingOperation.signal.aborted
                        ? "Storage sharing stopped"
                        : result === null
                          ? "Storage sharing skipped: Git checkout unavailable"
                          : result.status === "unsupported"
                            ? "Storage sharing is unavailable on this filesystem"
                            : `Shared storage for ${result.sharedFiles} files`,
                    });
                  },
                }
              : {}),
            onProgress: progress,
            signal: context.signal,
          });

          if (input.shareWorktreeStorage === false)
            progress({
              type: "step",
              key: "worktree-storage-sharing",
              status: "completed",
              text: "Storage sharing is switched off",
            });

          return {
            status: "created",
            path: created.path,
            baseBranch: baseBranch?.ref ?? null,
          } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;

          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        } finally {
          sharingOperation?.finish();
        }
      },

      async remove(input, context) {
        try {
          const paths =
            input.path === null
              ? await worktreePathsForPathKey({
                  dataDir: context.experimental_paths.dataDir,
                  pathKey: input.pathKey,
                })
              : [input.path];

          for (const path of paths) {
            if (input.recovery) {
              const expectedPath = resolveWorktreeTargetPath({
                dataDir: context.experimental_paths.dataDir,
                pathKey: input.pathKey,
                sourcePath: input.recovery.sourcePath,
              });

              if (path !== expectedPath || path !== input.path)
                throw new Error(
                  "The approved folder is not the provider-owned worktree.",
                );
              await removeMissingRegistration(
                { ...input.recovery, path },
                input.recovery.proof,
                context.signal,
              );
            }

            await removeWorktree({
              path,
              completionPath: completionPathForWorktree(path),
              onProgress: createHostProgress({
                operationId: input.operationId,
                emit: (payload) =>
                  context.experimental_emitSignal("progress", payload),
              }),
              signal: context.signal,
            });
          }

          return { status: "removed" } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;

          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },
    },
  });
}

export default createWorktreeHostEntry();
