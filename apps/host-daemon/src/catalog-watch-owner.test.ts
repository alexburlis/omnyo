import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostWatcher, type WatchPathRootArgs } from "@omnyo/host-watcher";
import { expect, it, vi } from "vitest";
import { CatalogWatchOwner } from "./catalog-watch-owner.js";

function fixture() {
  const opened = new Map<string, WatchPathRootArgs>();
  const closed = vi.fn();
  const notify = vi.fn();
  const invalidate = vi.fn();

  const owner = new CatalogWatchOwner(
    {
      ...createHostWatcher(),
      watchPathRoot(args) {
        opened.set(args.rootPath, args);

        return () => {
          closed(args.rootPath);
        };
      },
    },
    invalidate,
    notify,
  );

  return { owner, opened, closed, invalidate, notify };
}

function watches(rootPath: string) {
  return [
    {
      rootPath,
      ignoredPaths: [],
      targets: [{ path: rootPath, shallow: false }],
    },
  ];
}

it("reads the first published value after a shared watch becomes ready", async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "omnyo-catalog-registration-"),
  );

  const file = path.join(base, "skill.md");
  const { owner, opened, closed } = fixture();

  try {
    await writeFile(file, "before");

    const scan = async () => ({
      result: await readFile(file, "utf8"),
      watches: watches(base),
    });

    const a = owner.read({ cwd: "/a", providerId: "test" }, scan);
    const b = owner.read({ cwd: "/b", providerId: "test" }, scan);
    await vi.waitFor(() => expect(opened.has(base)).toBe(true));
    await writeFile(file, "edited during registration");
    opened.get(base)?.onReady();
    expect(await Promise.all([a, b])).toEqual([
      "edited during registration",
      "edited during registration",
    ]);
    expect(closed).not.toHaveBeenCalled();
  } finally {
    await owner.dispose();
    await rm(base, { recursive: true });
  }

  expect(closed.mock.calls).toEqual([[base]]);
});

it("preserves the prior interest on failed replacement and releases the last consumer", async () => {
  const { owner, opened, closed, notify } = fixture();

  const read = (cwd: string, root: string) =>
    owner.read({ cwd, providerId: "test" }, async () => ({
      result: root,
      watches: watches(root),
    }));

  try {
    const initial = Promise.all([read("/a", "/shared"), read("/b", "/shared")]);
    await vi.waitFor(() => expect(opened.has("/shared")).toBe(true));
    opened.get("/shared")?.onReady();
    await initial;
    const failed = read("/a", "/broken");
    const rejected = expect(failed).rejects.toThrow("registration failed");
    await vi.waitFor(() => expect(opened.has("/broken")).toBe(true));
    opened
      .get("/broken")
      ?.onWatchError({ rootPath: "/broken", message: "registration failed" });
    await rejected;
    const replacement = read("/a", "/new");
    await vi.waitFor(() => expect(opened.has("/new")).toBe(true));
    opened.get("/new")?.onReady();
    await replacement;
    expect(closed.mock.calls).toEqual([["/broken"]]);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    notify.mockClear();
    opened.get("/shared")?.onRescanRequired();
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith([{ cwd: "/b", providerId: "test" }]),
    );
    opened
      .get("/shared")
      ?.onWatchError({ rootPath: "/shared", message: "observer disconnected" });
    await expect(read("/b", "/shared")).rejects.toThrow(
      "observer disconnected",
    );
    opened.get("/shared")?.onReady();
    await expect(read("/b", "/shared")).resolves.toBe("/shared");
    await read("/b", "/new");
    expect(closed.mock.calls).toEqual([["/broken"], ["/shared"]]);
  } finally {
    await owner.dispose();
  }

  expect(closed.mock.calls).toEqual([["/broken"], ["/shared"], ["/new"]]);
});

it("stops only the last scope's subscription and fences a read retired during registration", async () => {
  const { owner, opened, closed } = fixture();
  const a = { cwd: "/a", providerId: "test" };
  const b = { cwd: "/b", providerId: "test" };

  const discover = async () => ({
    result: "shared",
    watches: watches("/shared"),
  });

  try {
    const ready = Promise.all([
      owner.read(a, discover),
      owner.read(b, discover),
    ]);

    await vi.waitFor(() => expect(opened.has("/shared")).toBe(true));
    opened.get("/shared")?.onReady();
    await ready;
    await owner.retain([a]);
    expect(closed).not.toHaveBeenCalled();

    const changing = owner.read(a, async () => ({
      result: "next",
      watches: watches("/next"),
    }));

    const rejected = expect(changing).rejects.toThrow("released");
    await vi.waitFor(() => expect(opened.has("/next")).toBe(true));
    await owner.retain([]);
    await rejected;
    expect(closed.mock.calls).toEqual([["/shared"], ["/next"]]);
  } finally {
    await owner.dispose();
  }
});
