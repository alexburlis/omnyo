import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { pluginPackageJsonSchema } from "@omnyo/domain";
import { buildPluginApp } from "./build-plugin-app.js";
import {
  copyPluginRuntime,
  preparePluginRuntime,
} from "./prepare-plugin-runtime.js";
import { resolvePluginBuildToolchain } from "./toolchain.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(author: { name: string; url?: string }) {
  const source = await mkdtemp(join(tmpdir(), "omnyo-runtime-source-"));
  const target = await mkdtemp(join(tmpdir(), "omnyo-runtime-packet-"));
  directories.push(source, target);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "omnyo-plugin-packet-proof",
      version: "1.0.0",
      author,
      type: "module",
      omnyo: {
        name: "Packet proof",
        description: "Runtime packet installation",
        branding: { icon: "Folder" },
        server: "./server.js",
        app: "./app.js",
      },
    }),
  );

  return { source, target };
}

it("produces a manifest that can be read again when author has no URL", async () => {
  const { source, target } = await fixture({ name: "Alex Burlis" });
  await copyPluginRuntime({ sourceRoot: source, targetDir: target });

  const raw: unknown = JSON.parse(
    await readFile(join(target, "package.json"), "utf8"),
  );

  expect(pluginPackageJsonSchema.parse(raw).author).toEqual({
    name: "Alex Burlis",
    github: null,
    url: null,
  });
});

it("preserves authored CSS when an installed runtime packet is rebuilt", async () => {
  const { source, target } = await fixture({
    name: "Alex",
    url: "https://example.com",
  });

  await writeFile(
    join(source, "app.js"),
    'import "./app.css"; export default {};\n',
  );
  await writeFile(
    join(source, "app.css"),
    ".packet-authored { min-width: 73px; }\n",
  );

  const toolchain = await resolvePluginBuildToolchain(
    join(tmpdir(), "omnyo-runtime-unused"),
    {
      onFetchStart() {
        throw new Error("This regression uses the installed toolchain only");
      },
    },
  );

  await buildPluginApp(source, "0.46.76+private.1", toolchain);
  await copyPluginRuntime({ sourceRoot: source, targetDir: target });
  await buildPluginApp(target, "0.46.76+private.1", toolchain);
  expect(await readFile(join(target, "dist", "app.css"), "utf8")).toMatch(
    /\.packet-authored\{[^}]*min-width:73px/u,
  );
});

it("prepares builtins with the prebuilt app entry instead of a rebuildable wrapper", async () => {
  const { source, target } = await fixture({ name: "Alex" });
  await writeFile(
    join(source, "server.js"),
    "export default function plugin() {}\n",
  );
  await writeFile(join(source, "app.js"), "export default {};\n");

  const toolchain = await resolvePluginBuildToolchain(source, {
    onFetchStart() {
      throw new Error("This regression uses the installed toolchain only");
    },
  });

  const canonicalManifest = pluginPackageJsonSchema.parse(
    JSON.parse(await readFile(join(source, "package.json"), "utf8")),
  );

  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      ...canonicalManifest,
      name: "omnyo-plugin-packet-proof",
      author: { name: "Alex" },
    }),
  );

  await preparePluginRuntime({
    sourceRoot: source,
    targetDir: target,
    coreVersion: "0.46.77+private.1",
    toolchain,
    hostProvidedZod: true,
  });

  const manifest = pluginPackageJsonSchema.parse(
    JSON.parse(await readFile(join(target, "package.json"), "utf8")),
  );

  expect(manifest.omnyo.app).toBe("./dist/app.js");
  expect(
    JSON.parse(await readFile(join(target, "dist", "server.meta.json"), "utf8"))
      .builtWith.coreVersion,
  ).toBe("0.46.77+private.1");
});

async function stageAssetsFixture(script: string) {
  const { source, target } = await fixture({ name: "Alex" });
  await writeFile(
    join(source, "server.js"),
    "export default function plugin() {}\n",
  );
  await writeFile(join(source, "app.js"), "export default {};\n");
  await mkdir(join(source, "scripts"), { recursive: true });
  await writeFile(join(source, "scripts", "stage-assets.mjs"), script);

  const toolchain = await resolvePluginBuildToolchain(source, {
    onFetchStart() {
      throw new Error("This regression uses the installed toolchain only");
    },
  });

  return { source, target, toolchain };
}

it("stages plugin assets in a separate process so loaded native modules release before cleanup", async () => {
  const { source, target, toolchain } = await stageAssetsFixture(
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'await mkdir(new URL("../dist/", import.meta.url), { recursive: true });',
      'await writeFile(new URL("../dist/stage-pid.txt", import.meta.url), String(process.pid));',
      "",
    ].join("\n"),
  );

  await preparePluginRuntime({
    sourceRoot: source,
    targetDir: target,
    coreVersion: "1.0.0",
    toolchain,
    hostProvidedZod: true,
  });

  const stagePid = await readFile(
    join(target, "dist", "stage-pid.txt"),
    "utf8",
  );

  expect(Number(stagePid)).toBeGreaterThan(0);
  expect(Number(stagePid)).not.toBe(process.pid);
});

it("reports a failing stage-assets script with its own error", async () => {
  const { source, target, toolchain } = await stageAssetsFixture(
    'throw new Error("helper is missing");\n',
  );

  await expect(
    preparePluginRuntime({
      sourceRoot: source,
      targetDir: target,
      coreVersion: "1.0.0",
      toolchain,
      hostProvidedZod: true,
    }),
  ).rejects.toThrow(
    /scripts\/stage-assets\.mjs failed: [\s\S]*helper is missing/u,
  );
});

it("prepares a runtime without build-machine input paths and with its license notices", async () => {
  const { source, target } = await fixture({ name: "Alex" });

  const canonicalManifest = pluginPackageJsonSchema.parse(
    JSON.parse(await readFile(join(source, "package.json"), "utf8")),
  );

  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      ...canonicalManifest,
      name: "omnyo-plugin-packet-proof",
      author: { name: "Alex" },
      omnyo: {
        ...canonicalManifest.omnyo,
        app: undefined,
        server: "./server.ts",
        host: "./host.ts",
      },
    }),
  );
  await writeFile(
    join(source, "server.ts"),
    "export default function plugin() {}\n",
  );
  await writeFile(
    join(source, "host.ts"),
    [
      'import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";',
      'import { defineRpcContract } from "@omnyo/plugin-sdk";',
      "export default experimental_defineHostEntry({",
      "  contract: defineRpcContract({}),",
      "  handlers: {},",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(source, "LICENSE"),
    "MIT License\n\nCopyright (c) 2026 Packet proof contributors\n",
  );
  await writeFile(join(source, "LICENSE-NOT-A-NOTICE.txt"), "ignored\n");

  const toolchain = await resolvePluginBuildToolchain(source, {
    onFetchStart() {
      throw new Error("This regression uses the installed toolchain only");
    },
  });

  await preparePluginRuntime({
    sourceRoot: source,
    targetDir: target,
    coreVersion: "bundled",
    toolchain,
    hostProvidedZod: true,
  });

  const hostMeta = await readFile(
    join(target, "dist", "host.meta.json"),
    "utf8",
  );

  expect(JSON.parse(hostMeta)).toMatchObject({
    pluginId: "packet-proof",
    buildInputs: null,
  });
  expect(hostMeta).not.toContain(dirname(source));
  expect(await readFile(join(target, "LICENSE"), "utf8")).toContain(
    "Packet proof contributors",
  );
  await expect(
    readFile(join(target, "LICENSE-NOT-A-NOTICE.txt"), "utf8"),
  ).rejects.toThrow();
});

it("prepares an installed plugin artifact that loads zod without the host or node_modules", async () => {
  const { source, target } = await fixture({ name: "Alex" });

  const canonicalManifest = pluginPackageJsonSchema.parse(
    JSON.parse(await readFile(join(source, "package.json"), "utf8")),
  );

  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      ...canonicalManifest,
      name: "omnyo-plugin-packet-proof",
      author: { name: "Alex" },
      omnyo: { ...canonicalManifest.omnyo, app: undefined },
    }),
  );
  await writeFile(
    join(source, "server.js"),
    'import { z } from "zod";\nexport default function plugin() {}\nexport const parsed = z.string().parse("zod-loaded");\n',
  );
  await mkdir(join(source, "node_modules"));
  await symlink(
    dirname(
      createRequire(
        resolve(import.meta.dirname, "../../plugin-sdk/package.json"),
      ).resolve("zod/package.json"),
    ),
    join(source, "node_modules", "zod"),
    "dir",
  );

  const toolchain = await resolvePluginBuildToolchain(source, {
    onFetchStart() {
      throw new Error("This regression uses the installed toolchain only");
    },
  });

  await preparePluginRuntime({
    sourceRoot: source,
    targetDir: target,
    coreVersion: "0.46.251+private.1",
    toolchain,
    hostProvidedZod: false,
  });

  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(join(target, "dist", "server.js")).href)}); console.log(m.parsed);`,
    ],
    { cwd: target, timeout: 10_000 },
  );

  expect(stdout.trim()).toBe("zod-loaded");
});
