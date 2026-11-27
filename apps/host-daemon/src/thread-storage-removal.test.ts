import { beforeEach, expect, it, vi } from "vitest";
import { removeThreadStorage } from "./thread-storage-removal.js";

const fixture = vi.hoisted(() => ({
  receipt: false,
  lateReceipt: false,
  rootLink: false,
  targetLink: false,
  missing: false,
  unreadable: false,
  calls: [] as string[],
}));

vi.mock("node:fs/promises", () => ({
  default: {
    lstat: vi.fn(async (value: string) => {
      if (fixture.missing)
        throw Object.assign(new Error("missing"), { code: "ENOENT" });

      if (value.endsWith("storage-retention.json")) {
        fixture.calls.push("receipt");

        if (fixture.unreadable)
          throw Object.assign(new Error("unreadable"), { code: "EACCES" });

        if (!fixture.receipt)
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }

      return {
        isSymbolicLink: () =>
          value.endsWith("thread-storage")
            ? fixture.rootLink
            : fixture.targetLink,
        isDirectory: () => true,
      };
    }),
    realpath: vi.fn(async (value: string) => value),
    rm: vi.fn(async () => {
      fixture.calls.push("remove");
    }),
  },
}));

vi.mock("@omnyo/process-utils", async (original) => ({
  ...(await original<typeof import("@omnyo/process-utils")>()),
  killProcessesWithCwdUnder: vi.fn(async () => {
    fixture.calls.push("kill");

    if (fixture.lateReceipt) fixture.receipt = true;
  }),
}));

beforeEach(() => {
  Object.assign(fixture, {
    receipt: false,
    lateReceipt: false,
    rootLink: false,
    targetLink: false,
    missing: false,
    unreadable: false,
    calls: [],
  });
});

const args = { rootPath: "/fixture/thread-storage", threadId: "thr_fixture" };

it.each(["ignore", "error"] as const)(
  "checks receipt on both sides of termination with %s missing behavior",
  async (missingDirectory) => {
    await removeThreadStorage({ ...args, missingDirectory });
    expect(fixture.calls).toEqual(["receipt", "kill", "receipt", "remove"]);
  },
);

it("refuses an existing receipt before termination", async () => {
  fixture.receipt = true;
  await expect(
    removeThreadStorage({ ...args, missingDirectory: "ignore" }),
  ).rejects.toMatchObject({
    code: "command_failed",
    message: "Thread storage has a retention receipt",
  });
  expect(fixture.calls).toEqual(["receipt"]);
});

it("refuses a receipt created while processes terminate", async () => {
  fixture.lateReceipt = true;
  await expect(
    removeThreadStorage({ ...args, missingDirectory: "error" }),
  ).rejects.toMatchObject({ code: "command_failed" });
  expect(fixture.calls).toEqual(["receipt", "kill", "receipt"]);
});

it.each(["rootLink", "targetLink"] as const)(
  "rejects %s before termination",
  async (kind) => {
    fixture[kind] = true;
    await expect(
      removeThreadStorage({ ...args, missingDirectory: "ignore" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(fixture.calls).toEqual([]);
  },
);

it.each(["..", ".", "../outside", "nested/thread"])(
  "rejects invalid directory identity %s",
  async (threadId) => {
    await expect(
      removeThreadStorage({ ...args, threadId, missingDirectory: "ignore" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(fixture.calls).toEqual([]);
  },
);

it("preserves distinct missing directory contracts", async () => {
  fixture.missing = true;
  await expect(
    removeThreadStorage({ ...args, missingDirectory: "ignore" }),
  ).resolves.toBeUndefined();
  await expect(
    removeThreadStorage({ ...args, missingDirectory: "error" }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(fixture.calls).toEqual([]);
});

it("propagates unreadable receipt errors without terminating processes", async () => {
  fixture.unreadable = true;
  await expect(
    removeThreadStorage({ ...args, missingDirectory: "ignore" }),
  ).rejects.toMatchObject({ code: "EACCES" });
  expect(fixture.calls).toEqual(["receipt"]);
});
