import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  makeDispatchOptions,
  noopEventSink,
} from "../test/command/dispatch-helpers.js";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "./command-dispatch.js";
import { RuntimeManager } from "./runtime-manager.js";
import { CommandRouter } from "./command-router.js";
import { IsolatedFilesystemMutator } from "./workspace-read-client.js";

it.for(["thread deletion", "orphan removal"] as const)(
  "%s stops processes in nested thread storage before removing files and preserves neighboring processes",
  async (cleanup, { skip }) => {
    skip(
      process.platform === "win32",
      "killProcessesWithCwdUnder does not enumerate process working directories on Windows",
    );

    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "omnyo-storage-delete-"),
    );

    const storageRoot = path.join(root, "thread-storage");
    const storagePath = path.join(storageRoot, "thr_busy");
    const checkout = path.join(storagePath, "checkout", "app");
    const neighbor = path.join(storageRoot, "thr_busy-other");
    const receipt = path.join(root, "terminated.json");
    await fs.mkdir(checkout, { recursive: true });
    await fs.mkdir(neighbor, { recursive: true });

    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require('node:fs');
        process.on('SIGTERM', () => {
          fs.writeFileSync(process.argv[1], JSON.stringify(fs.existsSync(process.cwd())));
          process.exit(0);
        });
        setInterval(() => {}, 1000);
        process.send('ready');`,
        receipt,
      ],
      {
        cwd: checkout,
        detached: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );

    const sibling = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000); process.send('ready');"],
      {
        cwd: neighbor,
        detached: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );

    const childReady = once(child, "message");
    const siblingReady = once(sibling, "message");
    const dataDir = root;
    const filesystemMutator = new IsolatedFilesystemMutator({ dataDir });

    try {
      await Promise.all([childReady, siblingReady]);

      const options = makeDispatchOptions({
        dataDir,
        filesystemMutator,
        runtimeManager: new RuntimeManager(),
        threadStorageRootPath: storageRoot,
      });

      if (cleanup === "thread deletion") {
        await dispatchCommand(
          {
            type: "thread.storage.delete",
            threadId: "thr_busy",
            environmentId: "env_busy",
          },
          options,
        );
      } else {
        await dispatchOnlineRpcCommand(
          {
            type: "host.delete_thread_storage",
            threadId: "thr_busy",
          },
          options,
        );
      }

      await expect(fs.stat(storagePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(child.exitCode).toBe(0);
      await expect(fs.readFile(receipt, "utf8")).resolves.toBe("true");
      expect(sibling.exitCode).toBeNull();
      expect(sibling.signalCode).toBeNull();
      await expect(fs.stat(neighbor)).resolves.toMatchObject({});
    } finally {
      await filesystemMutator.dispose();
      await Promise.all(
        [child, sibling].map(async (running) => {
          if (running.exitCode !== null || running.signalCode !== null) return;
          const exited = once(running, "exit");
          running.kill("SIGKILL");
          await exited;
        }),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.for(
  ["valid", "malformed", "dangling link"].flatMap((receiptKind) =>
    ["normal", "orphan"].map((adapter) => ({ receiptKind, adapter })),
  ),
)(
  "preserves a $receiptKind retention receipt via $adapter",
  async ({ receiptKind, adapter }) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-retained-delete-")),
    );

    const storageRoot = path.join(root, "thread-storage");
    const owner = path.join(storageRoot, "thr_kept");
    await fs.mkdir(owner, { recursive: true });
    const receipt = path.join(owner, "storage-retention.json");

    if (receiptKind === "dangling link")
      await fs.symlink(path.join(root, "missing"), receipt);
    else
      await fs.writeFile(
        receipt,
        receiptKind === "valid"
          ? JSON.stringify({ keepers: ["evidence"] })
          : "malformed",
      );
    await fs.writeFile(path.join(owner, "evidence"), "unique work");
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const router = new CommandRouter({
      ...makeDispatchOptions({
        dataDir: root,
        runtimeManager: new RuntimeManager(),
        threadStorageRootPath: storageRoot,
      }),
      eventSink: noopEventSink,
      logger,
    });

    try {
      for (const requestId of ["first-refusal", "later-refusal"]) {
        await expect(
          router.handleOnlineRpcRequest({
            type: "host-rpc.request",
            requestId,
            command:
              adapter === "normal"
                ? {
                    type: "thread.storage.delete",
                    threadId: "thr_kept",
                    environmentId: "env_kept",
                  }
                : { type: "host.delete_thread_storage", threadId: "thr_kept" },
          }),
        ).resolves.toMatchObject({
          ok: false,
          errorCode: "command_failed",
          errorMessage: "Thread storage has a retention receipt",
        });
      }

      expect(logger.warn).not.toHaveBeenCalled();
      await expect(
        fs.readFile(path.join(owner, "evidence"), "utf8"),
      ).resolves.toBe("unique work");
      await expect(fs.lstat(receipt)).resolves.toBeDefined();
    } finally {
      await router.shutdownFilesystemMutations();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
