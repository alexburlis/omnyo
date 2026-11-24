import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
  lstat,
  lchown,
  readdir,
  rmdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer, createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  inspectOmnyoStateRoot,
  preflightOmnyoStateRootKindsV1,
  stageOmnyoStateRoot,
} from "../src/omnyo-state-root.js";
import {
  createOmnyoRootFixture,
  omnyoRootFixtureOwners,
} from "./omnyo-root-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("preserves external, broken and cyclic links without reading or copying external user work", async () => {
  const f = await createOmnyoRootFixture();
  roots.push(f.root);
  const outside = join(f.root, "external-user-source");
  await mkdir(outside);
  const privateFile = join(outside, "unreadable-user-work");
  await writeFile(privateFile, "untouched external user work", { mode: 0o000 });

  const links = {
    "absolute-user-source": outside,
    "relative-user-source": "../external-user-source",
    "broken-user-link": join(outside, "not-created"),
    "cyclic-user-link": "cyclic-user-link",
    "absolute-historical-link": join(f.input.sourceDataDir, "user-file.txt"),
  };

  for (const [name, target] of Object.entries(links))
    await symlink(target, join(f.input.sourceDataDir, name));

  try {
    f.input.expectedSourceDigest = (
      await inspectOmnyoStateRoot(f.input.sourceDataDir)
    ).digest;
    const bound = await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners);
    expect(await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners)).toEqual(
      bound,
    );

    for (const [name, target] of Object.entries(links)) {
      expect(await readlink(join(f.input.sourceDataDir, name))).toBe(target);
      expect(await readlink(join(f.input.destinationDataDir, name))).toBe(
        target,
      );
    }

    expect((await inspectOmnyoStateRoot(f.input.sourceDataDir)).digest).toBe(
      f.input.expectedSourceDigest,
    );
    await chmod(privateFile, 0o600);
    expect(await readFile(privateFile, "utf8")).toBe(
      "untouched external user work",
    );
  } finally {
    await chmod(privateFile, 0o600);
  }
});

test("rejects unsupported kinds during online preflight before a source fence or adoption journal", async () => {
  const f = await createOmnyoRootFixture();
  roots.push(f.root);
  const special = join(f.input.sourceDataDir, "user-fifo");
  await promisify(execFile)("/usr/bin/mkfifo", [special]);
  await expect(preflightOmnyoStateRootKindsV1(f.input)).rejects.toThrow(
    /unbound filesystem kind/,
  );
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  await expect(
    lstat(join(f.input.jobDir, "root-adoption.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    lstat(join(f.input.jobDir, "write-admission.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(special)).isFIFO()).toBe(true);
});

test("rejects an entry whose group the owner cannot recreate during online preflight", async (context) => {
  const f = await createOmnyoRootFixture();
  roots.push(f.root);
  const sourceGroup = (await lstat(f.input.sourceDataDir)).gid;
  const foreign = await mkdtemp("/private/tmp/omnyo-foreign-group-");
  roots.push(foreign);
  const produced = join(foreign, "moved-proof.mjs");
  await writeFile(produced, "moved from a system temporary directory");
  const foreignGroup = (await lstat(produced)).gid;

  const reachable = new Set([
    ...(process.getgroups?.() ?? []),
    process.getegid?.(),
  ]);

  if (foreignGroup === sourceGroup || reachable.has(foreignGroup))
    context.skip("this host cannot produce an unreachable group");
  const moved = join(f.input.sourceDataDir, "moved-proof.mjs");
  await rename(produced, moved);
  expect((await lstat(moved)).gid).toBe(foreignGroup);

  await expect(preflightOmnyoStateRootKindsV1(f.input)).rejects.toThrow(
    /unbound filesystem kind/,
  );

  const checkpoint = JSON.parse(
    await readFile(
      join(f.input.jobDir, "source-kinds-preflight-v1.json"),
      "utf8",
    ),
  );

  expect(checkpoint.traversal.summary.unsupported).toContainEqual({
    path: "moved-proof.mjs",
    kind: "group",
  });
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  await expect(
    lstat(join(f.input.jobDir, "root-adoption.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(moved)).gid).toBe(foreignGroup);
});

async function expectGroupRefusal(
  f: Awaited<ReturnType<typeof createOmnyoRootFixture>>,
  path: string,
) {
  await expect(preflightOmnyoStateRootKindsV1(f.input)).rejects.toThrow(
    /unbound filesystem kind/,
  );

  const checkpoint = JSON.parse(
    await readFile(
      join(f.input.jobDir, "source-kinds-preflight-v1.json"),
      "utf8",
    ),
  );

  expect(checkpoint.traversal.summary.unsupported).toContainEqual({
    path,
    kind: "group",
  });
  await expect(
    lstat(join(f.input.jobDir, "root-adoption.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
}

test("rejects a symbolic link whose settable group differs from the staging group", async (context) => {
  const f = await createOmnyoRootFixture();
  roots.push(f.root);
  const stagingGroup = (await lstat(dirname(f.input.jobDir))).gid;

  const other = (process.getgroups?.() ?? []).find(
    (gid) => gid !== stagingGroup,
  );

  if (other === undefined) {
    context.skip("this host has no second settable group");

    return;
  }

  const link = join(f.input.sourceDataDir, "grouped-link");
  await symlink("user-file.txt", link);
  await lchown(link, process.getuid?.() ?? -1, other);
  expect((await lstat(link)).gid).toBe(other);

  await expectGroupRefusal(f, "grouped-link");
});

test("rejects a source root whose group the owner cannot recreate", async (context) => {
  const f = await createOmnyoRootFixture();
  roots.push(f.root);
  const foreign = await mkdtemp("/private/tmp/omnyo-foreign-root-");
  roots.push(foreign);
  const foreignGroup = (await lstat(foreign)).gid;

  const reachable = new Set([
    ...(process.getgroups?.() ?? []),
    process.getegid?.(),
  ]);

  if (
    foreignGroup === (await lstat(dirname(f.input.jobDir))).gid ||
    reachable.has(foreignGroup)
  )
    context.skip("this host cannot produce an unreachable group");

  for (const name of await readdir(f.input.sourceDataDir))
    await rename(join(f.input.sourceDataDir, name), join(foreign, name));
  await rmdir(f.input.sourceDataDir);
  await rename(foreign, f.input.sourceDataDir);
  expect((await lstat(f.input.sourceDataDir)).gid).toBe(foreignGroup);

  await expectGroupRefusal(f, ".");
});

test("admits a bridged socket whose group the copy never recreates", async (context) => {
  const f = await createOmnyoRootFixture();
  roots.push(f.root);
  const foreign = await mkdtemp("/private/tmp/omnyo-foreign-socket-");
  roots.push(foreign);
  const bound = join(foreign, "s.sock");
  const server = createServer(() => undefined);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bound, resolve);
    });
    await chmod(bound, 0o600);
    const socketGroup = (await lstat(bound)).gid;

    const reachable = new Set([
      ...(process.getgroups?.() ?? []),
      process.getegid?.(),
    ]);

    if (
      socketGroup === (await lstat(dirname(f.input.jobDir))).gid ||
      reachable.has(socketGroup)
    )
      context.skip("this host cannot produce an unreachable group");
    await mkdir(join(f.input.sourceDataDir, "run/mcp"), {
      recursive: true,
      mode: 0o700,
    });
    const moved = join(f.input.sourceDataDir, "run/mcp/sentry.sock");
    await rename(bound, moved);
    expect((await lstat(moved)).gid).toBe(socketGroup);

    const capabilities = await preflightOmnyoStateRootKindsV1(f.input);
    expect(capabilities.socketCount).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("stages a shared IPC consumer bridge without replacing its original listener or admitting state writes", async () => {
  const f = await createOmnyoRootFixture(undefined, "/private/tmp");
  roots.push(f.root);
  const socketPath = join(f.input.sourceDataDir, "run/mcp/sentry.sock");
  await mkdir(join(f.input.sourceDataDir, "run/mcp"), {
    recursive: true,
    mode: 0o700,
  });
  const server = createServer((socket) => socket.end("same-original-owner"));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    const original = await lstat(socketPath);
    const capabilities = await preflightOmnyoStateRootKindsV1(f.input);
    expect(capabilities.socketCount).toBe(1);
    f.input.expectedSourceDigest = (
      await inspectOmnyoStateRoot(f.input.sourceDataDir)
    ).digest;
    const bound = await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners);
    expect(await stageOmnyoStateRoot(f.input, omnyoRootFixtureOwners)).toEqual(
      bound,
    );
    const consumer = join(f.input.destinationDataDir, "run/mcp/sentry.sock");
    expect(await readlink(consumer)).toBe(socketPath);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(consumer);
      let output = "";
      socket.on("data", (value) => {
        output += value.toString();
      });
      socket.once("error", reject);
      socket.once("end", () => resolve(output));
    });

    expect(response).toBe("same-original-owner");
    const retained = await lstat(socketPath);
    expect([retained.dev, retained.ino, retained.mode]).toEqual([
      original.dev,
      original.ino,
      original.mode,
    ]);

    const admission = JSON.parse(
      await readFile(join(f.input.jobDir, "write-admission.json"), "utf8"),
    );

    expect(admission.admission).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
