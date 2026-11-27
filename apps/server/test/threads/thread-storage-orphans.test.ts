import { posix as path } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { markThreadDeleted } from "@omnyo/db";
import type { HostDaemonOnlineRpcRequestMessage } from "@omnyo/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import {
  removeOrphanedThreadStorage,
  runThreadStorageOrphanSweep,
  THREAD_STORAGE_ORPHAN_PASS_LIMITS,
} from "../../src/services/threads/thread-storage-orphans.js";
import { advanceUntilSettled } from "../helpers/fake-timers.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const ORPHANED_THREAD_ID = "thr_abcdefghij";

const THREAD_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

function orphanedThreadIdAt(index: number): string {
  let suffix = "";

  for (let value = index; suffix.length < 10; value = Math.floor(value / 32)) {
    suffix = THREAD_ID_ALPHABET[value % 32] + suffix;
  }

  return `thr_${suffix}`;
}

describe("thread storage orphan cleanup", () => {
  it("parks an unknown mutation outcome until a new session inventories its own candidates", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rootPath = path.join(session.dataDir, "thread-storage");
      const first = orphanedThreadIdAt(1);
      const later = orphanedThreadIdAt(2);
      const fresh = orphanedThreadIdAt(3);

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) =>
          request.command.type === "host.browse_directory"
            ? {
                ok: true,
                result: {
                  directory: rootPath,
                  parent: session.dataDir,
                  entries: [first, later].map((name) => ({
                    kind: "directory" as const,
                    name,
                    path: path.join(rootPath, name),
                  })),
                },
              }
            : {
                ok: false,
                errorCode: "mutation_outcome_unknown",
                errorMessage: "Writer disconnected",
              },
      });

      const args = {
        hostId: host.id,
        limits: { elapsedBudgetMs: 60_000, maxRemovals: 100 },
      };

      try {
        await removeOrphanedThreadStorage(harness.deps, args);
        await removeOrphanedThreadStorage(harness.deps, args);
        expect(responder.requests.map((request) => request.command)).toEqual([
          { type: "host.browse_directory", path: rootPath },
          { type: "host.delete_thread_storage", threadId: first },
        ]);

        const replacement = seedSession(harness.deps, host.id, {
          instanceId: "replacement",
        });

        const next = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: replacement.id,
          handle: (request) =>
            request.command.type === "host.browse_directory"
              ? {
                  ok: true,
                  result: {
                    directory: rootPath,
                    parent: session.dataDir,
                    entries: [
                      {
                        kind: "directory",
                        name: fresh,
                        path: path.join(rootPath, fresh),
                      },
                    ],
                  },
                }
              : { ok: true, result: { ok: true } },
        });

        try {
          await removeOrphanedThreadStorage(harness.deps, args);
          expect(next.requests.map((request) => request.command)).toEqual([
            { type: "host.browse_directory", path: rootPath },
            { type: "host.delete_thread_storage", threadId: fresh },
          ]);
        } finally {
          next.unregister();
        }
      } finally {
        responder.unregister();
      }
    });
  });

  it("never sends the previous inventory's deletion to a replacement between the ready guard and send", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rootPath = path.join(session.dataDir, "thread-storage");

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: true,
          result: {
            directory: rootPath,
            parent: session.dataDir,
            entries: [1, 2].map((index) => ({
              kind: "directory" as const,
              name: orphanedThreadIdAt(index),
              path: path.join(rootPath, orphanedThreadIdAt(index)),
            })),
          },
        }),
      });

      const replacementSocket = { close() {}, send: vi.fn() };
      const send = harness.hub.requestHostOnlineRpc.bind(harness.hub);

      const request = vi
        .spyOn(harness.hub, "requestHostOnlineRpc")
        .mockImplementation((args) => {
          expect(args.expectedSessionId).toBe(session.id);

          if (args.message.command.type === "host.delete_thread_storage") {
            harness.hub.unregisterDaemon(session.id);
            harness.hub.registerDaemon(
              "replacement-session",
              host.id,
              replacementSocket,
            );
          }

          return send(args);
        });

      try {
        await removeOrphanedThreadStorage(harness.deps, {
          hostId: host.id,
          limits: { elapsedBudgetMs: 60_000, maxRemovals: 100 },
        });
        expect(request).toHaveBeenCalledTimes(2);
        expect(responder.requests.map((item) => item.command.type)).toEqual([
          "host.browse_directory",
        ]);
        expect(replacementSocket.send.mock.calls.flat()).not.toEqual(
          expect.arrayContaining([
            expect.stringContaining('"type":"host-rpc.request"'),
          ]),
        );
      } finally {
        request.mockRestore();
        harness.hub.unregisterDaemon("replacement-session");
        responder.unregister();
      }
    });
  });

  it("skips the sweep while app work is active", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });

      seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      try {
        runThreadStorageOrphanSweep(harness.deps);
        await sleep(20);
        expect(responder.requests).toEqual([]);
      } finally {
        responder.unregister();
      }
    });
  });

  it("removes a backlog across idle passes and stops listing a cleaned session", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rootPath = path.join(session.dataDir, "thread-storage");

      const storedIds = new Set(
        Array.from(
          { length: THREAD_STORAGE_ORPHAN_PASS_LIMITS.maxRemovals + 50 },
          (_, index) => orphanedThreadIdAt(index),
        ),
      );

      const commandTypes: string[] = [];

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          commandTypes.push(request.command.type);

          if (request.command.type === "host.browse_directory") {
            return {
              ok: true,
              result: {
                directory: rootPath,
                parent: session.dataDir,
                entries: [...storedIds].map((name) => ({
                  kind: "directory" as const,
                  name,
                  path: path.join(rootPath, name),
                })),
              },
            };
          }

          if (request.command.type === "host.delete_thread_storage") {
            storedIds.delete(request.command.threadId);

            return { ok: true, result: { ok: true } };
          }

          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      const countOf = (type: string) =>
        commandTypes.filter((commandType) => commandType === type).length;

      try {
        runThreadStorageOrphanSweep(harness.deps);
        await vi.waitFor(() => {
          expect(storedIds.size).toBe(50);
        });
        await sleep(20);

        runThreadStorageOrphanSweep(harness.deps);
        await vi.waitFor(() => {
          expect(storedIds.size).toBe(0);
        });
        await sleep(20);

        runThreadStorageOrphanSweep(harness.deps);
        await sleep(20);
        expect(countOf("host.browse_directory")).toBe(1);
        expect(countOf("host.delete_thread_storage")).toBe(
          THREAD_STORAGE_ORPHAN_PASS_LIMITS.maxRemovals + 50,
        );
      } finally {
        responder.unregister();
      }
    });
  });

  it("continues removing orphaned directories after a removal fails", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rootPath = path.join(session.dataDir, "thread-storage");
      const rejectedPath = path.join(rootPath, "thr_2222222222");
      const removablePath = path.join(rootPath, "thr_3333333333");
      const attemptedPaths: string[] = [];

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "host.browse_directory") {
            return {
              ok: true,
              result: {
                directory: rootPath,
                parent: session.dataDir,
                entries: [rejectedPath, removablePath].map((entryPath) => ({
                  kind: "directory" as const,
                  name: path.basename(entryPath),
                  path: entryPath,
                })),
              },
            };
          }

          if (request.command.type === "host.delete_thread_storage") {
            attemptedPaths.push(path.join(rootPath, request.command.threadId));

            if (
              path.join(rootPath, request.command.threadId) === rejectedPath
            ) {
              return {
                ok: false,
                errorCode: "invalid_path",
                errorMessage: `Path "${rejectedPath}" must not be a symbolic link`,
              };
            }

            return { ok: true, result: { ok: true } };
          }

          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      try {
        await removeOrphanedThreadStorage(harness.deps, {
          hostId: host.id,
          limits: { elapsedBudgetMs: 60_000, maxRemovals: 2_000 },
        });
        expect(attemptedPaths).toEqual([rejectedPath, removablePath]);
      } finally {
        responder.unregister();
      }
    });
  });

  it("starts no removals once the pass's elapsed budget is spent", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rootPath = path.join(session.dataDir, "thread-storage");
      const commandTypes: string[] = [];

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          commandTypes.push(request.command.type);

          if (request.command.type === "host.browse_directory") {
            return {
              ok: true,
              result: {
                directory: rootPath,
                parent: session.dataDir,
                entries: [
                  {
                    kind: "directory",
                    name: "thr_8888888888",
                    path: path.join(rootPath, "thr_8888888888"),
                  },
                ],
              },
            };
          }

          return { ok: true, result: { ok: true } };
        },
      });

      try {
        await removeOrphanedThreadStorage(harness.deps, {
          hostId: host.id,
          limits: { elapsedBudgetMs: 0, maxRemovals: 100 },
        });
        expect(commandTypes).toEqual(["host.browse_directory"]);
      } finally {
        responder.unregister();
      }
    });
  });

  it("moves past a rejected orphan on the next pass without listing again", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rootPath = path.join(session.dataDir, "thread-storage");
      const rejectedPath = path.join(rootPath, "thr_6666666666");
      const removablePath = path.join(rootPath, "thr_7777777777");
      const commandPaths: string[] = [];

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "host.browse_directory") {
            commandPaths.push(request.command.path ?? "");

            return {
              ok: true,
              result: {
                directory: rootPath,
                parent: session.dataDir,
                entries: [rejectedPath, removablePath].map((entryPath) => ({
                  kind: "directory" as const,
                  name: path.basename(entryPath),
                  path: entryPath,
                })),
              },
            };
          }

          if (request.command.type === "host.delete_thread_storage") {
            commandPaths.push(path.join(rootPath, request.command.threadId));

            return path.join(rootPath, request.command.threadId) ===
              rejectedPath
              ? {
                  ok: false,
                  errorCode: "invalid_path",
                  errorMessage: "must not be a symbolic link",
                }
              : { ok: true, result: { ok: true } };
          }

          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      try {
        await removeOrphanedThreadStorage(harness.deps, {
          hostId: host.id,
          limits: { elapsedBudgetMs: 60_000, maxRemovals: 1 },
        });
        await removeOrphanedThreadStorage(harness.deps, {
          hostId: host.id,
          limits: { elapsedBudgetMs: 60_000, maxRemovals: 1 },
        });
        expect(commandPaths).toEqual([rootPath, rejectedPath, removablePath]);
      } finally {
        responder.unregister();
      }
    });
  });

  it("parks the session's queue when a removal times out instead of starting more deletions", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const rootPath = path.join(session.dataDir, "thread-storage");
      const slowPath = path.join(rootPath, "thr_4444444444");
      const laterPath = path.join(rootPath, "thr_5555555555");
      const attemptedPaths: string[] = [];

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "host.browse_directory") {
            return {
              ok: true,
              result: {
                directory: rootPath,
                parent: session.dataDir,
                entries: [slowPath, laterPath].map((entryPath) => ({
                  kind: "directory" as const,
                  name: path.basename(entryPath),
                  path: entryPath,
                })),
              },
            };
          }

          if (request.command.type === "host.delete_thread_storage") {
            attemptedPaths.push(path.join(rootPath, request.command.threadId));

            return new Promise(() => {});
          }

          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      try {
        await advanceUntilSettled(
          removeOrphanedThreadStorage(harness.deps, {
            hostId: host.id,
            limits: { elapsedBudgetMs: 60_000, maxRemovals: 2_000 },
          }),
          1_000,
        );
        expect(attemptedPaths).toEqual([slowPath]);

        await removeOrphanedThreadStorage(harness.deps, {
          hostId: host.id,
          limits: { elapsedBudgetMs: 60_000, maxRemovals: 2_000 },
        });
        expect(attemptedPaths).toEqual([slowPath]);
      } finally {
        vi.useRealTimers();
        responder.unregister();
      }
    });
  });

  it("removes only thread-shaped directories that have no thread record", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });

      const liveThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });

      const deletedThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });

      markThreadDeleted(harness.db, harness.hub, {
        threadId: deletedThread.id,
      });
      const rootPath = path.join(session.dataDir, "thread-storage");

      const directory = (name: string) => ({
        kind: "directory" as const,
        name,
        path: path.join(rootPath, name),
      });

      const leadingOrphanIds = Array.from({ length: 1_000 }, (_, index) =>
        orphanedThreadIdAt(index),
      );

      const removedPaths: string[] = [];

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request: HostDaemonOnlineRpcRequestMessage) => {
          if (request.command.type === "host.browse_directory") {
            expect(request.command.path).toBe(rootPath);

            return {
              ok: true,
              result: {
                directory: rootPath,
                parent: session.dataDir,
                entries: [
                  ...leadingOrphanIds.map(directory),
                  directory(liveThread.id),
                  directory(deletedThread.id),
                  directory(ORPHANED_THREAD_ID),
                  directory("workflows"),
                  {
                    kind: "file",
                    name: "thr_bcdefghijk",
                    path: path.join(rootPath, "thr_bcdefghijk"),
                  },
                ],
              },
            };
          }

          if (request.command.type === "host.delete_thread_storage") {
            expect(Object.keys(request.command).sort()).toEqual([
              "threadId",
              "type",
            ]);
            removedPaths.push(path.join(rootPath, request.command.threadId));

            return { ok: true, result: { ok: true } };
          }

          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      await removeOrphanedThreadStorage(harness.deps, {
        hostId: host.id,
        limits: { elapsedBudgetMs: 60_000, maxRemovals: 2_000 },
      });
      responder.unregister();

      expect(removedPaths).toEqual(
        [...leadingOrphanIds, ORPHANED_THREAD_ID].map((threadId) =>
          path.join(rootPath, threadId),
        ),
      );
    });
  });
});
