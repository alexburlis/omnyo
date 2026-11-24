import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isPluginOwnedIconPath, pluginPackageJsonSchema } from "@omnyo/domain";
import { buildPluginApp } from "./build-plugin-app.js";
import { buildPluginServer } from "./build-plugin-server.js";
import { buildPluginHost } from "./build-plugin-host.js";
import { pathExists } from "./plugin-sdk-install.js";
import type { PluginBuildToolchain } from "./toolchain.js";

const RUNTIME_DIRS = ["dist", "skills"] as const;

const LICENSE_FILE_PATTERN =
  /^(?:licen[cs]e|copying|notice)(?:\.[a-z0-9]+)?$/iu;

async function copyIfExists(from: string, to: string): Promise<void> {
  if (await pathExists(from)) {
    await cp(from, to, { recursive: true });
  }
}

async function copyLicenseFiles(
  sourceRoot: string,
  targetDir: string,
): Promise<void> {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)) {
      await cp(
        path.join(sourceRoot, entry.name),
        path.join(targetDir, entry.name),
      );
    }
  }
}

async function dropHostBuildInputs(buildRoot: string): Promise<void> {
  const metaPath = path.join(buildRoot, "dist", "host.meta.json");

  if (!(await pathExists(metaPath))) return;
  const meta: unknown = JSON.parse(await readFile(metaPath, "utf8"));

  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error(`Plugin host metadata is not an object: ${metaPath}`);
  }

  await writeFile(
    metaPath,
    `${JSON.stringify({ ...meta, buildInputs: null }, null, 2)}\n`,
  );
}

async function writeRuntimePackageJson(args: {
  sourceRoot: string;
  targetDir: string;
  appEntry: "./app-entry.js" | "./dist/app.js";
}): Promise<void> {
  const raw = await readFile(
    path.join(args.sourceRoot, "package.json"),
    "utf8",
  );

  const packageJson = pluginPackageJsonSchema.parse(JSON.parse(raw));
  await writeFile(
    path.join(args.targetDir, "package.json"),
    `${JSON.stringify(
      {
        ...packageJson,
        author:
          packageJson.author === undefined
            ? undefined
            : {
                name: packageJson.author.name,
                ...(packageJson.author.url === null
                  ? {}
                  : { url: packageJson.author.url }),
              },
        omnyo: {
          ...packageJson.omnyo,
          server: "./dist/server.js",
          ...(packageJson.omnyo.app === undefined
            ? {}
            : { app: args.appEntry }),
          ...(packageJson.omnyo.host === undefined
            ? {}
            : { host: "./dist/host.js" }),
        },
      },
      null,
      2,
    )}\n`,
  );
}

const runFile = promisify(execFile);

async function runStageAssets(sourceRoot: string): Promise<void> {
  const scriptPath = path.join(sourceRoot, "scripts", "stage-assets.mjs");

  if (!(await pathExists(scriptPath))) return;

  try {
    await runFile(process.execPath, [scriptPath], {
      cwd: sourceRoot,
      maxBuffer: 64 << 20,
    });
  } catch (error) {
    const stderr =
      error instanceof Error && "stderr" in error
        ? String(error.stderr).trim()
        : "";

    throw new Error(
      `scripts/stage-assets.mjs failed: ${stderr || (error instanceof Error ? error.message : String(error))}`,
    );
  }
}

export async function copyPluginRuntime(args: {
  sourceRoot: string;
  targetDir: string;
}): Promise<void> {
  await copyRuntime({ ...args, appEntry: "./app-entry.js" });
}

async function copyRuntime(args: {
  sourceRoot: string;
  targetDir: string;
  appEntry: "./app-entry.js" | "./dist/app.js";
}): Promise<void> {
  const targetDir = args.targetDir;
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  await writeRuntimePackageJson({
    sourceRoot: args.sourceRoot,
    targetDir,
    appEntry: args.appEntry,
  });

  for (const dirName of RUNTIME_DIRS) {
    await copyIfExists(
      path.join(args.sourceRoot, dirName),
      path.join(targetDir, dirName),
    );
  }

  await copyLicenseFiles(args.sourceRoot, targetDir);

  const packageJson = pluginPackageJsonSchema.parse(
    JSON.parse(
      await readFile(path.join(args.sourceRoot, "package.json"), "utf8"),
    ),
  );

  if (
    packageJson.omnyo.app !== undefined &&
    args.appEntry === "./app-entry.js"
  ) {
    const imports = [];

    if (await pathExists(path.join(targetDir, "dist", "app.css"))) {
      imports.push('import "./dist/app.css";');
    }

    imports.push('export { default } from "./dist/app.js";');
    await writeFile(
      path.join(targetDir, "app-entry.js"),
      `${imports.join("\n")}\n`,
    );
  }

  const logo = packageJson.omnyo.branding.logo;

  const compactIcon = isPluginOwnedIconPath(
    packageJson.omnyo.branding.icon ?? "",
  )
    ? packageJson.omnyo.branding.icon
    : undefined;

  const declaredIcons = Object.values(
    packageJson.omnyo.branding.experimental_icons ?? {},
  );

  for (const asset of [
    compactIcon,
    logo?.light,
    logo?.dark,
    ...declaredIcons,
  ]) {
    if (asset === undefined) continue;
    const sourcePath = path.resolve(args.sourceRoot, asset);
    const targetPath = path.resolve(targetDir, asset);

    if (
      (sourcePath !== args.sourceRoot &&
        !sourcePath.startsWith(args.sourceRoot + path.sep)) ||
      (targetPath !== targetDir && !targetPath.startsWith(targetDir + path.sep))
    ) {
      throw new Error(
        `manifest branding asset escapes plugin directory: ${asset}`,
      );
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath);
  }
}

export async function preparePluginRuntime(args: {
  sourceRoot: string;
  targetDir: string;
  coreVersion: string;
  toolchain: PluginBuildToolchain;
  hostProvidedZod: boolean;
  workDirectory?: string;
}): Promise<void> {
  const workDirectory = args.workDirectory ?? path.dirname(args.sourceRoot);
  await mkdir(workDirectory, { recursive: true });
  const buildRoot = await mkdtemp(path.join(workDirectory, ".bundled-stage-"));

  try {
    await cp(args.sourceRoot, buildRoot, {
      recursive: true,
      filter: (entry) =>
        !["dist", "node_modules", ".turbo", ".bundled-runtime"].includes(
          path.relative(args.sourceRoot, entry).split(path.sep)[0],
        ),
    });
    const modules = path.join(args.sourceRoot, "node_modules");

    if (await pathExists(modules)) {
      await symlink(
        await realpath(modules),
        path.join(buildRoot, "node_modules"),
        "junction",
      );
    }

    const manifest = pluginPackageJsonSchema.parse(
      JSON.parse(await readFile(path.join(buildRoot, "package.json"), "utf8")),
    );

    await buildPluginServer(buildRoot, args.coreVersion, args.toolchain, {
      hostProvidedZod: args.hostProvidedZod,
    });

    if (manifest.omnyo.app !== undefined)
      await buildPluginApp(buildRoot, args.coreVersion, args.toolchain);

    if (manifest.omnyo.host !== undefined)
      await buildPluginHost(buildRoot, args.coreVersion, args.toolchain);
    await runStageAssets(buildRoot);
    await dropHostBuildInputs(buildRoot);
    await copyRuntime({
      sourceRoot: buildRoot,
      targetDir: args.targetDir,
      appEntry: "./dist/app.js",
    });
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}
