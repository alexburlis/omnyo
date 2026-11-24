import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { omnyoDesktopNativeFileClassificationsSchema } from "@omnyo/desktop-contract";
import { registerDesktopNativeFilesIpc } from "../src/desktop-native-files.js";

const ipc = vi.hoisted(() => ({ handle: vi.fn() }));

// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("electron", () => ({ ipcMain: ipc }));

it("returns verified regular-file paths without weakening the native frame binding", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "omnyo-native-attachment-"));

  try {
    const file = join(scratch, "small.txt");
    const directory = join(scratch, "folder");
    await writeFile(file, "tiny fixture");
    await mkdir(directory);
    const frame = { url: "https://owned-omnyo.test/thread" };

    const event = {
      sender: { id: 7, mainFrame: frame, isDestroyed: () => false },
      senderFrame: frame,
    };

    const navigation = {
      url: "https://owned-omnyo.test/thread",
      serverGeneration: 1,
      navigationGeneration: 1,
    };

    registerDesktopNativeFilesIpc({
      applicationWindowWebContentsIds: new Set([7]),
      getApplicationNavigation: () => navigation,
    });
    const handler = ipc.handle.mock.calls.at(-1)?.[1];

    if (!handler) throw new Error("Missing native file IPC handler");

    const response = await handler(event, {
      count: 2,
      paths: [
        { index: 0, path: file },
        { index: 1, path: directory },
      ],
    });

    expect(omnyoDesktopNativeFileClassificationsSchema.parse(response)).toEqual(
      [
        { kind: "file", path: file },
        { kind: "directory", path: directory },
      ],
    );
    await expect(
      handler(
        { ...event, senderFrame: { url: frame.url } },
        { count: 1, paths: [{ index: 0, path: file }] },
      ),
    ).rejects.toThrow(/current Omnyo app frame/u);
    frame.url = "https://foreign.test";
    await expect(
      handler(event, { count: 1, paths: [{ index: 0, path: file }] }),
    ).rejects.toThrow(/selected Omnyo app origin/u);
    frame.url = "https://owned-omnyo.test/thread";
    await expect(
      handler(event, {
        count: 1,
        paths: [{ index: 0, path: join(scratch, "missing") }],
      }),
    ).rejects.toThrow(/could not be classified/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
