import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import {
  copyOmnyoStateTreeV1,
  inspectOmnyoStateTreeKindsV1,
  validateOmnyoSocketBridgesV1,
  inspectOmnyoStateTreeDigestV1,
  type OmnyoStateTreeConfigDigestV1,
} from "../omnyo-state-tree-v1.mjs";
import { inspectMacStateAclV1 } from "../mac-state-acl-v1.mjs";

const execute = promisify(execFile);

const roots: string[] = [];

const servers: Server[] = [];

const macTest = test.skipIf(process.platform !== "darwin");

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }

  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function fixture() {
  const root = await mkdtemp("/private/tmp/omnyo-tree-");
  roots.push(root);
  const source = join(root, "source");
  const destination = join(root, "staged");
  await mkdir(source, { mode: 0o700 });

  return {
    root,
    source,
    destination,
    options: { checkpointPath: join(root, "copy.json") },
  };
}

async function socket(path: string) {
  const server = createServer((client) => client.end("unchanged-listener"));
  servers.push(server);
  server.listen(path);
  await once(server, "listening");
  await chmod(path, 0o600);

  return server;
}

async function configDigest(
  root: string,
  sha256: string | null,
): Promise<OmnyoStateTreeConfigDigestV1> {
  const info = await lstat(join(root, "config.json"), { bigint: true });

  return {
    kind: "normalized",
    sha256,
    binding: {
      device: String(info.dev),
      inode: String(info.ino),
      uid: Number(info.uid),
      gid: Number(info.gid),
      mode: Number(info.mode & 0o7777n),
      size: Number(info.size),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
      nlink: Number(info.nlink),
    },
  };
}

function chain(previous: string, record: unknown): string {
  return createHash("sha256")
    .update(Buffer.from(previous, "hex"))
    .update(JSON.stringify(record))
    .digest("hex");
}

macTest(
  "clones bytes and metadata while retaining opaque links and destination-only hardlinks",
  async () => {
    const f = await fixture();
    await mkdir(join(f.source, "nested"), { mode: 0o750 });
    await writeFile(
      join(f.source, "nested", "bytes"),
      "original mutable work",
      { mode: 0o640 },
    );
    await link(join(f.source, "nested", "bytes"), join(f.source, "alias"));
    await writeFile(join(f.root, "outside"), "must remain outside");

    for (const [name, target] of [
      ["external", join(f.root, "outside")],
      ["absolute-internal", join(f.source, "nested", "bytes")],
      ["cycle-a", "cycle-b"],
      ["cycle-b", "cycle-a"],
      ["broken", "absent"],
    ]) {
      await symlink(target, join(f.source, name));
    }

    await execute("/usr/bin/xattr", [
      "-w",
      "com.omnyo.fixture",
      "opaque-xattr",
      join(f.source, "nested", "bytes"),
    ]);
    await execute("/usr/bin/python3", [
      "-I",
      "-c",
      "import os,sys;os.symlink(b'opaque-\\xff',os.fsencode(sys.argv[2]))",
      join(f.source, "nested", "bytes"),
      join(f.source, "nonutf8"),
    ]);
    await execute("/bin/chmod", [
      "+a",
      "everyone allow read",
      join(f.source, "nested", "bytes"),
    ]);
    await chmod(join(f.source, "nested", "bytes"), 0o2640);
    await chmod(join(f.source, "nested"), 0o2750);
    await mkdir(f.destination, { mode: 0o700 });

    const result = await copyOmnyoStateTreeV1(
      f.source,
      f.destination,
      f.options,
    );

    expect(result.complete).toBe(true);
    expect(result.counts).toMatchObject({
      entries: 10,
      directories: 2,
      regularFiles: 2,
      symbolicLinks: 6,
      sockets: 0,
      hardlinkAliases: 1,
    });

    const [source, first, second] = await Promise.all([
      lstat(join(f.source, "alias")),
      lstat(join(f.destination, "alias")),
      lstat(join(f.destination, "nested", "bytes")),
    ]);

    expect(first.ino).toBe(second.ino);
    expect(first.ino).not.toBe(source.ino);
    expect(first.mode & 0o7777).toBe(source.mode & 0o7777);
    expect((await lstat(join(f.destination, "nested"))).mode & 0o7777).toBe(
      (await lstat(join(f.source, "nested"))).mode & 0o7777,
    );

    for (const name of [
      "external",
      "absolute-internal",
      "cycle-a",
      "cycle-b",
      "broken",
      "nonutf8",
    ])
      expect(
        await readlink(join(f.destination, name), { encoding: "buffer" }),
      ).toEqual(await readlink(join(f.source, name), { encoding: "buffer" }));

    const [sourceXattr, destinationXattr] = await Promise.all([
      execute("/usr/bin/xattr", [
        "-px",
        "com.omnyo.fixture",
        join(f.source, "alias"),
      ]),
      execute("/usr/bin/xattr", [
        "-px",
        "com.omnyo.fixture",
        join(f.destination, "alias"),
      ]),
    ]);

    expect(destinationXattr.stdout).toBe(sourceXattr.stdout);

    const [sourceAcl, destinationAcl] = await Promise.all([
      execute("/bin/ls", ["-le", join(f.source, "alias")]),
      execute("/bin/ls", ["-le", join(f.destination, "alias")]),
    ]);

    expect(destinationAcl.stdout.split("\n").slice(1)).toEqual(
      sourceAcl.stdout.split("\n").slice(1),
    );
    expect(await inspectMacStateAclV1(f.destination)).toEqual(
      await inspectMacStateAclV1(f.source),
    );
    await writeFile(join(f.destination, "alias"), "changed staged work");
    expect(await readFile(join(f.source, "alias"), "utf8")).toBe(
      "original mutable work",
    );
    expect(await readFile(join(f.destination, "nested", "bytes"), "utf8")).toBe(
      "changed staged work",
    );
  },
);

macTest(
  "bridges only named IPC sockets without replacing or changing their listeners",
  async () => {
    const f = await fixture();
    await mkdir(join(f.source, "run", "mcp"), { recursive: true });
    const original = join(f.source, "run", "mcp", "sentry.sock");
    await socket(original);
    const before = await lstat(original);

    const result = await copyOmnyoStateTreeV1(
      f.source,
      f.destination,
      f.options,
    );

    expect(result.complete).toBe(true);
    expect(result.counts.sockets).toBe(1);
    expect(result.socketBindings).toMatchObject([
      {
        path: "run/mcp/sentry.sock",
        sourcePath: original,
        uid: process.getuid?.(),
        mode: 0o600,
      },
    ]);
    const bridge = join(f.destination, "run", "mcp", "sentry.sock");
    expect((await lstat(bridge)).isSymbolicLink()).toBe(true);
    expect(await readlink(bridge)).toBe(original);
    const client = createConnection(bridge);
    const [data] = await once(client, "data");
    expect(data.toString()).toBe("unchanged-listener");
    client.destroy();
    await expect(
      validateOmnyoSocketBridgesV1(
        f.source,
        f.destination,
        result.socketBindings,
      ),
    ).resolves.toBeUndefined();

    const originalDigest = await inspectOmnyoStateTreeDigestV1(f.source, {
      checkpointPath: join(f.root, "original-digest.json"),
      config: { kind: "absent" },
    });

    const stagedDigest = await inspectOmnyoStateTreeDigestV1(f.destination, {
      checkpointPath: join(f.root, "staged-digest.json"),
      config: { kind: "absent" },
      socketBridgeSource: { root: f.source, bindings: result.socketBindings },
    });

    const opaqueDigest = await inspectOmnyoStateTreeDigestV1(f.destination, {
      checkpointPath: join(f.root, "opaque-digest.json"),
      config: { kind: "absent" },
    });

    expect(stagedDigest.digest).toBe(originalDigest.digest);
    expect(opaqueDigest.digest).not.toBe(originalDigest.digest);
    const after = await lstat(original);
    expect([after.dev, after.ino, after.mode, after.uid]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.uid,
    ]);
    await expect(
      validateOmnyoSocketBridgesV1(
        f.source,
        f.destination,
        result.socketBindings.map((binding) => ({
          ...binding,
          uid: binding.uid + 1,
        })),
      ),
    ).rejects.toThrow(/socket-drift/);
    await chmod(original, 0o640);
    await expect(
      validateOmnyoSocketBridgesV1(
        f.source,
        f.destination,
        result.socketBindings,
      ),
    ).rejects.toThrow(/socket-drift/);
    await chmod(original, 0o600);
    await rename(bridge, join(f.root, "original-bridge"));
    await symlink(join(f.root, "different-socket"), bridge);
    await expect(
      validateOmnyoSocketBridgesV1(
        f.source,
        f.destination,
        result.socketBindings,
      ),
    ).rejects.toThrow(/bridge-drift/);
  },
);

macTest(
  "resumes the same staging inode across bounded shards and refuses source drift",
  async () => {
    const f = await fixture();
    await execute("/usr/bin/python3", [
      "-I",
      "-c",
      "import os,sys;root=sys.argv[1];[open(os.path.join(root,str(i).zfill(5)),'wb').close() for i in range(4100)]",
      f.source,
    ]);
    const bounded = { ...f.options, maxShards: 1 };
    const first = await copyOmnyoStateTreeV1(f.source, f.destination, bounded);
    expect(first.complete).toBe(false);
    expect(first.continuationPath).toBe(f.options.checkpointPath);
    expect(first.phaseEntries).toBeGreaterThan(0);
    await expect(lstat(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    let result = first;
    let calls = 1;
    let stagingInode: number | undefined;

    while (!result.complete && calls < 12) {
      result = await copyOmnyoStateTreeV1(f.source, f.destination, bounded);
      calls++;
      const info = await lstat(f.destination).catch(() => undefined);

      if (info && stagingInode === undefined) stagingInode = info.ino;

      if (info && stagingInode !== undefined)
        expect(info.ino).toBe(stagingInode);
    }

    expect(result.complete).toBe(true);
    expect(result.counts.regularFiles).toBe(4100);
    const checkpoint = await lstat(f.options.checkpointPath);
    expect(checkpoint.mode & 0o777).toBe(0o600);
    await writeFile(join(f.source, "00000"), "new source bytes");
    await expect(
      copyOmnyoStateTreeV1(f.source, f.destination, f.options),
    ).rejects.toThrow(/source changed/);
    expect(await readFile(join(f.destination, "00000"), "utf8")).toBe("");
  },
);

macTest(
  "matches independent Node SHA256 vectors across aligned resume and durable metadata verification",
  async () => {
    const f = await fixture();
    const block = Buffer.alloc(1048576);
    const tail = Buffer.alloc(65, 0x7a);
    const large = await open(join(f.source, "00-large"), "wx", 0o600);
    await large.truncate(268435456 + tail.length);
    await large.write(tail, 0, tail.length, 268435456);
    await large.close();
    const vectors = new Map<string, string>();
    const expectedLarge = createHash("sha256");

    for (let index = 0; index < 256; index++) expectedLarge.update(block);
    vectors.set("00-large", expectedLarge.update(tail).digest("hex"));

    for (const [name, length] of [
      ["10-64", 64],
      ["20-65", 65],
      ["30-oneMiB", 1048583],
    ] satisfies Array<[string, number]>) {
      const bytes = Buffer.alloc(length);

      for (let index = 0; index < bytes.length; index++)
        bytes[index] = index % 251;
      await writeFile(join(f.source, name), bytes, { mode: 0o600 });
      vectors.set(name, createHash("sha256").update(bytes).digest("hex"));
    }

    const rootInfo = await lstat(f.source);

    let expected = chain("0".repeat(64), [
      "directory",
      "",
      rootInfo.mode & 0o7777,
      rootInfo.uid,
      rootInfo.gid,
    ]);

    for (const [name, sha256] of vectors) {
      const info = await lstat(join(f.source, name));
      expected = chain(expected, [
        "file",
        name,
        info.mode & 0o7777,
        info.uid,
        info.gid,
        sha256,
      ]);
    }

    const options = {
      checkpointPath: join(f.root, "digest.json"),
      config: { kind: "absent" } satisfies OmnyoStateTreeConfigDigestV1,
      durable: true,
      maxShards: 1,
    };

    const ownedFile = await open(join(f.source, "30-oneMiB"), "r");

    try {
      const byte = Buffer.alloc(1);
      await ownedFile.read(byte, 0, 1, null);
      expect(byte[0]).toBe(0);
      const before = await ownedFile.stat({ bigint: true });
      let result = await inspectOmnyoStateTreeDigestV1(f.source, options);
      expect(result.complete).toBe(false);
      expect(result.bytesReadThisCall).toBe(268435456);

      const checkpoint = z
        .object({
          traversal: z.object({
            content: z.object({
              partial: z
                .object({
                  count: z.array(z.number()),
                  hash: z.array(z.number()),
                  metadata: z.array(z.unknown()),
                  offset: z.number(),
                  path: z.string(),
                })
                .strict(),
            }),
          }),
        })
        .parse(JSON.parse(await readFile(options.checkpointPath, "utf8")));

      expect(checkpoint.traversal.content.partial.offset).toBe(268435456);
      expect(checkpoint.traversal.content.partial.count).toHaveLength(2);
      expect(checkpoint.traversal.content.partial.hash).toHaveLength(8);
      const changed = await open(join(f.source, "00-large"), "r+");

      try {
        await changed.write(Buffer.from([1]), 0, 1, 0);
        await expect(
          inspectOmnyoStateTreeDigestV1(f.source, options),
        ).rejects.toThrow(/digest-cursor-drift/);
        await changed.write(Buffer.from([0]), 0, 1, 0);
      } finally {
        await changed.close();
      }

      const freshOptions = {
        ...options,
        checkpointPath: join(f.root, "fresh-digest.json"),
      };

      result = await inspectOmnyoStateTreeDigestV1(f.source, freshOptions);

      for (let calls = 1; !result.complete && calls < 8; calls++)
        result = await inspectOmnyoStateTreeDigestV1(f.source, freshOptions);
      expect(result.complete).toBe(true);
      expect(result.algorithm).toBe("state-tree-v2");
      expect(result.digest).toBe(expected);
      expect(result.files).toBe(4);

      const cached = await inspectOmnyoStateTreeDigestV1(
        f.source,
        freshOptions,
      );

      expect(cached.complete).toBe(true);
      expect(cached.digest).toBe(expected);
      expect(cached.bytesReadThisCall).toBe(0);
      await ownedFile.read(byte, 0, 1, null);
      expect(byte[0]).toBe(1);
      const after = await ownedFile.stat({ bigint: true });
      expect([
        after.dev,
        after.ino,
        after.mode,
        after.uid,
        after.gid,
        after.size,
        after.mtimeNs,
        after.ctimeNs,
      ]).toEqual([
        before.dev,
        before.ino,
        before.mode,
        before.uid,
        before.gid,
        before.size,
        before.mtimeNs,
        before.ctimeNs,
      ]);
      await writeFile(join(f.source, "20-65"), "changed source bytes");
      await expect(
        inspectOmnyoStateTreeDigestV1(f.source, freshOptions),
      ).rejects.toThrow(/metadata changed/);
    } finally {
      await ownedFile.close();
    }
  },
);

macTest(
  "refreshes only fence-equivalent physical config bindings without hashing cached contents",
  async () => {
    for (const populated of [false, true]) {
      const f = await fixture();
      await writeFile(join(f.source, "ordinary"), "retained ordinary bytes", {
        mode: 0o600,
      });

      const sha256 = populated
        ? createHash("sha256").update('{"value":"retained"}').digest("hex")
        : null;

      if (populated)
        await writeFile(
          join(f.source, "config.json"),
          JSON.stringify({ value: "retained" }),
          { mode: 0o600 },
        );

      const config = populated
        ? await configDigest(f.source, sha256)
        : ({ kind: "absent" } satisfies OmnyoStateTreeConfigDigestV1);

      const options = { checkpointPath: join(f.root, "digest.json"), config };
      const initial = await inspectOmnyoStateTreeDigestV1(f.source, options);
      expect(initial.complete).toBe(true);
      await writeFile(
        join(f.source, "new-config"),
        JSON.stringify({
          ...(populated ? { value: "retained" } : {}),
          stateMigration: { fixture: true },
        }),
        { mode: 0o600 },
      );
      await rename(join(f.source, "new-config"), join(f.source, "config.json"));
      const refreshed = await configDigest(f.source, sha256);

      const cached = await inspectOmnyoStateTreeDigestV1(f.source, {
        ...options,
        config: refreshed,
      });

      expect(cached.complete).toBe(true);
      expect(cached.digest).toBe(initial.digest);
      expect(cached.bytesReadThisCall).toBe(0);
      expect(cached.bytes).toBe(Buffer.byteLength("retained ordinary bytes"));

      if (refreshed.kind !== "normalized")
        throw new Error("Expected normalized config fixture");
      await expect(
        inspectOmnyoStateTreeDigestV1(f.source, {
          ...options,
          config: {
            ...refreshed,
            binding: { ...refreshed.binding, inode: "0" },
          },
        }),
      ).rejects.toThrow(/config-binding/);
      await expect(
        inspectOmnyoStateTreeDigestV1(f.source, {
          ...options,
          config: { ...refreshed, sha256: "0".repeat(64) },
        }),
      ).rejects.toThrow(/fresh checkpoint/);
    }
  },
);

macTest(
  "inventories unknown sockets and FIFOs without opening them and refuses before staging",
  async () => {
    const f = await fixture();
    await socket(join(f.source, "unrecognized.sock"));
    await execute("/usr/bin/mkfifo", [join(f.source, "pipe")]);

    const result = await inspectOmnyoStateTreeKindsV1(f.source, {
      checkpointPath: join(f.root, "inspect.json"),
    });

    expect(result.complete).toBe(true);
    expect(result.unsupported).toEqual([
      { path: "pipe", kind: "fifo" },
      { path: "unrecognized.sock", kind: "socket" },
    ]);
    await expect(
      copyOmnyoStateTreeV1(f.source, f.destination, f.options),
    ).rejects.toThrow(/unsupported/);
    await expect(lstat(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(join(f.source, "pipe"))).isFIFO()).toBe(true);
    expect((await lstat(join(f.source, "unrecognized.sock"))).isSocket()).toBe(
      true,
    );
  },
);

macTest(
  "refuses source, staging, checkpoint and bridge replacement without overwriting foreign paths",
  async () => {
    const f = await fixture();
    await writeFile(join(f.source, "work"), "work");

    const result = await copyOmnyoStateTreeV1(
      f.source,
      f.destination,
      f.options,
    );

    expect(result.complete).toBe(true);
    await rename(f.destination, join(f.root, "original-staged"));
    await mkdir(f.destination);
    await writeFile(join(f.destination, "foreign"), "preserve");
    await expect(
      copyOmnyoStateTreeV1(f.source, f.destination, f.options),
    ).rejects.toThrow(/staging identity/);
    expect(await readFile(join(f.destination, "foreign"), "utf8")).toBe(
      "preserve",
    );
    await rename(f.source, join(f.root, "original-source"));
    await mkdir(f.source);
    await expect(
      copyOmnyoStateTreeV1(f.source, f.destination, f.options),
    ).rejects.toThrow(/binding changed/);
    await symlink(
      join(f.root, "copy.json"),
      join(f.root, "linked-checkpoint.json"),
    );
    await expect(
      inspectOmnyoStateTreeKindsV1(f.source, {
        checkpointPath: join(f.root, "linked-checkpoint.json"),
      }),
    ).rejects.toThrow();
    await expect(
      inspectOmnyoStateTreeKindsV1(f.source, {
        checkpointPath: join(f.source, "forbidden.json"),
      }),
    ).rejects.toThrow(/outside/);
    await expect(lstat(join(f.source, "forbidden.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  },
);
