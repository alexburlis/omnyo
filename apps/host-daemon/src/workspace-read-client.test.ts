import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainIsolatedFilesystemReaders,
  IsolatedFilesystemMutator,
  startFileChunkReader,
  readIsolatedFilesystemCommand,
} from "./workspace-read-client.js";

const { children, forkOptions } = vi.hoisted(() => ({
  children: [] as ChildProcess[],
  forkOptions: { stopOnFork: false },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();

  return {
    ...original,
    fork: (...args: Parameters<typeof original.fork>) => {
      const child = original.fork(...args);
      children.push(child);

      if (forkOptions.stopOnFork) child.kill("SIGSTOP");

      return child;
    },
  };
});

const directories: string[] = [];

const mutators: IsolatedFilesystemMutator[] = [];

async function repository(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "omnyo-git-reader-"));
  directories.push(directory);
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Omnyo Test",
      "-c",
      "user.email=omnyo@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    ],
    { cwd: directory, stdio: "ignore" },
  );
  execFileSync("git", ["branch", "topic"], { cwd: directory, stdio: "ignore" });

  return directory;
}

function mutator(dataDir: string): IsolatedFilesystemMutator {
  const owner = new IsolatedFilesystemMutator({ dataDir });
  mutators.push(owner);

  return owner;
}

function runningPids(): number[] {
  return children.flatMap((child) => {
    if (child.pid === undefined) return [];

    try {
      process.kill(child.pid, 0);

      return [child.pid];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return [];
      throw error;
    }
  });
}

async function waitForExit(pids = runningPids()): Promise<void> {
  for (
    let attempts = 0;
    attempts < 100 && runningPids().some((pid) => pids.includes(pid));
    attempts += 1
  ) {
    await delay(10);
  }

  expect(runningPids().filter((pid) => pids.includes(pid))).toEqual([]);
}

function branches(owner: IsolatedFilesystemMutator, repo: string) {
  return owner.execute({
    type: "host.list_branch_options",
    path: repo,
    limit: 50,
    remoteRefresh: "none",
  });
}

afterEach(async () => {
  forkOptions.stopOnFork = false;
  vi.useRealTimers();
  await Promise.all(mutators.splice(0).map((owner) => owner.dispose()));

  for (const child of children) {
    if (child.pid !== undefined && runningPids().includes(child.pid)) {
      child.kill("SIGCONT");
    }
  }

  await waitForExit();
  children.length = 0;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("isolated Git reader lifecycle", () => {
  it("reuses active repositories, retires idle helper PIDs, and recreates the same Git result", async () => {
    const repos = await Promise.all([repository(), repository()]);
    const owner = mutator(repos[0]!);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const results = await Promise.all(
      repos.map((repo) => branches(owner, repo)),
    );

    for (const result of results)
      expect(result.branches).toEqual(["main", "topic"]);
    const initialPids = runningPids();
    expect(initialPids).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await branches(owner, `${repos[0]}/.`)).toEqual(results[0]);
    expect(runningPids()).toEqual(initialPids);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForExit([initialPids[1]!]);
    expect(runningPids()).toEqual([initialPids[0]]);
    await vi.advanceTimersByTimeAsync(59_000);
    await waitForExit();

    expect(await branches(owner, repos[0]!)).toEqual(results[0]);
    const recreatedPids = runningPids();
    expect(recreatedPids).toHaveLength(1);
    expect(initialPids).not.toContain(recreatedPids[0]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps pending Git requests alive beyond the idle deadline and drains them on owner disposal",
    async () => {
      const repo = await repository();
      const owner = mutator(repo);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const expected = await branches(owner, repo);
      const child = children[0]!;
      expect(child.kill("SIGSTOP")).toBe(true);
      const pending = branches(owner, repo);
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      expect(runningPids()).toEqual([child.pid]);
      await owner.dispose();
      expect(child.kill("SIGCONT")).toBe(true);
      expect(await pending).toEqual(expected);
      await waitForExit();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vi.getTimerCount()).toBe(0);
      await expect(branches(owner, repo)).rejects.toMatchObject({
        code: "filesystem_mutator_stopped",
      });
      expect(runningPids()).toEqual([]);
    },
  );
});

describe("isolated filesystem mutator recovery", () => {
  async function killChildren(): Promise<void> {
    for (const child of children) child.kill("SIGKILL");
    await waitForExit();
  }

  it("replaces a dead mutation reader instead of failing later mutations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omnyo-mutator-"));
    directories.push(directory);
    const owner = mutator(directory);

    const mkdir = (name: string) =>
      owner.execute({
        type: "host.mkdir",
        path: path.join(directory, name),
        recursive: true,
      });

    await mkdir("first");
    await killChildren();
    await expect(mkdir("second")).resolves.toBeDefined();
  });

  it("replaces a dead Git reader before its idle deadline", async () => {
    const repo = await repository();
    const owner = mutator(repo);
    const expected = await branches(owner, repo);
    await killChildren();

    expect(await branches(owner, repo)).toEqual(expected);
  });

  it.skipIf(process.platform === "win32")(
    "waits for a slow reader start and reports an unsent mutation as retryable",
    async () => {
      const repo = await repository();
      const owner = mutator(repo);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      forkOptions.stopOnFork = true;
      const pending = branches(owner, repo);

      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(1);
      expect(runningPids()).toEqual([children[0]!.pid]);
      await vi.advanceTimersByTimeAsync(20_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toMatchObject({ code: "mutation_outcome_unknown" });
      expect(error).toMatchObject({
        message: "Workspace reader did not become ready",
      });
      children[0]!.kill("SIGCONT");
    },
  );
});

describe("isolated filesystem reader pool", () => {
  afterEach(async () => {
    await drainIsolatedFilesystemReaders();
  });

  it("returns binary file chunks across the isolated read process", async () => {
    const directory = await repository();
    const target = path.join(directory, "sample.dat");
    await writeFile(target, Buffer.from([0, 129, 255]));

    const result = await readIsolatedFilesystemCommand(
      {
        type: "host.read_file_chunk",
        path: target,
        rootPath: directory,
        offset: 1,
        length: 2,
        revision: null,
      },
      {},
    );

    expect(Buffer.from(result.content)).toEqual(Buffer.from([129, 255]));
  });

  it("serves concurrent file chunks through one running reader and replaces it after exit", async () => {
    const directory = await repository();
    const target = path.join(directory, "image.jpg");
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    await writeFile(target, bytes);

    const read = (offset: number) =>
      readIsolatedFilesystemCommand({
        type: "host.read_file_chunk",
        path: target,
        rootPath: directory,
        offset,
        length: 1,
        revision: null,
      });

    startFileChunkReader();
    expect(children).toHaveLength(1);

    const responses = await Promise.all(
      Array.from(bytes, (_, index) => read(index)),
    );

    expect(responses.map((result) => result.content[0])).toEqual([...bytes]);
    expect(children).toHaveLength(1);
    children[0]!.kill("SIGKILL");
    await waitForExit();
    expect((await read(2)).content[0]).toBe(3);
    expect(children).toHaveLength(2);
    await drainIsolatedFilesystemReaders();
    await waitForExit();
  });

  function pathsExist(target: string) {
    return readIsolatedFilesystemCommand({
      type: "host.paths_exist",
      paths: [target, path.join(target, "missing")],
    });
  }

  it("reuses a warm reader for sequential reads, gives concurrent reads their own reader, and replaces dead readers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omnyo-reader-pool-"));
    directories.push(directory);

    const expected = {
      existence: {
        [directory]: true,
        [path.join(directory, "missing")]: false,
      },
    };

    expect(await pathsExist(directory)).toEqual(expected);
    expect(await pathsExist(directory)).toEqual(expected);
    expect(children).toHaveLength(1);

    expect(
      await Promise.all([pathsExist(directory), pathsExist(directory)]),
    ).toEqual([expected, expected]);
    expect(children).toHaveLength(2);

    for (const child of children) child.kill("SIGKILL");
    await waitForExit();

    expect(await pathsExist(directory)).toEqual(expected);
    expect(children).toHaveLength(3);
    expect(runningPids()).toEqual([children[2]!.pid]);

    await drainIsolatedFilesystemReaders();
    await waitForExit();
  });
});
