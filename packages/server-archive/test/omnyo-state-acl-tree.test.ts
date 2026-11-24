import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  copyMacStateAclTreeV1,
  inspectMacStateAclV1,
} from "../mac-state-acl-v1.mjs";

const execute = promisify(execFile);

const roots: string[] = [];

const servers: Server[] = [];

const macTest = test.skipIf(process.platform !== "darwin");

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function fixture() {
  const root = await mkdtemp("/private/tmp/omnyo-acl-");
  roots.push(root);
  const source = join(root, "source");
  const destination = join(root, "destination");

  for (const dir of [source, destination]) await mkdir(dir, { mode: 0o700 });

  return {
    root,
    source,
    destination,
    options: { checkpointPath: join(root, "acl.json") },
  };
}

async function acl(path: string) {
  await execute("/bin/chmod", [
    "+a",
    `user:${userInfo().username} allow read`,
    path,
  ]);
}

async function bridgeFixture() {
  const f = await fixture();

  for (const dir of [f.source, f.destination])
    await mkdir(join(dir, "run", "mcp"), { recursive: true, mode: 0o700 });
  const path = join(f.source, "run", "mcp", "sentry.sock");
  const server = createServer();
  servers.push(server);
  server.listen(path);
  await once(server, "listening");
  await chmod(path, 0o600);
  await acl(path);
  await symlink(path, join(f.destination, "run", "mcp", "sentry.sock"));
  const info = await lstat(path, { bigint: true });

  const socketBindings = [
    {
      path: "run/mcp/sentry.sock",
      sourcePath: path,
      device: String(info.dev),
      inode: String(info.ino),
      uid: Number(info.uid),
      gid: Number(info.gid),
      mode: Number(info.mode & 0o7777n),
    },
  ];

  return { ...f, path, options: { ...f.options, socketBindings } };
}

macTest(
  "preserves an explicit live socket bridge without touching its original",
  async () => {
    const f = await bridgeFixture();
    const before = await lstat(f.path, { bigint: true });
    const beforeAcl = await inspectMacStateAclV1(f.source);

    const result = await copyMacStateAclTreeV1(
      f.source,
      f.destination,
      f.options,
    );

    expect(result).toMatchObject({
      complete: true,
      continuationPath: null,
      entriesVerified: 4,
    });
    expect(await lstat(f.path, { bigint: true })).toEqual(before);
    expect(await inspectMacStateAclV1(f.source)).toEqual(beforeAcl);
    expect(await readlink(join(f.destination, "run/mcp/sentry.sock"))).toBe(
      f.path,
    );
  },
);

macTest(
  "copies exact native ACLs with Unicode, external, broken and cyclic links",
  async () => {
    const f = await fixture();

    for (const dir of [f.source, f.destination])
      await mkdir(join(dir, "目录"), { mode: 0o750 });
    const path = join(f.source, "目录", "é.txt");
    await writeFile(path, "unchanged bytes", { mode: 0o640 });
    await copyFile(path, join(f.destination, "目录", "é.txt"));
    await chmod(join(f.destination, "目录", "é.txt"), 0o640);
    const outside = join(f.root, "outside");
    await writeFile(outside, "outside bytes", { mode: 0o600 });
    await acl(outside);
    const beforeOutside = await lstat(outside, { bigint: true });

    for (const [name, target] of [
      ["external", outside],
      ["broken", "absent"],
      ["cycle-a", "cycle-b"],
      ["cycle-b", "cycle-a"],
    ])
      for (const dir of [f.source, f.destination])
        await symlink(target, join(dir, name));

    for (const path of [
      f.source,
      join(f.source, "目录"),
      join(f.source, "目录", "é.txt"),
    ])
      await acl(path);
    const before = await inspectMacStateAclV1(f.source);

    const result = await copyMacStateAclTreeV1(
      f.source,
      f.destination,
      f.options,
    );

    expect(result.complete).toBe(true);
    expect(result.entriesVerified).toBe(7);
    expect(await inspectMacStateAclV1(f.destination)).toEqual(before);
    expect(await inspectMacStateAclV1(f.source)).toEqual(before);
    expect(await lstat(outside, { bigint: true })).toEqual(beforeOutside);
  },
);

macTest(
  "resumes bounded shards and refuses ACL drift during final verification",
  async () => {
    const f = await fixture();

    for (let i = 0; i < 6; i++)
      for (const dir of [f.source, f.destination])
        await writeFile(join(dir, String(i)), "unchanged");
    const options = { ...f.options, maxEntriesPerCall: 2 };
    let result = await copyMacStateAclTreeV1(f.source, f.destination, options);
    expect(result).toMatchObject({
      complete: false,
      continuationPath: options.checkpointPath,
      phase: "copy",
    });
    expect((await lstat(options.checkpointPath)).mode & 0o777).toBe(0o600);

    for (let i = 0; !result.complete && i < 12; i++)
      result = await copyMacStateAclTreeV1(f.source, f.destination, options);
    expect(result).toMatchObject({ complete: true, entriesVerified: 7 });
    await acl(join(f.destination, "0"));
    await expect(
      copyMacStateAclTreeV1(f.source, f.destination, f.options),
    ).rejects.toThrow(/acl-mismatch/);
  },
);

macTest(
  "rejects unbound, wrong and replaced socket bridges without modifying any target",
  async () => {
    const f = await bridgeFixture();
    const before = await lstat(f.path, { bigint: true });
    await expect(
      copyMacStateAclTreeV1(f.source, f.destination, {
        checkpointPath: join(f.root, "unbound.json"),
      }),
    ).rejects.toThrow(/socket-binding/);
    const alias = join(f.root, "linked-source");
    await symlink(f.source, alias);
    await rm(join(f.destination, "run/mcp/sentry.sock"));
    await symlink(
      join(alias, "run/mcp/sentry.sock"),
      join(f.destination, "run/mcp/sentry.sock"),
    );
    await expect(
      copyMacStateAclTreeV1(f.source, f.destination, f.options),
    ).rejects.toThrow(/bridge-drift/);
    expect(await lstat(f.path, { bigint: true })).toEqual(before);
  },
);

macTest(
  "binds continuation to exact roots and refuses unsafe checkpoint representations",
  async () => {
    const f = await fixture();
    await writeFile(join(f.source, "file"), "same");
    await writeFile(join(f.destination, "file"), "same");
    const options = { ...f.options, maxEntriesPerCall: 1 };
    expect(
      (await copyMacStateAclTreeV1(f.source, f.destination, options)).complete,
    ).toBe(false);
    await chmod(options.checkpointPath, 0o644);
    await expect(
      copyMacStateAclTreeV1(f.source, f.destination, options),
    ).rejects.toThrow(/ownership/);
    await chmod(options.checkpointPath, 0o600);
    await link(options.checkpointPath, join(f.root, "alias.json"));
    await expect(
      copyMacStateAclTreeV1(f.source, f.destination, options),
    ).rejects.toThrow(/ownership/);
    await rm(join(f.root, "alias.json"));
    await rename(f.destination, join(f.root, "previous"));
    await mkdir(f.destination, { mode: 0o700 });
    await expect(
      copyMacStateAclTreeV1(f.source, f.destination, options),
    ).rejects.toThrow(/binding/);
    await expect(
      copyMacStateAclTreeV1(f.source, f.destination, {
        checkpointPath: join(f.source, "inside.json"),
      }),
    ).rejects.toThrow(/external/);
    await chmod(f.root, 0o755);
    await expect(
      copyMacStateAclTreeV1(f.source, f.destination, {
        checkpointPath: join(f.root, "public.json"),
      }),
    ).rejects.toThrow(/protected/);
    await chmod(f.root, 0o700);
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("same");
  },
);
