import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { CatalogCache, catalogWatchTouches } from "../src/catalog-cache.js";
import { readMarkdownHeader } from "@omnyo/process-utils";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type {
  HostWatcher,
  WatchPathRootArgs,
} from "../src/host-watcher-types.js";

async function fixture(
  run: (
    root: string,
    watched: WatchPathRootArgs[],
    stopped: ReturnType<typeof vi.fn>,
    cache: CatalogCache<string>,
  ) => Promise<void>,
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-command-cache-")),
  );

  const watched: WatchPathRootArgs[] = [];
  const stopped = vi.fn();

  const watcher: HostWatcher = {
    watchWorkspace: () => () => undefined,
    watchThreadStorage: () => () => undefined,
    watchPathRoot: (args) => {
      watched.push(args);
      queueMicrotask(args.onReady);

      return stopped;
    },
  };

  const cache = new CatalogCache<string>(watcher, () => undefined);

  try {
    await run(root, watched, stopped, cache);
  } finally {
    await cache.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("watched command catalog", () => {
  it("checks sibling metadata while an earlier file is pending", async () => {
    await fixture(async (root, _watched, _stopped, cache) => {
      const firstPath = path.join(root, "a.md");
      const secondPath = path.join(root, "b.md");
      await fs.writeFile(firstPath, "first");
      await fs.writeFile(secondPath, "second");
      const firstStarted = createDeferredPromise<void>();
      const releaseFirst = createDeferredPromise<void>();
      const originalLstat = fs.lstat.bind(fs);
      let held = false;
      let secondStarted = false;

      const lstat = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (...args) => {
          if (String(args[0]) === firstPath && !held) {
            held = true;
            firstStarted.resolve();
            await releaseFirst.promise;
          }

          if (String(args[0]) === secondPath) secondStarted = true;

          return originalLstat(...args);
        });

      const reading = cache.get("scope", async (observe) => {
        await observe(root, true);

        return "metadata";
      });

      try {
        await firstStarted.promise;
        await setImmediate();
        expect(secondStarted).toBe(true);
      } finally {
        releaseFirst.resolve();
        await reading;
        lstat.mockRestore();
      }

      expect(await reading).toBe("metadata");
    });
  });

  it("publishes metadata while unrelated nested files keep changing", async () => {
    await fixture(async (root, watched, _stopped, cache) => {
      const header = path.join(root, "SKILL.md");
      const references = path.join(root, "references");
      const body = path.join(references, "guide.md");
      await fs.mkdir(references);
      await fs.writeFile(header, "metadata");
      await fs.writeFile(body, "original guide");
      let edits = 0;

      const value = await cache.get("scope", async (observe) => {
        await observe(root);
        await observe(header);
        const metadata = await fs.readFile(header, "utf8");
        await fs.writeFile(body, `updated guide ${++edits}`);
        watched[0]!.onChange([{ path: body, type: "update" }]);

        return metadata;
      });

      expect(value).toBe("metadata");
    });
  });

  it("shares in-flight scans and invalidates only affected scopes", async () => {
    await fixture(async (root, watched, _stopped, cache) => {
      const file = path.join(root, "SKILL.md");
      await fs.writeFile(file, "old");

      const build = vi.fn(
        async (observe: (target: string) => Promise<void>) => {
          await observe(file);

          return fs.readFile(file, "utf8");
        },
      );

      expect(
        await Promise.all([cache.get("a", build), cache.get("a", build)]),
      ).toEqual(["old", "old"]);
      const before = build.mock.calls.length;
      expect(await cache.get("a", build)).toBe("old");
      expect(build).toHaveBeenCalledTimes(before);
      await fs.writeFile(file, "new");
      watched[0]!.onChange([{ path: file, type: "update" }]);
      expect(await cache.get("a", build)).toBe("new");
      expect(watched).toHaveLength(1);
      await fs.writeFile(file, "missed event");
      expect(await cache.get("a", build)).toBe("missed event");
    });
  });

  it("never publishes a generation changed during its scan", async () => {
    await fixture(async (root, watched, _stopped, cache) => {
      let builds = 0;

      const value = await cache.get("a", async (observe) => {
        await observe(root);
        builds++;

        if (builds === 1) {
          watched[0]!.onRescanRequired();

          return "obsolete";
        }

        return "current";
      });

      expect(value).toBe("current");
    });
  });

  it("rebuilds metadata when an observed header changes during its scan", async () => {
    await fixture(async (root, watched, _stopped, cache) => {
      const header = path.join(root, "SKILL.md");
      await fs.writeFile(header, "old metadata");
      let edited = false;

      const value = await cache.get("scope", async (observe) => {
        await observe(header);
        const metadata = await fs.readFile(header, "utf8");

        if (!edited) {
          edited = true;
          await fs.writeFile(header, "new metadata");
          watched[0]!.onChange([{ path: header, type: "update" }]);
        }

        return metadata;
      });

      expect(value).toBe("new metadata");
    });
  });

  it("fails visibly on lost watching, recovers, and releases evicted watchers", async () => {
    await fixture(async (root, watched, stopped, cache) => {
      const build = async (observe: (target: string) => Promise<void>) => {
        await observe(root);

        return "current";
      };

      await cache.get("a", build);
      watched[0]!.onWatchError({ rootPath: root, message: "watch lost" });
      await expect(cache.get("a", build)).rejects.toThrow("watch lost");
      watched[0]!.onReady();
      expect(await cache.get("a", build)).toBe("current");
      await cache.get("b", async (observe) => {
        const child = path.join(root, "b");
        await fs.mkdir(child);
        await observe(child);

        return "b";
      });

      for (let index = 0; index < 33; index++)
        await cache.get(`scope-${index}`, async () => "c");
      expect(stopped).toHaveBeenCalledTimes(1);
      await cache.dispose();
      expect(stopped).toHaveBeenCalledTimes(1);
    });
  });

  it("observes creation beneath an initially missing skills root", async () => {
    await fixture(async (root, watched, _stopped, cache) => {
      const missing = path.join(root, "skills");

      const build = async (observe: (target: string) => Promise<void>) => {
        await observe(missing);

        return fs.readdir(missing).then(
          (items) => items.join(","),
          () => "missing",
        );
      };

      expect(await cache.get("a", build)).toBe("missing");
      await fs.mkdir(missing);
      await fs.writeFile(path.join(missing, "SKILL.md"), "new");
      watched[0]!.onChange([{ path: missing, type: "create" }]);
      expect(await cache.get("a", build)).toBe("SKILL.md");
    });
  });

  it("releases roots that leave a scope after configuration changes", async () => {
    await fixture(async (root, watched, stopped, cache) => {
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      await fs.mkdir(first);
      await fs.mkdir(second);
      let selected = first;

      const build = async (observe: (target: string) => Promise<void>) => {
        await observe(selected);

        return selected;
      };

      expect(await cache.get("scope", build)).toBe(first);
      selected = second;
      cache.invalidate();
      expect(await cache.get("scope", build)).toBe(second);
      expect(watched).toHaveLength(2);
      expect(stopped).toHaveBeenCalledTimes(1);
      await cache.dispose();
      expect(stopped).toHaveBeenCalledTimes(2);
    });
  });

  it("releases direct roots only after their last retained scope leaves", async () => {
    await fixture(async (root, watched, stopped, cache) => {
      const scopes = [
        { cwd: "/first", providerId: "test" },
        { cwd: "/second", providerId: "test" },
      ];

      const build = vi.fn(
        async (observe: (target: string) => Promise<void>) => {
          await observe(root);

          return "metadata";
        },
      );

      await cache.getSnapshot("first", build, scopes[0]);
      await cache.getSnapshot("second", build, scopes[1]);
      expect(watched).toHaveLength(1);
      await cache.retain([scopes[1]!]);
      expect(stopped).not.toHaveBeenCalled();
      await cache.getSnapshot("second", build, scopes[1]);
      expect(build).toHaveBeenCalledTimes(2);
      await cache.retain([]);
      expect(stopped).toHaveBeenCalledTimes(1);
    });
  });

  it("does not let an evicted pending read replace or charge a recreated key", async () => {
    await fixture(async (root, watched, stopped, cache) => {
      const scope = { cwd: root, providerId: "test" };
      const started = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();

      const old = cache.getSnapshot(
        "same",
        async (observe) => {
          await observe(root);
          started.resolve();
          await release.promise;
          await observe(path.join(root, "late"));

          return "x".repeat(9 * 1024 * 1024);
        },
        scope,
      );

      try {
        await started.promise;
        await cache.retain([]);
        expect(stopped).toHaveBeenCalledTimes(1);

        const replacement = vi.fn(
          async (observe: (target: string) => Promise<void>) => {
            await observe(root);

            return "replacement";
          },
        );

        await cache.getSnapshot("same", replacement, scope);
        release.resolve();
        expect((await old).value).toHaveLength(9 * 1024 * 1024);
        await cache.getSnapshot(
          "other",
          async () => "y".repeat(8 * 1024 * 1024),
          scope,
        );
        watched[0]!.onRescanRequired();
        expect(
          (await cache.getSnapshot("same", replacement, scope)).value,
        ).toBe("replacement");
        expect(replacement).toHaveBeenCalledTimes(1);
        expect(watched).toHaveLength(2);
        expect(stopped).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await old;
      }
    });
  });

  it("does not install a subscription whose pending preflight lost its consumer", async () => {
    await fixture(async (root, watched, _stopped, cache) => {
      const started = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      const original = fs.readdir.bind(fs);
      let held = false;

      const readdir = vi
        .spyOn(fs, "readdir")
        .mockImplementation(async (...args) => {
          if (String(args[0]) === root && !held) {
            held = true;
            started.resolve();
            await release.promise;
          }

          return original(...args);
        });

      const pending = cache.getSnapshot(
        "key",
        async (observe) => {
          await observe(path.join(root, "missing"));

          return "metadata";
        },
        { cwd: root, providerId: "test" },
      );

      try {
        await started.promise;
        await cache.retain([]);
        release.resolve();
        expect((await pending).value).toBe("metadata");
        expect(watched).toEqual([]);
      } finally {
        release.resolve();
        await pending;
        readdir.mockRestore();
      }
    });
  });

  it("finishes a detached read when its released watcher was not ready", async () => {
    await fixture(async (root) => {
      const started = createDeferredPromise<void>();
      const watched: WatchPathRootArgs[] = [];
      const stop = vi.fn();

      const cache = new CatalogCache<string>(
        {
          watchWorkspace: () => () => undefined,
          watchThreadStorage: () => () => undefined,
          watchPathRoot: (args) => {
            watched.push(args);
            started.resolve();

            return stop;
          },
        },
        () => undefined,
      );

      const reading = cache.getSnapshot(
        "key",
        async (observe) => {
          await observe(root);

          return "metadata";
        },
        { cwd: root, providerId: "test" },
      );

      try {
        await started.promise;
        await cache.retain([]);
        expect((await reading).value).toBe("metadata");
        expect(stop).toHaveBeenCalledTimes(1);
        expect(watched).toHaveLength(1);
      } finally {
        watched[0]?.onReady();
        await reading;
        await cache.dispose();
      }
    });
  });
});

describe("observed command catalog", () => {
  it("returns the same roots and filters as native watching without subscribing", async () => {
    await fixture(async (root, watched) => {
      const cache = new CatalogCache<string>({ mode: "observation-only" });

      const direct = new CatalogCache<string>(
        {
          watchWorkspace: () => () => undefined,
          watchThreadStorage: () => () => undefined,
          watchPathRoot: (args) => {
            watched.push(args);
            queueMicrotask(args.onReady);

            return () => undefined;
          },
        },
        () => undefined,
      );

      const missing = path.join(root, "missing", "SKILL.md");
      const existing = path.join(root, "unrelated");
      await fs.mkdir(existing);

      const build = async (observe: (target: string) => Promise<void>) => {
        await observe(missing);

        return "metadata";
      };

      try {
        const observed = await cache.getSnapshot("key", build);
        expect(watched).toEqual([]);
        const subscribed = await direct.getSnapshot("key", build);
        expect(observed).toEqual(subscribed);
        expect(observed.watches).toEqual([
          {
            rootPath: root,
            ignoredPaths: ["**/node_modules/**", "**/.git/**", existing],
            targets: [{ path: missing, shallow: false }],
          },
        ]);
      } finally {
        await Promise.all([cache.dispose(), direct.dispose()]);
      }
    });
  });

  it("refreshes missing-root and ignore preflight even when metadata is cached", async () => {
    await fixture(async (root) => {
      const cache = new CatalogCache<string>({ mode: "observation-only" });
      const parent = path.join(root, "new-parent");
      const missing = path.join(parent, "missing");

      const build = vi.fn(
        async (observe: (target: string) => Promise<void>) => {
          await observe(missing);

          return "missing";
        },
      );

      try {
        const first = await cache.getSnapshot("key", build);
        await fs.mkdir(parent);
        const unrelated = path.join(parent, "unrelated");
        await fs.mkdir(unrelated);
        const second = await cache.getSnapshot("key", build);
        expect(build).toHaveBeenCalledTimes(1);
        expect(first.watches[0]?.rootPath).toBe(root);
        expect(second.watches).toEqual([
          {
            rootPath: parent,
            ignoredPaths: ["**/node_modules/**", "**/.git/**", unrelated],
            targets: [{ path: missing, shallow: false }],
          },
        ]);
        await fs.rmdir(unrelated);
        await fs.rmdir(parent);
        expect((await cache.getSnapshot("key", build)).watches).toEqual(
          first.watches,
        );
        expect(build).toHaveBeenCalledTimes(1);
      } finally {
        await cache.dispose();
      }
    });
  });

  it("keeps each concurrent response bound to its key across pruning", async () => {
    await fixture(async (root) => {
      const cache = new CatalogCache<string>({ mode: "observation-only" });
      const released = createDeferredPromise<void>();
      const started = createDeferredPromise<void>();
      const file = path.join(root, "first.md");
      await fs.writeFile(file, "first");

      const build = vi.fn(
        async (observe: (target: string) => Promise<void>) => {
          await observe(file);
          started.resolve();
          await released.promise;

          return "first";
        },
      );

      try {
        const first = cache.getSnapshot("first", build);
        const coalesced = cache.getSnapshot("first", build);
        await started.promise;

        const others = await Promise.all(
          Array.from({ length: 34 }, (_, index) =>
            cache.getSnapshot(`key-${index}`, async (observe) => {
              const target = path.join(root, `missing-${index}`);
              await observe(target);

              return target;
            }),
          ),
        );

        released.resolve();
        const snapshot = await first;
        expect(await coalesced).toEqual(snapshot);
        expect(build).toHaveBeenCalledTimes(1);
        expect(snapshot.watches[0]?.targets).toEqual([
          { path: file, shallow: false },
        ]);

        for (let index = 0; index < others.length; index++)
          expect(others[index]?.watches[0]?.targets).toEqual([
            { path: path.join(root, `missing-${index}`), shallow: false },
          ]);
        await cache.getSnapshot("last", async () => "last");
        expect(snapshot.value).toBe("first");
        expect(snapshot.watches[0]?.targets).toEqual([
          { path: file, shallow: false },
        ]);
      } finally {
        released.resolve();
        await cache.dispose();
      }
    });
  });

  it("revalidates file stamps and symlink targets without native events", async () => {
    await fixture(async (root) => {
      const cache = new CatalogCache<string>({ mode: "observation-only" });
      const physical = path.join(root, "physical");
      const linked = path.join(root, "linked");
      await fs.mkdir(physical);
      await fs.symlink(physical, linked);
      const file = path.join(linked, "SKILL.md");
      await fs.writeFile(file, "old");
      let edited = false;

      const build = async (observe: (target: string) => Promise<void>) => {
        await observe(file);
        const value = await fs.readFile(file, "utf8");

        if (!edited) {
          edited = true;
          await fs.writeFile(file, "changed during scan");
        }

        return value;
      };

      try {
        const first = await cache.getSnapshot("key", build);
        expect(first.value).toBe("changed during scan");
        expect(first.watches.flatMap((watch) => watch.targets)).toEqual(
          expect.arrayContaining([
            { path: file, shallow: false },
            { path: path.join(physical, "SKILL.md"), shallow: false },
          ]),
        );
        await fs.writeFile(file, "changed after retirement");
        expect((await cache.getSnapshot("key", build)).value).toBe(
          "changed after retirement",
        );
      } finally {
        await cache.dispose();
      }
    });
  });

  it("keeps the cached observation compact when child stamps complete first", async () => {
    await fixture(async (root) => {
      const cache = new CatalogCache<string>({ mode: "observation-only" });
      const child = path.join(root, "child");
      const file = path.join(child, "SKILL.md");
      await fs.mkdir(child);
      await fs.writeFile(file, "metadata");
      const rootStampStarted = createDeferredPromise<void>();
      const releaseRoot = createDeferredPromise<void>();
      const originalLstat = fs.lstat.bind(fs);
      let held = false;

      const lstat = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (...args) => {
          if (String(args[0]) === root && !held) {
            held = true;
            rootStampStarted.resolve();
            await releaseRoot.promise;
          }

          return originalLstat(...args);
        });

      try {
        const first = await cache.getSnapshot("key", async (observe) => {
          const observingRoot = observe(root);
          await rootStampStarted.promise;
          await observe(file);
          releaseRoot.resolve();
          await observingRoot;

          return "metadata";
        });

        const second = await cache.getSnapshot("key", async () => "unexpected");
        expect(first.watches).toHaveLength(1);
        expect(second.watches).toEqual(first.watches);
      } finally {
        releaseRoot.resolve();
        lstat.mockRestore();
        await cache.dispose();
      }
    });
  });

  it("preflights a recursive root once while validating every covered target", async () => {
    await fixture(async (root) => {
      const cache = new CatalogCache<string>({ mode: "observation-only" });

      const files = await Promise.all(
        Array.from({ length: 4 }, async (_, index) => {
          const file = path.join(root, `skill-${index}.md`);
          await fs.writeFile(file, "metadata");

          return file;
        }),
      );

      const stat = vi.spyOn(fs, "stat");
      const lstat = vi.spyOn(fs, "lstat");

      try {
        await cache.getSnapshot("key", async (observe) => {
          await observe(root);
          await Promise.all(files.map((file) => observe(file)));

          return "metadata";
        });
        stat.mockClear();
        lstat.mockClear();
        await cache.getSnapshot("key", async () => "unexpected");
        expect(stat.mock.calls.map(([target]) => target)).toEqual([root]);
        expect(lstat.mock.calls.map(([target]) => target).sort()).toEqual(
          [root, ...files].sort(),
        );
      } finally {
        stat.mockRestore();
        lstat.mockRestore();
        await cache.dispose();
      }
    });
  });
});

it("shares exact recursive, shallow, and ancestor target matching", () => {
  expect(
    catalogWatchTouches({ path: "/skills", shallow: true }, "/skills/a.md"),
  ).toBe(true);
  expect(
    catalogWatchTouches(
      { path: "/skills", shallow: true },
      "/skills/nested/a.md",
    ),
  ).toBe(false);
  expect(
    catalogWatchTouches(
      { path: "/skills", shallow: false },
      "/skills/nested/a.md",
    ),
  ).toBe(true);
  expect(
    catalogWatchTouches({ path: "/skills/review", shallow: false }, "/skills"),
  ).toBe(true);
  expect(
    catalogWatchTouches({ path: "/skills", shallow: false }, "/other"),
  ).toBe(false);
});

it("reads bounded frontmatter without retaining a large skill body", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "SKILL.md");
    const header = "---\nname: review\ndescription: Review café\n---\n";
    await fs.writeFile(file, header + "body".repeat(1024 * 1024));
    expect(await readMarkdownHeader(file)).toBe(header);
  });
});
