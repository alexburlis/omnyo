import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { acquireFileLock, withFileLock } from "../src/file-lock.js";

const openings = vi.hoisted(() => ({ onOpen: () => {} }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      openings.onOpen();

      return handle;
    },
  };
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "omnyo-lock-identity-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return join(directory, "server.lock");
}

it("refuses a waiter that acquired an inode moved away from the current lock path", async () => {
  const path = await fixture();
  const release = await acquireFileLock({ path, timeoutMs: 100 });
  onTestFinished(release);

  const opened = new Promise<void>((resolve) => {
    openings.onOpen = resolve;
  });

  const waiting = acquireFileLock({ path, timeoutMs: 1_000 });

  await opened;
  await rename(path, `${path}.archived`);
  await writeFile(path, "replacement", { mode: 0o600 });
  await release();
  await expect(waiting).rejects.toThrow("File lock path changed");
  const releaseReplacement = await acquireFileLock({ path, timeoutMs: 100 });
  await Promise.all([releaseReplacement(), releaseReplacement()]);
});

it("preserves existing-only inode admission and releases after failed work", async () => {
  const path = await fixture();
  await writeFile(path, "original", { mode: 0o600 });
  const info = await stat(path, { bigint: true });
  const identity = { device: info.dev.toString(), inode: info.ino.toString() };
  await expect(
    withFileLock({
      path,
      timeoutMs: 100,
      existingOnly: true,
      identity,
      work: async () => {
        throw new Error("work failed");
      },
    }),
  ).rejects.toThrow("work failed");
  await rename(path, `${path}.original`);
  await writeFile(path, "replacement", { mode: 0o600 });
  await expect(
    acquireFileLock({ path, timeoutMs: 100, existingOnly: true, identity }),
  ).rejects.toThrow("original inode");
  const release = await acquireFileLock({ path, timeoutMs: 100 });
  await release();
});
