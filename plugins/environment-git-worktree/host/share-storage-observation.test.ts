import { statfs } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { reclaimWorktreeStorage } from "./share-storage.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  statfs: vi.fn(),
}));

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  release: () => "24.0.0",
}));

vi.mock("./share-helper.js", async (original) => ({
  ...(await original<typeof import("./share-helper.js")>()),
  loadHelper: async () => ({
    executable: "/helper",
    staging: "/staging-volume",
  }),
  supportsSharing: async () => true,
}));

const stats = (available: bigint) => ({
  type: 0n,
  bsize: 4096n,
  blocks: 100n,
  bfree: available,
  bavail: available,
  files: 0n,
  ffree: 0n,
});

beforeEach(() => vi.mocked(statfs).mockReset());

it.runIf(process.platform === "darwin")(
  "reports a negative observed volume delta independently of released private bytes",
  async () => {
    vi.mocked(statfs)
      .mockResolvedValueOnce(stats(20n))
      .mockResolvedValueOnce(stats(17n));

    const result = await reclaimWorktreeStorage({
      worktrees: [],
      dataDir: "/data",
    });

    expect(result).toMatchObject({
      sharedFiles: 0,
      privateBytesReleased: 0,
      volumeFreeBytesChange: -12288,
    });
    expect(statfs).toHaveBeenNthCalledWith(1, "/staging-volume", {
      bigint: true,
    });
    expect(statfs).toHaveBeenNthCalledWith(2, "/staging-volume", {
      bigint: true,
    });
  },
);

it.runIf(process.platform === "darwin")(
  "retains unavailable volume observations without failing reclaim",
  async () => {
    vi.mocked(statfs)
      .mockRejectedValueOnce(new Error("volume observation unavailable"))
      .mockResolvedValueOnce(stats(17n));
    expect(
      await reclaimWorktreeStorage({ worktrees: [], dataDir: "/data" }),
    ).toMatchObject({ status: "completed", volumeFreeBytesChange: null });
  },
);

it.runIf(process.platform === "darwin")(
  "settles the final volume observation when reclaim is cancelled",
  async () => {
    const controller = new AbortController();
    vi.mocked(statfs)
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException("Cancelled", "AbortError"));

        return stats(20n);
      })
      .mockResolvedValueOnce(stats(21n));
    expect(
      await reclaimWorktreeStorage({
        worktrees: [{ sourcePath: "/source", path: "/target" }],
        dataDir: "/data",
        signal: controller.signal,
      }),
    ).toMatchObject({
      sharedFiles: 0,
      privateBytesReleased: 0,
      volumeFreeBytesChange: 4096,
    });
    expect(statfs).toHaveBeenCalledTimes(2);
  },
);
