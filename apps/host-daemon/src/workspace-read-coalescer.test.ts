import { expect, it } from "vitest";
import {
  WORKSPACE_READ_HOST_CONCURRENCY,
  WORKSPACE_READ_PATH_CONCURRENCY,
  WorkspaceReadCoalescer,
  workspaceReadKey,
} from "./workspace-read-coalescer.js";

interface Deferred {
  resolve: (value: number) => void;
  reject: (error: Error) => void;
}

function createHarness(
  args: {
    aliases?: Record<string, string>;
    slowPaths?: readonly string[];
    missingPaths?: readonly string[];
  } = {},
) {
  let now = 0;

  const coalescer = new WorkspaceReadCoalescer({
    now: () => now,
    environmentPath: (environmentId) =>
      environmentId === "env-runtime" ? "/repo" : undefined,
    realpath: async (workspacePath) => {
      if (args.slowPaths?.includes(workspacePath) === true) await flush();

      if (args.missingPaths?.includes(workspacePath) === true)
        throw new Error(`ENOENT: no such file or directory '${workspacePath}'`);

      return args.aliases?.[workspacePath] ?? workspacePath;
    },
  });

  const started: { key: string; workspacePath: string; deferred: Deferred }[] =
    [];

  const read = (
    args: { environmentId?: string; workspacePath?: string; key?: string } = {},
  ) => {
    const workspacePath = args.workspacePath ?? "/repo";
    const key = args.key ?? "status";

    return coalescer.read({
      environmentId: args.environmentId ?? "env-1",
      workspacePath,
      key,
      load: () =>
        new Promise<number>((resolve, reject) => {
          started.push({ key, workspacePath, deferred: { resolve, reject } });
        }),
      parse: (value) => {
        if (typeof value !== "number") throw new Error("Expected a number");

        return value;
      },
    });
  };

  return {
    coalescer,
    read,
    started,
    advance(ms: number) {
      now += ms;
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

it("runs one load for concurrent reads of one workspace from several environments", async () => {
  const harness = createHarness();

  const reads = ["env-1", "env-2", "env-3", "env-4", "env-5"].map(
    (environmentId) => harness.read({ environmentId }),
  );

  await flush();
  expect(harness.started).toHaveLength(1);
  harness.started[0]!.deferred.resolve(7);

  expect(await Promise.all(reads)).toEqual([7, 7, 7, 7, 7]);
});

it("reuses a completed read for a window that scales with how long it took", async () => {
  const harness = createHarness();

  const slow = harness.read();
  await flush();
  harness.advance(10_000);
  harness.started[0]!.deferred.resolve(1);
  await slow;

  harness.advance(19_000);
  expect(await harness.read()).toBe(1);
  expect(harness.started).toHaveLength(1);

  harness.advance(1_001);
  const expired = harness.read();
  await flush();
  expect(harness.started).toHaveLength(2);
  harness.started[1]!.deferred.resolve(2);
  expect(await expired).toBe(2);

  const fast = harness.read({ workspacePath: "/fast" });
  await flush();
  harness.advance(10);
  harness.started[2]!.deferred.resolve(3);
  await fast;
  harness.advance(25);
  void harness.read({ workspacePath: "/fast" });
  await flush();
  expect(harness.started).toHaveLength(4);
});

it("never serves a read that started before a known change and queues at most one rerun", async () => {
  const harness = createHarness();
  harness.coalescer.trackEnvironment("env-2", "/repo");

  const beforeChange = harness.read();
  await flush();
  harness.coalescer.invalidateEnvironment("env-2");

  const afterChange = [harness.read(), harness.read(), harness.read()];
  harness.coalescer.invalidateEnvironment("env-1");
  afterChange.push(harness.read({ environmentId: "env-2" }));
  await flush();
  expect(harness.started).toHaveLength(2);

  harness.advance(1_000);
  harness.started[0]!.deferred.resolve(1);
  harness.started[1]!.deferred.resolve(2);
  expect(await beforeChange).toBe(1);
  expect(await Promise.all(afterChange)).toEqual([2, 2, 2, 2]);

  expect(await harness.read()).toBe(2);
  harness.coalescer.invalidateEnvironment("env-1");
  void harness.read();
  await flush();
  expect(harness.started).toHaveLength(3);
});

it("resolves untracked environments through the runtime and otherwise invalidates every workspace", async () => {
  const harness = createHarness();
  const reads = [harness.read(), harness.read({ workspacePath: "/other" })];
  await flush();
  harness.advance(1_000);

  for (const { deferred } of harness.started) deferred.resolve(1);
  await Promise.all(reads);

  harness.coalescer.invalidateEnvironment("env-runtime");
  void harness.read();
  void harness.read({ workspacePath: "/other" });
  await flush();
  expect(harness.started.map(({ workspacePath }) => workspacePath)).toEqual([
    "/repo",
    "/other",
    "/repo",
  ]);

  harness.coalescer.invalidateEnvironment("env-unknown");
  void harness.read({ workspacePath: "/other" });
  await flush();
  expect(harness.started.map(({ workspacePath }) => workspacePath)).toEqual([
    "/repo",
    "/other",
    "/repo",
    "/other",
  ]);
});

it("keeps different workspaces and different requests separate", async () => {
  const harness = createHarness();

  void harness.read({ workspacePath: "/repo-a" });
  void harness.read({ workspacePath: "/repo-b" });
  void harness.read({ workspacePath: "/repo-a", key: "diff" });
  void harness.read({ workspacePath: "/repo-a/" });
  await flush();

  expect(
    harness.started.map(({ workspacePath, key }) => `${workspacePath} ${key}`),
  ).toEqual(["/repo-a status", "/repo-b status", "/repo-a diff"]);
});

it("shares a failure with joined readers without caching it", async () => {
  const harness = createHarness();
  const reads = [harness.read(), harness.read()];
  await flush();
  harness.started[0]!.deferred.reject(new Error("git status timed out"));

  for (const read of reads)
    await expect(read).rejects.toThrow("git status timed out");

  void harness.read();
  await flush();
  expect(harness.started).toHaveLength(2);
});

it("bounds concurrent loads per workspace and per host", async () => {
  const harness = createHarness();

  for (const key of ["status", "status main", "diff"])
    void harness.read({ key });
  await flush();
  expect(harness.started).toHaveLength(WORKSPACE_READ_PATH_CONCURRENCY);

  for (let index = 0; index < 6; index += 1)
    void harness.read({ workspacePath: `/other-${index}` });
  await flush();
  expect(harness.started).toHaveLength(WORKSPACE_READ_HOST_CONCURRENCY);

  harness.started[0]!.deferred.resolve(1);
  await flush();
  expect(harness.started).toHaveLength(WORKSPACE_READ_HOST_CONCURRENCY + 1);
});

it("shares one load between a symlink and its target and rescans both after a change through either", async () => {
  const harness = createHarness({ aliases: { "/link": "/repo" } });
  const link = { environmentId: "env-link", workspacePath: "/link" };
  const real = { environmentId: "env-real", workspacePath: "/repo" };

  const reads = [harness.read(link), harness.read(real), harness.read(link)];
  await flush();
  expect(harness.started).toHaveLength(1);
  harness.advance(1_000);
  harness.started[0]!.deferred.resolve(1);
  expect(await Promise.all(reads)).toEqual([1, 1, 1]);

  harness.coalescer.invalidateEnvironment("env-link");
  const afterLinkChange = harness.read(real);
  await flush();
  expect(harness.started).toHaveLength(2);
  harness.advance(1_000);
  harness.started[1]!.deferred.resolve(2);
  expect(await afterLinkChange).toBe(2);
  expect(await harness.read(link)).toBe(2);

  harness.coalescer.invalidateEnvironment("env-real");
  const afterRealChange = harness.read(link);
  await flush();
  expect(harness.started).toHaveLength(3);
  harness.started[2]!.deferred.resolve(3);
  expect(await afterRealChange).toBe(3);
});

it("waits for a change whose path is still resolving before serving a cached read", async () => {
  const harness = createHarness({
    aliases: { "/link": "/repo" },
    slowPaths: ["/link"],
  });

  harness.coalescer.trackEnvironment("env-link", "/link");

  const first = harness.read({ environmentId: "env-real" });
  await flush();
  harness.advance(1_000);
  harness.started[0]!.deferred.resolve(1);
  expect(await first).toBe(1);

  harness.coalescer.invalidateEnvironment("env-link");
  const afterChange = harness.read({ environmentId: "env-real" });
  await flush();
  await flush();
  expect(harness.started).toHaveLength(2);
  harness.started[1]!.deferred.resolve(2);
  expect(await afterChange).toBe(2);
});

it("fails a read whose path cannot be resolved and treats an unresolvable change as a change everywhere", async () => {
  const harness = createHarness({ missingPaths: ["/gone"] });

  await expect(harness.read({ workspacePath: "/gone" })).rejects.toThrow(
    "ENOENT",
  );
  expect(harness.started).toHaveLength(0);

  const first = harness.read();
  await flush();
  harness.advance(1_000);
  harness.started[0]!.deferred.resolve(1);
  expect(await first).toBe(1);

  harness.coalescer.trackEnvironment("env-gone", "/gone");
  harness.coalescer.invalidateEnvironment("env-gone");
  void harness.read();
  await flush();
  expect(harness.started).toHaveLength(2);
});

it("builds the same request key regardless of property order", () => {
  expect(
    workspaceReadKey({ type: "workspace.diff", target: { b: 1, a: [2] } }),
  ).toBe(
    workspaceReadKey({ target: { a: [2], b: 1 }, type: "workspace.diff" }),
  );
});
