import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { sha } from "./contract-fields";
import { digest, optionalJson, outputJson, ownedFile } from "./host-data";
import type { Execution } from "./host-execution";
import type { WorkflowPlanInput } from "./workflow-host-types";

type Commands = {
  command: (program: string, args: string[], cwd: string, timeoutMs?: number) => Promise<Execution>;
  checked: (program: string, args: string[], cwd: string, timeoutMs?: number) => Promise<string>;
};

const snapshotSchema = z.object({
  schema: z.literal(1),
  repository: z.string(),
  root: z.string(),
  sourceCommit: sha,
  baseCommit: sha,
  version: z.string(),
  sourceFiles: z.record(z.string(), z.object({ mode: z.string(), oid: z.string() })),
  runtimeFiles: z.array(z.object({ path: z.string(), sha256: z.string() })),
});

const snapshotFile = "omnyo-workflow-source.json";

type BlobIdentity = { mode: string; oid: string };

function runtimeSource(path: string) {
  return !/^(?:docs|tests|\.vitest)\//u.test(path);
}

function gitTree(output: string, prefix: string): Map<string, BlobIdentity> {
  const result = new Map<string, BlobIdentity>();

  for (const row of output.split("\0").filter(Boolean)) {
    const match = /^([0-7]+) blob ([a-f0-9]+)\t(.+)$/u.exec(row);

    if (!match || !match[3]?.startsWith(prefix))
      throw new Error("Plugin source tree contains an unsupported entry");
    const path = match[3].slice(prefix.length);

    if (runtimeSource(path)) result.set(path, { mode: match[1]!, oid: match[2]! });
  }

  return result;
}

function sameBlob(left: BlobIdentity | undefined, right: BlobIdentity | undefined) {
  return left?.oid === right?.oid && left?.mode === right?.mode;
}

export class PluginSnapshots {
  constructor(private readonly commands: Commands) {}

  private async snapshotMetadata(root: string) {
    const metadata = await optionalJson(snapshotSchema, join(root, snapshotFile));

    if (!metadata) return null;

    const expected = digest(JSON.stringify(metadata));

    if (basename(root) !== expected && basename(root) !== expected.slice(0, 20))
      throw new Error("Runtime snapshot identity changed");

    for (const file of metadata.runtimeFiles) {
      const path = await ownedFile(root, file.path);

      if ((await lstat(join(root, file.path))).isSymbolicLink() || !(await lstat(path)).isFile())
        throw new Error("Runtime snapshot requires regular files");

      const actual = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");

      if (actual !== file.sha256) throw new Error("Runtime snapshot bytes changed");
    }

    return metadata;
  }

  async prepare(input: WorkflowPlanInput, plugin: { id: string; root: string }, parent: string) {
    await mkdir(parent, { recursive: true });
    const existing = await readdir(parent);

    if (existing.length > 1) throw new Error("More than one runtime snapshot exists for this run");

    if (existing[0]) {
      const directory = join(parent, existing[0]);
      const metadata = await this.snapshotMetadata(directory);

      if (
        !metadata ||
        metadata.sourceCommit !== input.mergeCommit ||
        metadata.root !== plugin.root ||
        metadata.repository !== input.repository
      )
        throw new Error("Runtime snapshot does not match the approved source");

      return {
        pluginId: plugin.id,
        source: "path:" + directory,
        version: metadata.version,
        snapshotDigest: existing[0],
      };
    }

    const root = join(input.path, plugin.root);
    await this.commands.checked("omnyo", ["plugin", "build", root], root);

    const manifest = z
      .object({
        name: z.string(),
        version: z.string(),
        author: z.json().optional(),
        engines: z.record(z.string(), z.string()).optional(),
        omnyo: z
          .object({
            server: z.string().optional(),
            app: z.string().optional(),
            host: z.string().optional(),
            skills: z.array(z.string()).optional(),
            branding: z
              .object({
                icon: z.string().optional(),
                logo: z
                  .object({ light: z.string().optional(), dark: z.string().optional() })
                  .optional(),
                experimental_icons: z.record(z.string(), z.string()).optional(),
              })
              .passthrough()
              .optional(),
            themes: z.array(z.object({ css: z.string() }).passthrough()).optional(),
          })
          .passthrough(),
      })
      .parse(await optionalJson(z.json(), join(root, "package.json")));

    const files = new Map<string, Buffer>();
    let bytes = 0;

    const collect = async (name: string, sourcePath: string): Promise<void> => {
      if (
        isAbsolute(name) ||
        name
          .split(/[\\/]/u)
          .some((part) => !part || part === "." || part === ".." || part === "node_modules")
      )
        throw new Error("Unsafe runtime asset path");
      const info = await lstat(sourcePath);

      if (info.isSymbolicLink()) throw new Error("Runtime snapshots cannot contain symlinks");

      if (info.isDirectory()) {
        for (const child of (await readdir(sourcePath)).sort())
          await collect(name + "/" + child, join(sourcePath, child));

        return;
      }

      if (!info.isFile() || files.size >= 4096 || bytes + info.size > 32 * 1024 * 1024)
        throw new Error("Runtime snapshot exceeds supported bounds");
      const content = await readFile(sourcePath);
      files.set(name, content);
      bytes += content.length;
    };

    for (const [kind, entry] of [
      ["server", manifest.omnyo.server],
      ["app", manifest.omnyo.app],
      ["host", manifest.omnyo.host],
    ]) {
      if (!entry) continue;

      for (const suffix of [".js", ".meta.json"])
        await collect(kind + suffix, join(root, "dist", kind + suffix));
    }

    if (manifest.omnyo.app) {
      let css = false;

      try {
        await collect("app.css", join(root, "dist/app.css"));
        css = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }

      files.set(
        "app-entry.js",
        Buffer.from((css ? 'import "./app.css"; ' : "") + 'export { default } from "./app.js";\n'),
      );
    }

    for (const name of manifest.omnyo.skills ?? []) await collect(name, join(root, name));
    const branding = manifest.omnyo.branding;

    const assets = [
      branding?.icon,
      branding?.logo?.light,
      branding?.logo?.dark,
      ...Object.values(branding?.experimental_icons ?? {}),
      ...(manifest.omnyo.themes ?? []).map((theme) => theme.css),
    ];

    for (const name of assets)
      if (name && /[./\\]/u.test(name)) await collect(name, join(root, name));
    files.set(
      "package.json",
      Buffer.from(
        JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          private: true,
          type: "module",
          author: manifest.author,
          engines: manifest.engines,
          omnyo: {
            ...manifest.omnyo,
            server: manifest.omnyo.server ? "./server.js" : undefined,
            app: manifest.omnyo.app ? "./app-entry.js" : undefined,
            host: manifest.omnyo.host ? "./host.js" : undefined,
          },
        }) + "\n",
      ),
    );

    if (
      files.size > 4096 ||
      [...files.values()].reduce((total, content) => total + content.length, 0) > 32 * 1024 * 1024
    )
      throw new Error("Runtime snapshot exceeds supported bounds");

    const tree = gitTree(
      await this.commands.checked(
        "git",
        ["ls-tree", "-r", "-z", input.mergeCommit, "--", plugin.root],
        input.path,
      ),
      plugin.root + "/",
    );

    const metadata = snapshotSchema.parse({
      schema: 1,
      repository: input.repository,
      root: plugin.root,
      sourceCommit: input.mergeCommit,
      baseCommit: input.baseCommit,
      version: manifest.version,
      sourceFiles: Object.fromEntries(tree),
      runtimeFiles: [...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, content]) => ({
          path,
          sha256: createHash("sha256").update(content).digest("hex"),
        })),
    });

    const snapshotDigest = digest(JSON.stringify(metadata));
    const directory = join(parent, snapshotDigest);
    await mkdir(directory);

    for (const [name, content] of files) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), content);
    }

    await writeFile(join(directory, snapshotFile), JSON.stringify(metadata) + "\n");

    return {
      pluginId: plugin.id,
      source: "path:" + directory,
      version: manifest.version,
      snapshotDigest,
    };
  }

  async preserve(input: WorkflowPlanInput, plugins: { root: string; id: string }[]) {
    const installed = outputJson(
      z.object({
        plugins: z.array(z.object({ id: z.string(), rootDir: z.string(), source: z.string() })),
      }),
      await this.commands.checked("omnyo", ["plugin", "list", "--json"], input.path),
    );

    for (const plugin of plugins) {
      const active = installed.plugins.find((item) => item.id === plugin.id);

      if (!active) throw new Error("The affected plugin is not installed");

      const source = outputJson(
        z.object({
          requested: z.string(),
          resolved: z.string(),
          subdirectory: z.string().optional(),
        }),
        await this.commands.checked("omnyo", ["plugin", "source", plugin.id, "--json"], input.path),
      );

      if (source.requested !== active.source)
        throw new Error("Installed plugin source changed during preservation check");
      const root = await realpath(active.rootDir);
      const topResult = await this.commands.command("git", ["rev-parse", "--show-toplevel"], root);

      const metadata = topResult.exitCode !== 0 ? await this.snapshotMetadata(root) : null;

      if ((topResult.exitCode !== 0 || topResult.termination || topResult.signal) && !metadata)
        throw new Error(
          "Installed plugin has no verifiable complete source tree; its owner must establish a source-bound baseline",
        );

      if (metadata && (metadata.repository !== input.repository || metadata.root !== plugin.root))
        throw new Error("Installed snapshot belongs to another source");
      const prefix = plugin.root + "/";

      const candidate = gitTree(
        await this.commands.checked(
          "git",
          ["ls-tree", "-r", "-z", input.mergeCommit, "--", plugin.root],
          input.path,
        ),
        prefix,
      );

      const baseline = gitTree(
        await this.commands.checked(
          "git",
          ["ls-tree", "-r", "-z", input.baseCommit, "--", plugin.root],
          input.path,
        ),
        prefix,
      );

      const files = metadata
        ? new Set<string>()
        : new Set([
            ...(await this.commands.checked("git", ["ls-files", "-z", "--", "."], root))
              .split("\0")
              .filter(Boolean),
            ...(
              await this.commands.checked(
                "git",
                ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
                root,
              )
            )
              .split("\0")
              .filter(Boolean),
          ]);

      if ((!metadata && !files.size) || files.size > 10000)
        throw new Error("Installed plugin source inventory is missing or too large");

      const activeTree = new Map<string, BlobIdentity>(
        metadata
          ? Object.entries(metadata.sourceFiles).filter(([path]) => runtimeSource(path))
          : [],
      );

      const hashAlgorithm = input.mergeCommit.length === 64 ? "sha256" : "sha1";

      for (const file of files) {
        if (!runtimeSource(file)) continue;

        if (file.startsWith("../") || isAbsolute(file))
          throw new Error("Installed source inventory escaped its plugin");
        const location = join(root, file);
        let info;

        try {
          info = await lstat(location);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }

        if (!info.isFile() && !info.isSymbolicLink())
          throw new Error("Unsupported installed source entry");

        const content = info.isSymbolicLink()
          ? Buffer.from(await readlink(location))
          : await readFile(location);

        const oid = createHash(hashAlgorithm)
          .update("blob " + content.length + "\0")
          .update(content)
          .digest("hex");

        const mode = info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644";
        activeTree.set(file, { oid, mode });
      }

      if (!candidate.size) throw new Error("Candidate plugin source is missing");

      for (const file of new Set([...activeTree.keys(), ...baseline.keys()])) {
        if (sameBlob(activeTree.get(file), candidate.get(file))) continue;

        if (
          input.changedFiles.includes(prefix + file) &&
          sameBlob(activeTree.get(file), baseline.get(file))
        )
          continue;
        throw new Error(
          "Candidate would replace installed plugin changes outside the reviewed repair: " +
            plugin.id +
            "/" +
            file,
        );
      }
    }
  }
}
