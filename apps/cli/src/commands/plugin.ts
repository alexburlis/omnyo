import { watch } from "node:fs";
import { homedir } from "node:os";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Command, Option } from "commander";
import { z } from "zod";
import {
  derivePluginId,
  jsonValueSchema,
  pluginPackageJsonSchema,
  type PluginPackageJson,
} from "@omnyo/domain";
import {
  pluginCliCall,
  RESERVED_CORE_CLI_COMMANDS,
} from "@omnyo/domain/plugin-cli";
import {
  pluginInstallBadge,
  type PluginInstallBadge,
} from "@omnyo/domain/plugin-install-badge";
import {
  type InstalledPlugin as PluginEntry,
  type PluginApplyUpdateResult,
  type PluginCatalogInstallPlan,
  type PluginCatalogResolvedSource,
  type PluginCatalogSearchResult,
  type PluginUpdateCheckEntry as PluginUpdateResult,
} from "@omnyo/server-contract";
import { OmnyoHttpError, pluginMutationResponseSchema } from "@omnyo/sdk";
import {
  requestCompatiblePluginSettings,
  type CompatiblePluginSettingsResult,
} from "@omnyo/sdk/node";
import {
  parseDataDirEnvValue,
  resolveProdDataDir,
} from "@omnyo/config/runtime";
import {
  eventSourceFamilyOf,
  migratePluginToPackageLayout,
  resolvePluginSdkLayout,
  scaffoldEventSourcePlugin,
  scaffoldPlugin,
  resolvePrivateSdkArtifact,
  setPluginSdkPin,
  type PluginPackageLayoutMigration,
} from "@omnyo/templates/plugin-scaffold";
import { action } from "../action.js";
import { cliFetch, createCliOmnyoSdk } from "../client.js";
import {
  buildPluginApp,
  buildPluginHost,
  buildPluginServer,
  createPluginDevLoop,
  PLUGIN_TOOLCHAIN_PINS,
  resolvePluginBuildToolchain,
  type PluginBuildToolchain,
} from "@omnyo/plugin-build";
import { runPluginCliCommand } from "../plugin-cli-proxy.js";
import { resolveOmnyoCliVersion } from "../version.js";
import {
  bundledCandidateVersion,
  readBundledPluginCandidate,
} from "../bundled-plugin-candidate.js";
import {
  bundledPluginSourceIdentity,
  requireBundledPluginOnMain,
  readBundledPluginCandidateSource,
  reviewBundledPluginReplacement,
} from "../bundled-plugin-source.js";

import { outputJson, type JsonOutputOptions } from "./helpers.js";
import { renderBorderlessTable } from "../table.js";

interface NewPluginTarget {
  packageName: string;
  directoryName: string;
}

export function resolveNewPluginTarget(name: string): NewPluginTarget | null {
  const packageName = name.startsWith("@")
    ? name
    : name.startsWith("omnyo-plugin-")
      ? name
      : `omnyo-plugin-${name}`;

  if (
    !/^(?:@[a-z0-9][a-z0-9-]*\/)?omnyo-plugin-[a-z0-9][a-z0-9-]*$/.test(
      packageName,
    )
  ) {
    return null;
  }

  const pluginId = derivePluginId(packageName);

  if (RESERVED_CORE_CLI_COMMANDS.includes(pluginId)) return null;

  return {
    packageName,
    directoryName: `omnyo-plugin-${pluginId}`,
  };
}

function pluginInstallBadgeLabel(badge: PluginInstallBadge | null): string {
  if (badge === null) return "";

  if (badge.kind === "builtin") return "Built in";

  return "New";
}

function formatCacheBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function toolchainBaseDir(): string {
  const configured = process.env.OMNYO_DATA_DIR;

  const dataDir =
    configured === undefined || configured.trim().length === 0
      ? resolveProdDataDir({ homeDir: homedir() })
      : parseDataDirEnvValue({ homeDir: homedir(), rawDataDir: configured });

  return join(dataDir, "plugins");
}

async function cliBuildToolchain(): Promise<PluginBuildToolchain> {
  return resolvePluginBuildToolchain(toolchainBaseDir(), {
    onFetchStart: () => {
      const pins = Object.entries(PLUGIN_TOOLCHAIN_PINS)
        .map(([name, version]) => `${name}@${version}`)
        .join(", ");

      console.log("Downloading the plugin build toolchain (one time)…");
      console.log(`  ${pins}`);
    },
    onFetchDone: (elapsedMs) => {
      console.log(`Toolchain ready (${(elapsedMs / 1000).toFixed(1)}s)`);
    },
  });
}

async function searchCatalog(
  baseUrl: string,
  query: string,
): Promise<PluginCatalogSearchResult[]> {
  return (await createCliOmnyoSdk(baseUrl).plugins.catalog.search({ query }))
    .results;
}

const negativeNumberValuePattern =
  /^-(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const pluginTokenResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  token: z.string().optional(),
});

const pluginLogsResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  lines: z.array(z.string()).optional(),
});

const pluginPackageSummarySchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
});

const secretSettingValueSchema = z.object({ set: z.boolean().optional() });

async function readPluginManifest(
  rootDir: string,
): Promise<PluginPackageJson | null> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(rootDir, "package.json"), "utf8"),
    );

    return pluginPackageJsonSchema.parse(raw);
  } catch {
    return null;
  }
}

const LEGACY_PLUGIN_SDK_LAYOUT_MESSAGE =
  "This plugin uses the legacy vendored SDK layout. Its SDK types will not be updated.\n" +
  "Please run `omnyo plugin migrate` to update to the latest SDK types.";

async function checkPluginSdkLayout(rootDir: string): Promise<void> {
  const layout = await resolvePluginSdkLayout(rootDir);

  if (layout.kind === "package") return;

  console.warn(LEGACY_PLUGIN_SDK_LAYOUT_MESSAGE);
}

function printMigrationPlan(plan: PluginPackageLayoutMigration): void {
  if (plan.pin !== null) {
    console.log(
      `  package.json   devDependencies "@omnyo/plugin-sdk": ${plan.pin.from ?? "(none)"} → ${plan.pin.to}`,
    );
  }

  if (plan.movedFromDependencies) {
    console.log(
      '  package.json   move "@omnyo/plugin-sdk" from dependencies to devDependencies',
    );
  }

  if (plan.enginesFloor !== null) {
    console.log(
      `  package.json   engines.omnyoPluginSdk: ${plan.enginesFloor.from ?? "(none)"} → ${plan.enginesFloor.to}`,
    );
  }

  for (const key of plan.removedPathMaps) {
    console.log(`  tsconfig.json  remove compilerOptions.paths "${key}"`);
  }

  for (const entry of plan.removedIncludes) {
    console.log(`  tsconfig.json  remove include entry "${entry}"`);
  }

  for (const file of plan.archivedFiles) {
    console.log(`  preserve       ${file} → vendor/legacy-plugin-sdk-v1/`);
  }

  if (plan.removedTypesDir) {
    console.log("  delete         types/ (empty after the deletions above)");
  }

  for (const file of plan.rewrittenImports) {
    console.log(
      `  rewrite        ${file.path} (${file.imports} SDK import/member updates to "@omnyo/plugin-sdk")`,
    );
  }
}

function samePlan(
  approved: PluginPackageLayoutMigration,
  current: PluginPackageLayoutMigration,
): boolean {
  return JSON.stringify(approved) === JSON.stringify(current);
}

async function requirePluginManifest(
  rootDir: string,
): Promise<PluginPackageJson> {
  const manifest = await readPluginManifest(rootDir);

  if (!manifest) {
    console.error(
      `No readable package.json in ${rootDir} — run from a plugin directory or pass its path.`,
    );
    process.exit(1);
  }

  if (typeof manifest.omnyo.server !== "string") {
    console.error(
      `${rootDir} is not an Omnyo plugin — package.json has no "omnyo.server" entry.`,
    );
    process.exit(1);
  }

  return manifest;
}

const scaffoldPackageSchema = z.object({
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

async function unresolvedScaffoldPackages(
  targetDir: string,
): Promise<string | null> {
  let declared: string[];

  try {
    const manifest = scaffoldPackageSchema.parse(
      JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")),
    );

    declared = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
    ];
  } catch {
    return "the generated package.json could not be read back";
  }

  const missing: string[] = [];

  for (const name of declared) {
    if (!(await isPackageInstalled(targetDir, name))) {
      missing.push(name);
    }
  }

  return missing.length === 0
    ? null
    : `${missing.sort().join(", ")} missing from node_modules`;
}

async function isPackageInstalled(
  targetDir: string,
  name: string,
): Promise<boolean> {
  const segments = name.split("/");
  let dir = targetDir;

  for (;;) {
    try {
      await access(join(dir, "node_modules", ...segments));

      return true;
    } catch {
      const parent = dirname(dir);

      if (parent === dir) return false;
      dir = parent;
    }
  }
}

async function currentPrivateSdkArtifact() {
  const cliDirectory = process.env.OMNYO_CLI_DIR;

  return resolvePrivateSdkArtifact({
    sourceUrl: import.meta.url,
    ...(cliDirectory === undefined ? {} : { cliDirectory }),
  });
}

async function execNpm(
  args: readonly string[],
  options: { cwd?: string; timeout?: number; killSignal?: NodeJS.Signals },
): Promise<{ stdout: string; stderr: string }> {
  const { exec, execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  if (process.platform === "win32") {
    return promisify(exec)(["npm", ...args].join(" "), options);
  }

  return promisify(execFile)("npm", [...args], options);
}

const NPM_FAILURE_DETAIL_LINES = 8;

function npmOutputTail(output: unknown): string {
  if (typeof output !== "string") return "";

  return output.trim().split("\n").slice(-NPM_FAILURE_DETAIL_LINES).join("\n");
}

function npmFailureDetail(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return "";
  const stderr = "stderr" in cause ? npmOutputTail(cause.stderr) : "";
  const stdout = "stdout" in cause ? npmOutputTail(cause.stdout) : "";
  const text = stderr || stdout;

  if (text === "") return "";

  return `\n${text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}`;
}

async function installScaffoldDependencies(
  targetDir: string,
): Promise<boolean> {
  try {
    await execNpm(["install", "--include=dev", "--no-fund", "--no-audit"], {
      cwd: targetDir,
    });
  } catch (cause) {
    console.warn(
      `Could not run npm install — run it in the plugin directory before \`omnyo plugin build\`.${npmFailureDetail(cause)}`,
    );

    return false;
  }

  const problem = await unresolvedScaffoldPackages(targetDir);

  if (problem !== null) {
    console.warn(
      `npm install reported success but ${problem} — run \`npm install --include=dev\` in the plugin directory before \`omnyo plugin build\`.`,
    );

    return false;
  }

  console.log("Installed dependencies (npm install).");

  return true;
}

type PluginSettingDescriptor = NonNullable<
  CompatiblePluginSettingsResult["schema"]
>[string];

async function callPlugins(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const response = await cliFetch(`${baseUrl}/api/v1/plugins${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

  const text = await response.text();
  let parsed: unknown;

  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Unexpected response from /api/v1/plugins${path} (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  if (!response.ok && ![400, 404, 409, 422].includes(response.status)) {
    throw new Error(`/api/v1/plugins${path} failed: HTTP ${response.status}`);
  }

  return parsed;
}

const UPDATE_STATUS_LABELS: Record<PluginUpdateResult["outcome"], string> = {
  current: "current",
  "update-available": "update available",
  pinned: "pinned",
  incompatible: "incompatible",
  unavailable: "unavailable",
};

function blockedSummary(result: PluginUpdateResult): string {
  if (!result.blocked) return "—";

  return `${result.blocked.version}: ${result.blocked.reasons.join("; ")}`;
}

function updateDetail(result: PluginUpdateResult): string {
  return result.detail ?? result.blocked?.reasons.join("; ") ?? "";
}

async function confirmPluginAction(
  prompt: string,
  refusal: string,
  yes: boolean,
): Promise<void> {
  if (yes) return;

  if (!process.stdin.isTTY) {
    console.error(refusal);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
  rl.close();

  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    process.exit(1);
  }
}

function outputMutationJson(
  opts: JsonOutputOptions,
  result: { ok: boolean },
): boolean {
  if (!outputJson(opts, result)) return false;

  if (!result.ok) process.exit(1);

  return true;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatAbsoluteDate(value: number): string {
  const date = new Date(value);

  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function dualInterpretationError(source: string): string {
  return (
    `Could not resolve "${source}" as either a catalog plugin or a path on disk. ` +
    "Use a Git repository URL, path:<path>, npm:<package>, git:<url>[@<ref>], or " +
    "git:<url>@<semver-range> to choose an interpretation explicitly."
  );
}

function withGitTagPrefix(source: string, tagPrefix: string): string {
  const at = source.lastIndexOf("@");
  const spec = at <= 0 ? "" : source.slice(at + 1);

  if (
    (!source.startsWith("git:") && !/^https?:\/\//iu.test(source)) ||
    spec.length === 0
  ) {
    throw new Error(
      "--tag-prefix applies to a git: source with a semver range, such as git:github.com/acme/repo@^1.2.0.",
    );
  }

  if (spec.startsWith("semver:") || spec.startsWith("ref:")) {
    throw new Error(
      `Use --tag-prefix or an explicit "${spec.split(":")[0] ?? ""}:" spec, not both.`,
    );
  }

  return `${source.slice(0, at)}@semver:${tagPrefix}:${spec}`;
}

function hasPathSyntax(source: string): boolean {
  return (
    source.includes("/") ||
    source.includes("\\") ||
    source.startsWith(".") ||
    source.startsWith("~")
  );
}

async function existsOnDisk(source: string): Promise<boolean> {
  try {
    await access(resolve(source));

    return true;
  } catch {
    return false;
  }
}

type InstallIntent =
  | { kind: "source"; source: string; summary: string }
  | { kind: "catalog"; plan: PluginCatalogInstallPlan };

const QUALIFIED_ENTRY_PATTERN = /^([a-z0-9][a-z0-9-]*)@([a-z0-9][a-z0-9-]*)$/u;

function installPlan(
  baseUrl: string,
  args: { entryId: string; marketplace?: string },
): Promise<PluginCatalogInstallPlan> {
  return createCliOmnyoSdk(baseUrl).plugins.catalog.installPlan(args);
}

async function resolveInstallIntent(
  baseUrl: string,
  input: string,
): Promise<InstallIntent> {
  if (
    ["path:", "npm:", "git:", "builtin:"].some((prefix) =>
      input.startsWith(prefix),
    )
  ) {
    if (input.startsWith("path:")) {
      const path = resolve(input.slice(5));

      return {
        kind: "source",
        source: `path:${path}`,
        summary: `Installing ${path}`,
      };
    }

    return { kind: "source", source: input, summary: `Installing ${input}` };
  }

  if (/^https?:\/\//iu.test(input)) {
    return { kind: "source", source: input, summary: `Installing ${input}` };
  }

  if (hasPathSyntax(input)) {
    const path = resolve(input);

    return {
      kind: "source",
      source: `path:${path}`,
      summary: `Installing ${path}`,
    };
  }

  const qualified = QUALIFIED_ENTRY_PATTERN.exec(input);

  if (qualified !== null) {
    const [, entryId, marketplace] = qualified;

    return {
      kind: "catalog",
      plan: await installPlan(baseUrl, {
        entryId: entryId ?? "",
        marketplace: marketplace ?? "",
      }),
    };
  }

  if (!input.includes("@")) {
    const listed = (await searchCatalog(baseUrl, input)).some(
      (candidate) =>
        candidate.entryId === input || candidate.pluginId === input,
    );

    if (listed) {
      return {
        kind: "catalog",
        plan: await installPlan(baseUrl, { entryId: input }),
      };
    }
  }

  if (!(await existsOnDisk(input)))
    throw new Error(dualInterpretationError(input));

  const path = resolve(input);

  return {
    kind: "source",
    source: `path:${path}`,
    summary: `Installing ${path}`,
  };
}

function resolvedSourceLines(source: PluginCatalogResolvedSource): string[] {
  if (source.kind === "npm") {
    const spec = source.range ?? source.tag ?? "latest";

    return [
      `  npm package: ${source.package}@${spec}`,
      ...(source.registry === undefined
        ? []
        : [`  registry: ${source.registry}`]),
    ];
  }

  const lines = [`  git repository: ${source.url}`];

  if (source.subdir !== undefined) {
    lines.push(`  subdirectory: ${source.subdir}`);
  }

  if (source.ref !== undefined) lines.push(`  ref: ${source.ref}`);

  if (source.range !== undefined) {
    const prefix =
      source.tagPrefix === undefined ? "" : ` (tags ${source.tagPrefix}vX.Y.Z)`;

    lines.push(`  semver range: ${source.range}${prefix}`);
  }

  if (source.resolvedTag !== undefined) {
    lines.push(`  resolves to tag: ${source.resolvedTag}`);
  }

  if (source.resolvedCommit !== undefined) {
    lines.push(`  resolves to commit: ${source.resolvedCommit}`);
  }

  if (source.unresolvedReason !== undefined) {
    lines.push(`  not resolved right now: ${source.unresolvedReason}`);
  }

  return lines;
}

function installPlanSummary(plan: PluginCatalogInstallPlan): string {
  if (plan.kind === "bundled") {
    return `Installing ${plan.displayName}, bundled with Omnyo (${plan.source})`;
  }

  const author =
    plan.author.url === null
      ? plan.author.name
      : `${plan.author.name} (${plan.author.url})`;

  return [
    `Installing ${plan.displayName} (${plan.entryId}@${plan.marketplace})`,
    `  marketplace: ${plan.marketplaceDisplayName} — a third-party marketplace, not reviewed by Omnyo`,
    `  author: ${author}`,
    ...resolvedSourceLines(plan.resolvedSource),
  ].join("\n");
}

function printPlugin(plugin: PluginEntry): void {
  const state = plugin.enabled ? plugin.status : "disabled";
  const detail = plugin.statusDetail ? `  (${plugin.statusDetail})` : "";
  const official = plugin.official ? "  official" : "";
  console.log(`${plugin.id}@${plugin.version}  ${state}${official}${detail}`);
  console.log(`  source: ${plugin.source}`);

  if (plugin.author != null) {
    console.log(
      `  author: ${plugin.author.url === null ? plugin.author.name : `${plugin.author.name} (${plugin.author.url})`}`,
    );
  }

  if (plugin.repositoryUrl !== null) {
    console.log(`  repository: ${plugin.repositoryUrl}`);
  }

  const stats = plugin.handlerStats;

  if (stats && stats.count > 0) {
    const errors = stats.errorCount > 0 ? `, ${stats.errorCount} errors` : "";
    console.log(
      `  handlers: ${stats.count} calls / ${formatMs(stats.totalMs)} total / ${formatMs(stats.maxMs)} max${errors}`,
    );
  }

  for (const service of plugin.services ?? []) {
    console.log(`  service ${service.name}: ${service.state}`);
  }

  for (const schedule of plugin.schedules ?? []) {
    const last = schedule.lastStatus ? `, last: ${schedule.lastStatus}` : "";
    const error = schedule.lastError ? ` (${schedule.lastError})` : "";
    console.log(
      `  schedule ${schedule.name} (${schedule.cron}): next ${new Date(schedule.nextRunAt).toISOString()}${last}${error}`,
    );
  }

  if (plugin.cliCommand) {
    const collisionNote = RESERVED_CORE_CLI_COMMANDS.includes(
      plugin.cliCommand.name,
    )
      ? ` (core command "omnyo ${plugin.cliCommand.name}" takes precedence)`
      : "";

    console.log(
      `  command: ${pluginCliCall(plugin.id, plugin.cliCommand.name)} — ${plugin.cliCommand.summary}${collisionNote}`,
    );
  }
}

function exitWithError(result: { error?: string }): never {
  console.error(result.error ?? "Command failed");
  process.exit(1);
}

function sdkErrorMessage(error: unknown): string {
  if (error instanceof OmnyoHttpError) {
    return error.message.replace(/^HTTP \d+: /u, "");
  }

  return error instanceof Error ? error.message : String(error);
}

function printSettings(result: CompatiblePluginSettingsResult): void {
  const schema = result.schema ?? {};
  const values = result.values ?? {};
  const keys = Object.keys(schema);

  if (keys.length === 0) {
    console.log("This plugin declares no settings.");

    return;
  }

  for (const key of keys) {
    const descriptor = schema[key];

    if (!descriptor) continue;

    const meta = [
      descriptor.type,
      ...(descriptor.secret ? ["secret"] : []),
      ...(descriptor.options
        ? [`options: ${descriptor.options.join("|")}`]
        : []),
    ].join(", ");

    let display: string;

    if (descriptor.secret) {
      const value = secretSettingValueSchema.safeParse(values[key]);
      display = value.success && value.data.set ? "[set]" : "[not set]";
    } else {
      const value = values[key];
      display = value === undefined ? "(unset)" : JSON.stringify(value);
    }

    console.log(`${key} = ${display}  (${meta})`);

    const section = descriptor.experimental_section
      ? `${descriptor.experimental_section.title} › `
      : "";

    console.log(
      `  ${section}${descriptor.label}${descriptor.description ? ` — ${descriptor.description}` : ""}`,
    );
  }
}

function parseSettingValue(
  descriptor: PluginSettingDescriptor,
  key: string,
  raw: string,
): string | number | boolean {
  if (descriptor.type === "boolean") {
    if (raw === "true") return true;

    if (raw === "false") return false;
    console.error(`Setting "${key}" is a boolean — pass true or false.`);
    process.exit(1);
  }

  if (descriptor.type === "select" && !descriptor.options?.includes(raw)) {
    console.error(
      `Setting "${key}" must be one of: ${descriptor.options?.join(", ") ?? ""}`,
    );
    process.exit(1);
  }

  if (descriptor.type === "number") {
    let value: unknown;

    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }

    if (typeof value === "number" && Number.isFinite(value)) return value;
    console.error(`Setting "${key}" is a number — pass a finite number.`);
    process.exit(1);
  }

  return raw;
}

export function registerPluginCommands(
  program: Command,
  getUrl: () => string,
): void {
  const plugin = program
    .command("plugin")
    .description("Manage Omnyo plugins")
    .enablePositionalOptions();

  const rpc = plugin
    .command("rpc")
    .description("Inspect discoverable plugin RPC methods");

  rpc
    .command("list [plugin-id]")
    .option("--method <name>", "Filter by exact method name")
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          pluginId: string | undefined,
          opts: JsonOutputOptions & { method?: string },
        ) => {
          const methods = await createCliOmnyoSdk(
            getUrl(),
          ).plugins.experimental_discoverRpc({ pluginId, method: opts.method });

          if (opts.json) {
            outputJson(opts, methods);

            return;
          }

          if (methods.length === 0) console.log("No discoverable RPC methods.");

          for (const method of methods)
            console.log(
              `${method.pluginId}  ${method.method}  ${method.methodDescription ?? method.registrationDescription ?? ""}`,
            );
        },
      ),
    );
  rpc
    .command("call <plugin-id> <method>")
    .description("Call a plugin RPC method with server-side schema validation")
    .option(
      "--input-file <path>",
      "Read JSON input from a file; defaults to null",
    )
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          pluginId: string,
          method: string,
          opts: JsonOutputOptions & { inputFile?: string },
        ) => {
          const input =
            opts.inputFile === undefined
              ? null
              : jsonValueSchema.parse(
                  JSON.parse(await readFile(opts.inputFile, "utf8")),
                );

          const result = await createCliOmnyoSdk(getUrl()).plugins.callRpc({
            pluginId,
            method,
            input,
            outputSchema: jsonValueSchema,
          });

          if (opts.json) {
            outputJson(opts, result);

            return;
          }

          console.log(JSON.stringify(result, null, 2));
        },
      ),
    );

  rpc
    .command("inspect <plugin-id> [method]")
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          pluginId: string,
          method: string | undefined,
          opts: JsonOutputOptions,
        ) => {
          const methods = await createCliOmnyoSdk(
            getUrl(),
          ).plugins.experimental_discoverRpc({ pluginId, method });

          if (opts.json) {
            outputJson(opts, methods);

            return;
          }

          if (methods.length === 0) console.log("No discoverable RPC methods.");

          for (const method of methods) {
            console.log(`${method.pluginId} · ${method.method}`);

            if (method.registrationDescription !== null)
              console.log(method.registrationDescription);

            if (method.methodDescription !== null)
              console.log(method.methodDescription);
            console.log(
              "Input schema:",
              JSON.stringify(method.inputSchema, null, 2),
            );
            console.log(
              "Output schema:",
              JSON.stringify(method.outputSchema, null, 2),
            );
          }
        },
      ),
    );

  plugin
    .command("search <query>")
    .description(
      "Search every plugin the store lists: the plugins bundled with the app and any third-party marketplace added on this host. The Marketplace column names the source; third-party marketplaces are not reviewed",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (query: string, opts: JsonOutputOptions) => {
        const results = await searchCatalog(getUrl(), query);

        if (opts.json) {
          outputJson(opts, results);

          return;
        }

        const showMarketplace = results.some((result) => !result.official);
        const now = Date.now();

        const badges = results.map((result) =>
          pluginInstallBadgeLabel(pluginInstallBadge(result, now)),
        );

        const showBadges = badges.some((badge) => badge !== "");

        const rows = results.map((result, index) => [
          result.displayName,
          result.description,
          result.category ?? "Uncategorized",
          ...(showMarketplace ? [result.marketplaceDisplayName] : []),
          ...(showBadges ? [badges[index]] : []),
          result.installed
            ? "✓ installed"
            : !result.compatible
              ? `requires newer Omnyo${result.incompatibleReason ? `: ${result.incompatibleReason}` : ""}`
              : result.conflictingInstallSource !== null
                ? `id in use by ${result.conflictingInstallSource}`
                : "compatible",
        ]);

        console.log(
          renderBorderlessTable(
            {
              head: [
                "Name",
                "Description",
                "Category",
                ...(showMarketplace ? ["Marketplace"] : []),
                ...(showBadges ? ["Badge"] : []),
                "Status",
              ],
              colWidths: [
                showMarketplace ? 22 : 24,
                showMarketplace ? 30 : 38,
                24,
                ...(showMarketplace ? [22] : []),
                ...(showBadges ? [10] : []),
                showMarketplace ? 34 : 40,
              ],
              trimTrailingWhitespace: true,
            },
            rows,
          ),
        );
      }),
    );

  plugin
    .command("list")
    .description("List installed plugins and their status")
    .option("--json", "Output JSON")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).plugins.list();

        if (opts.json) {
          outputJson(opts, result);

          return;
        }

        if (result.plugins.length === 0) {
          console.log("No plugins installed.");

          return;
        }

        for (const entry of result.plugins) {
          printPlugin(entry);
        }
      }),
    );

  plugin
    .command("source <id>")
    .description("Show an installed plugin's resolved source and history")
    .option("--json", "Output JSON")
    .action(
      action(async (id: string, opts: JsonOutputOptions) => {
        const source = await createCliOmnyoSdk(getUrl()).plugins.getSource({
          pluginId: id,
        });

        if (opts.json) {
          outputJson(opts, source);

          return;
        }

        console.log(`${id}`);
        console.log(`  requested: ${source.requested}`);
        console.log(`  resolved: ${source.resolved}`);

        if (source.subdirectory !== undefined) {
          console.log(`  subdirectory: ${source.subdirectory}`);
        }

        if (source.range !== undefined) console.log(`  range: ${source.range}`);

        if (source.tagPrefix !== undefined) {
          console.log(`  tag prefix: ${source.tagPrefix}`);
        }

        if (source.resolvedTag !== undefined) {
          console.log(`  tag: ${source.resolvedTag}`);
        }

        if (source.registry) console.log(`  registry: ${source.registry}`);

        if (source.integrity) console.log(`  integrity: ${source.integrity}`);

        if (source.engines.omnyo) {
          console.log(`  engines.omnyo: ${source.engines.omnyo}`);
        }

        if (source.engines.omnyoPluginSdk) {
          console.log(
            `  engines.omnyoPluginSdk: ${source.engines.omnyoPluginSdk}`,
          );
        }

        if (source.installedAt !== undefined) {
          console.log(`  installed: ${formatAbsoluteDate(source.installedAt)}`);
        }

        if (source.history.length === 0) {
          console.log("  history: none");

          return;
        }

        console.log("  history:");

        for (const entry of source.history) {
          console.log(
            `    ${entry.version}  ${formatAbsoluteDate(entry.activatedAt)}`,
          );
        }
      }),
    );

  plugin
    .command("install <source>")
    .description(
      "Install a catalog entry by name or <entry>@<marketplace>, a Git repository URL, a local path, builtin:<name>, git:<url>[@<ref|semver-range>], or npm:<name>@<version>. A catalog entry from a third-party marketplace is not reviewed by Omnyo, so its confirmation names the marketplace, the author, and the exact resolved source (managed sources validate engines ranges and build artifacts; bundled plugin ids are reserved)",
    )
    .option(
      "--subdirectory <path>",
      "Install one plugin directory of a multi-plugin git:/path: repository",
    )
    .option(
      "--plugin <name>",
      "Install the .omnyo/plugins.json entry with this name (git:/path: repositories)",
    )
    .option(
      "--tag-prefix <prefix>",
      "Resolve a git: semver range over <prefix>vX.Y.Z tags (monorepo tagging)",
    )
    .option("--yes", "Skip the confirmation prompt")
    .option(
      "--no-wait",
      "Start the install in the background and print its job; follow it with `omnyo plugin install-jobs`",
    )
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          source: string,
          opts: JsonOutputOptions & {
            yes?: boolean;
            subdirectory?: string;
            plugin?: string;
            tagPrefix?: string;
            wait: boolean;
          },
        ) => {
          if (opts.subdirectory !== undefined && opts.plugin !== undefined) {
            throw new Error(
              "Use --subdirectory or --plugin, not both: --plugin resolves a name from .omnyo/plugins.json to a subdirectory.",
            );
          }

          const requested =
            opts.tagPrefix === undefined
              ? source
              : withGitTagPrefix(source, opts.tagPrefix);

          const intent = await resolveInstallIntent(getUrl(), requested);

          if (intent.kind === "catalog" && opts.tagPrefix !== undefined) {
            throw new Error(
              `"${source}" is a catalog entry; --tag-prefix applies to git: sources only.`,
            );
          }

          if (
            intent.kind === "catalog" &&
            (opts.subdirectory !== undefined || opts.plugin !== undefined)
          ) {
            throw new Error(
              `"${source}" is a catalog entry; --subdirectory and --plugin apply to git: and path: repositories only.`,
            );
          }

          let summary =
            intent.kind === "source"
              ? intent.summary
              : installPlanSummary(intent.plan);

          if (intent.kind === "source" && intent.source.startsWith("path:")) {
            const path = intent.source.slice(5);

            try {
              const raw: unknown = JSON.parse(
                await readFile(join(path, "package.json"), "utf8"),
              );

              const pkg = pluginPackageSummarySchema.parse(raw);

              if (pkg.name !== undefined) {
                summary = `Installing ${pkg.name}@${pkg.version ?? "?"} from ${path}`;
                const pluginId = derivePluginId(pkg.name);

                const { plugins } =
                  await createCliOmnyoSdk(getUrl()).plugins.list();

                const installed = plugins.find((p) => p.id === pluginId);

                if (
                  installed !== undefined &&
                  installed.source.startsWith("path:") &&
                  installed.rootDir !== path
                ) {
                  summary = `${summary}\nThis moves "${pluginId}" from ${installed.rootDir}; its settings, secrets, and schedules are kept.`;
                }
              }
            } catch {}
          }

          if (opts.subdirectory !== undefined) {
            summary = `${summary} (subdirectory ${opts.subdirectory})`;
          }

          if (opts.plugin !== undefined) {
            summary = `${summary} (collection plugin ${opts.plugin})`;
          }

          if (!opts.json) {
            console.log(summary);
            console.log(
              "Plugins are full-trust code running inside the Omnyo server. " +
                "They can read all local Omnyo data, including other plugins' secrets.",
            );
          }

          await confirmPluginAction(
            "Install?",
            "Refusing to install without confirmation — re-run with --yes.",
            opts.yes === true,
          );
          const plugins = createCliOmnyoSdk(getUrl()).plugins;

          const request =
            intent.kind === "source"
              ? {
                  kind: "source" as const,
                  args: {
                    source: intent.source,
                    ...(opts.subdirectory === undefined
                      ? {}
                      : { subdirectory: opts.subdirectory }),
                    ...(opts.plugin === undefined
                      ? {}
                      : { plugin: opts.plugin }),
                  },
                }
              : {
                  kind: "catalog" as const,
                  args:
                    intent.plan.kind === "marketplace"
                      ? {
                          entryId: intent.plan.entryId,
                          marketplace: intent.plan.marketplace,
                          ...(intent.plan.official
                            ? {}
                            : { confirmedSource: intent.plan.resolvedSource }),
                        }
                      : { entryId: intent.plan.entryId },
                };

          if (!opts.wait) {
            const job =
              request.kind === "source"
                ? await plugins.startInstall(request.args)
                : await plugins.catalog.startInstall(request.args);

            if (opts.json) {
              outputJson(opts, { ok: true as const, job });

              return;
            }

            console.log(
              `Installing ${job.displayName} in the background (job ${job.id}).`,
            );
            console.log(
              `Follow it with \`omnyo plugin install-jobs\`; cancel it with \`omnyo plugin cancel-install ${job.id}\`.`,
            );

            return;
          }

          const plugin =
            request.kind === "source"
              ? await plugins.install(request.args)
              : await plugins.catalog.install(request.args);

          const result = { ok: true as const, plugin };

          if (opts.json) {
            outputJson(opts, result);

            return;
          }

          console.log("Installed:");
          printPlugin(plugin);
        },
      ),
    );

  plugin
    .command("install-jobs")
    .description(
      "List plugin installs that are queued or running, and those that finished in the last ten minutes. Installs run one at a time on the server and continue when the CLI or app disconnects",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const jobs =
          await createCliOmnyoSdk(getUrl()).plugins.installJobs.list();

        if (opts.json) {
          outputJson(opts, { jobs });

          return;
        }

        if (jobs.length === 0) {
          console.log("No recent plugin installs.");

          return;
        }

        console.log(
          renderBorderlessTable(
            {
              head: ["Job", "Plugin", "State", "Detail"],
              colWidths: [38, 28, 12, 60],
              trimTrailingWhitespace: true,
            },
            jobs.map((job) => [
              job.id,
              job.displayName,
              job.state,
              job.state === "failed"
                ? job.error
                : job.state === "succeeded"
                  ? job.plugin.id
                  : "",
            ]),
          ),
        );
      }),
    );

  plugin
    .command("cancel-install <job-id>")
    .description(
      "Cancel a plugin install. A queued install is dropped; a running install stops its current download or build and leaves nothing installed, unless it has already started registering the plugin, in which case it finishes",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (jobId: string, opts: JsonOutputOptions) => {
        const job = await createCliOmnyoSdk(
          getUrl(),
        ).plugins.installJobs.cancel({
          jobId,
        });

        if (opts.json) {
          outputJson(opts, { job });

          return;
        }

        console.log(
          job.state === "cancelling"
            ? `Cancelling the ${job.displayName} install.`
            : `The ${job.displayName} install is ${job.state}.`,
        );
      }),
    );

  plugin
    .command("outdated")
    .description("Check installed plugins for compatible updates")
    .option("--json", "Output the raw update results as JSON")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const results =
          await createCliOmnyoSdk(getUrl()).plugins.checkUpdates();

        if (opts.json) {
          outputJson(opts, results);

          return;
        }

        const rows = results.map((result) => [
          result.id,
          result.installed.display,
          result.candidate?.display ?? "—",
          blockedSummary(result),
          `${UPDATE_STATUS_LABELS[result.outcome]}${result.devMode ? " [dev build: engines.omnyo not enforced]" : ""}`,
        ]);

        console.log(
          renderBorderlessTable(
            {
              head: [
                "Plugin",
                "Installed",
                "Latest compatible",
                "Blocked newer",
                "Status",
              ],
              colWidths: [22, 20, 22, 42, 54],
              trimTrailingWhitespace: true,
            },
            rows,
          ),
        );
      }),
    );

  plugin
    .command("update-jobs [job-id]")
    .description(
      "Show background plugin updates and results retained for ten minutes; running jobs survive client disconnections, but not a server restart",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (jobId: string | undefined, opts: JsonOutputOptions) => {
        const updates =
          createCliOmnyoSdk(getUrl()).plugins.experimental_updateJobs;

        const jobs =
          jobId === undefined
            ? await updates.list()
            : [await updates.get({ jobId })];

        if (opts.json) {
          outputJson(opts, { jobs });

          return;
        }

        if (jobs.length === 0) {
          console.log("No recent plugin updates.");

          return;
        }

        console.log(
          renderBorderlessTable(
            {
              head: ["Job", "Plugin", "State", "Detail"],
              colWidths: [38, 28, 12, 60],
              trimTrailingWhitespace: true,
            },
            jobs.map((job) => [
              job.id,
              job.displayName,
              job.state,
              job.state === "running"
                ? job.phase
                : job.state === "failed"
                  ? job.error
                  : job.state === "completed"
                    ? (job.result.detail ?? job.result.outcome)
                    : "",
            ]),
          ),
        );
      }),
    );

  plugin
    .command("update [id]")
    .option(
      "--directory <directory>",
      "Upload a local prepared bundled-plugin runtime and activate it",
    )
    .option(
      "--replace-active <artifact>",
      "Exact active artifact id, or packaged, for a --directory replacement that would otherwise be refused; only to remove your own live change or for an explicitly instructed replacement",
    )
    .description(
      "Update one plugin, or all plugins with --all; waits for the server job by default",
    )
    .option("--no-wait", "Start background updates and return their job IDs")
    .option("--all", "Update every plugin with a compatible update")
    .option("--yes", "Skip confirmation prompts")
    .action(
      action(
        async (
          id: string | undefined,
          opts: {
            all?: boolean;
            yes?: boolean;
            wait?: boolean;
            directory?: string;
            replaceActive?: string;
          },
        ) => {
          if ((id === undefined) === !opts.all) {
            console.error("Specify exactly one plugin id or --all.");
            process.exit(1);
          }

          const sdk = createCliOmnyoSdk(getUrl());

          if (opts.directory !== undefined) {
            if (id === undefined || opts.all) {
              throw new Error(
                "--directory requires one plugin id and cannot use --all.",
              );
            }

            const source = await sdk.plugins.getSource({ pluginId: id });

            if (!source.requested.startsWith("builtin:")) {
              throw new Error(
                "--directory updates only installed bundled plugins.",
              );
            }

            const installed = (await sdk.plugins.list()).plugins.find(
              (entry) => entry.id === id,
            );

            if (installed === undefined)
              throw new Error(`Unknown plugin "${id}".`);

            const activeArtifact = source.activeArtifactId ?? "packaged";

            if (
              opts.replaceActive !== undefined &&
              opts.replaceActive !== activeArtifact
            ) {
              throw new Error(
                `--replace-active names ${opts.replaceActive}, but the active artifact is ${activeArtifact}. Read the plugin source again.`,
              );
            }

            const candidateSource = await readBundledPluginCandidateSource({
              directory: opts.directory,
              pluginName: source.requested.slice("builtin:".length),
            });

            const readPackagedSourceCommit = async () =>
              (await sdk.system.webUpdateStatus()).packagedSourceCommit;

            await requireBundledPluginOnMain({
              source: candidateSource,
              readPackagedSourceCommit,
            });

            const bundledCandidate = await readBundledPluginCandidate({
              directory: opts.directory,
              expectedVersion: installed.version,
              expectedArtifactId: source.activeArtifactId,
              sourceIdentity: bundledPluginSourceIdentity(candidateSource),
            });

            const review = await reviewBundledPluginReplacement({
              source: candidateSource,
              activeRootDir: installed.rootDir,
              installedVersion: installed.version,
              candidateVersion: bundledCandidateVersion(bundledCandidate),
              readPackagedSourceCommit,
            });

            if (review.warning !== null) console.error(review.warning);

            if (review.refusal !== null && opts.replaceActive === undefined) {
              throw new Error(
                `${review.refusal} To replace the installed artifact anyway, pass --replace-active ${activeArtifact}; use it only to remove your own live change or for a replacement you were explicitly told to make.`,
              );
            }

            console.log(
              `${id}: upload ${bundledCandidate.files.length} runtime files and activate. Plugins are full-trust code.`,
            );
            await confirmPluginAction(
              "Update and activate?",
              "Refusing to update without confirmation — re-run with --yes.",
              opts.yes === true,
            );

            if (opts.wait === false) {
              const job = await sdk.plugins.experimental_startUpdate({
                pluginId: id,
                bundledCandidate,
              });

              console.log(
                `Updating ${job.displayName} in the background (job ${job.id}).`,
              );
              console.log(
                `Follow it with \`omnyo plugin update-jobs ${job.id}\`.`,
              );
            } else {
              const mutation = await sdk.plugins.applyUpdate({
                pluginId: id,
                bundledCandidate,
              });

              console.log(
                `${id}: ${mutation.outcome}${mutation.detail ? ` — ${mutation.detail}` : ""}.`,
              );
            }

            return;
          }

          const results = await sdk.plugins.checkUpdates(
            id === undefined ? {} : { pluginId: id },
          );

          const sources = new Map<string, string>();

          if (results.some((result) => result.outcome === "update-available")) {
            const list = await sdk.plugins.list();

            for (const entry of list.plugins)
              sources.set(entry.id, entry.sourceDisplay);
          }

          for (const result of results) {
            const source = sources.get(result.id) ?? "unknown source";
            const detail = updateDetail(result);
            const shouldAttempt = result.outcome === "update-available";

            if (!shouldAttempt) {
              if (result.outcome === "pinned") {
                console.log(
                  `${result.id}: skipped — pinned${detail ? ` (${detail})` : ""}; remove and reinstall with a tracking npm range, git branch, or git semver range to receive updates (remove deletes the plugin's settings, secrets, and schedules). A local path plugin updates with \`omnyo plugin reload <id>\`, which also moves a plugin running a verified snapshot onto its source folder. If its folder moved, run \`omnyo plugin relocate <old folder> <new folder>\`; to install it from another folder, run \`omnyo plugin install path:<new directory>\`.`,
                );
              } else if (result.outcome === "incompatible") {
                console.log(
                  `${result.id}: skipped — incompatible${detail ? `: ${detail}` : "."}`,
                );
              } else if (result.outcome === "unavailable") {
                console.log(
                  `${result.id}: skipped — unavailable${detail ? `: ${detail}` : "."}`,
                );
              } else {
                console.log(
                  `${result.id}: current (${result.installed.display}).`,
                );
              }

              continue;
            }

            const target = result.candidate?.display ?? "latest compatible";
            console.log(
              `${result.id}: ${result.installed.display} → ${target} from ${source}. Plugins are full-trust code.`,
            );
            await confirmPluginAction(
              "Update and activate?",
              "Refusing to update without confirmation — re-run with --yes.",
              opts.yes === true,
            );

            if (opts.wait === false) {
              const job = await sdk.plugins.experimental_startUpdate({
                pluginId: result.id,
              });

              console.log(
                `Updating ${job.displayName} in the background (job ${job.id}).`,
              );
              console.log(
                `Follow it with \`omnyo plugin update-jobs ${job.id}\`.`,
              );
              continue;
            }

            let mutation: PluginApplyUpdateResult;

            try {
              mutation = await sdk.plugins.applyUpdate({
                pluginId: result.id,
              });
            } catch (error) {
              exitWithError({ error: sdkErrorMessage(error) });
            }

            if (mutation.applied) {
              console.log(
                `${result.id}: updated and activated ${mutation.from.display} → ${mutation.to?.display ?? target}.`,
              );
            } else {
              console.log(
                `${result.id}: ${mutation.outcome}${mutation.detail ? ` — ${mutation.detail}` : ""}`,
              );
            }
          }
        },
      ),
    );

  plugin
    .command("new <name>")
    .description(
      "Scaffold a private plugin in ./omnyo-plugin-<name>; accepts @scope/omnyo-plugin-<name>",
    )
    .option(
      "--event-source",
      "Scaffold a wait event source: a family of <name>:<target> keys that omnyo wait --event can name",
    )
    .action(
      action(async (name: string, opts: { eventSource?: boolean }) => {
        const target = resolveNewPluginTarget(name);

        if (target === null) {
          console.error(
            `Invalid or reserved plugin name "${name}" — use a non-core name, omnyo-plugin-name, or @scope/omnyo-plugin-name.`,
          );
          process.exit(1);
        }

        const { directoryName, packageName } = target;
        const targetDir = resolve(process.cwd(), directoryName);
        const sdkArtifact = await currentPrivateSdkArtifact();

        const scaffold = opts.eventSource
          ? scaffoldEventSourcePlugin
          : scaffoldPlugin;

        await scaffold({
          targetDir,
          packageName,
          appVersion: resolveOmnyoCliVersion(),
          sdkArtifact,
        });
        console.log(`Created ${directoryName}/ (${packageName}).`);
        const installed = await installScaffoldDependencies(targetDir);
        console.log("Next steps:");
        console.log(`  cd ${directoryName}`);

        if (!installed) {
          console.log("  npm install --include=dev");
        }

        if (opts.eventSource) console.log("  npm test");

        console.log("  omnyo plugin install .");

        if (opts.eventSource)
          console.log(
            `  omnyo wait check ${eventSourceFamilyOf(packageName)}:left-pad@1.3.0`,
          );
      }),
    );

  plugin
    .command("types [path]")
    .description(
      "Sync this plugin to the verified private SDK shipped with the selected Omnyo runtime (default: cwd)",
    )
    .option(
      "--check",
      "Report whether the SDK surface is current; write nothing",
    )
    .action(
      action(async (path: string | undefined, opts: { check?: boolean }) => {
        const rootDir = resolve(process.cwd(), path ?? ".");
        await requirePluginManifest(rootDir);
        const layout = await resolvePluginSdkLayout(rootDir);

        if (layout.kind === "vendored")
          throw new Error(LEGACY_PLUGIN_SDK_LAYOUT_MESSAGE);
        const sdkArtifact = await currentPrivateSdkArtifact();

        const pending = await setPluginSdkPin({
          rootDir,
          sdkArtifact,
          dryRun: true,
        });

        if (opts.check) {
          if (pending !== null)
            throw new Error(
              "Plugin SDK bytes or declarations differ from this runtime. Run `omnyo plugin types`.",
            );
          console.log(
            `Private @omnyo/plugin-sdk ${sdkArtifact.version} is current.`,
          );

          return;
        }

        await setPluginSdkPin({ rootDir, sdkArtifact });
        console.log(
          `Private @omnyo/plugin-sdk ${sdkArtifact.version} copied and pinned in vendor/.`,
        );
        console.log(
          "Run `pnpm install` in the plugin directory to install the pinned declarations.",
        );
      }),
    );

  plugin
    .command("migrate [path]")
    .description(
      "Import legacy plugin metadata and SDK sources into the private Omnyo layout; preserve vendored declarations and ask before applying",
    )
    .option("--yes", "Skip the confirmation prompt")
    .action(
      action(async (path: string | undefined, opts: { yes?: boolean }) => {
        const rootDir = resolve(process.cwd(), path ?? ".");
        await requirePluginManifest(rootDir);
        const sdkArtifact = await currentPrivateSdkArtifact();

        const plan = await migratePluginToPackageLayout({
          rootDir,
          sdkArtifact,
          dryRun: true,
        });

        if (!plan.changed) {
          console.log(
            "This plugin already uses the selected private Omnyo SDK.",
          );

          return;
        }

        console.log(`Migrate ${rootDir} to the selected private Omnyo SDK:`);
        printMigrationPlan(plan);
        await confirmPluginAction(
          "Apply these changes?",
          "Re-run with --yes to apply the displayed migration.",
          opts.yes ?? false,
        );

        const confirmedPlan = await migratePluginToPackageLayout({
          rootDir,
          sdkArtifact,
          dryRun: true,
        });

        if (!samePlan(plan, confirmedPlan))
          throw new Error(
            "The plugin changed while awaiting confirmation. Re-run `omnyo plugin migrate`.",
          );

        const applied = await migratePluginToPackageLayout({
          rootDir,
          sdkArtifact,
        });

        console.log(
          "Migrated to the private Omnyo SDK. Original declaration bytes are retained in vendor/legacy-plugin-sdk-v1/.",
        );

        if (plan.removedTypesDir && !applied.removedTypesDir)
          console.warn(
            "The types directory gained another file; its contents and include were preserved.",
          );
        console.log(
          "Run `pnpm install` in the plugin directory to install the pinned declarations.",
        );
      }),
    );

  plugin
    .command("build [path]")
    .description(
      "Compile the plugin into dist/: the omnyo.server backend bundle (server.js, server.meta.json), plus, when declared, the omnyo.app frontend bundle (app.js, app.css, app.meta.json) and the self-contained omnyo.host daemon bundle (host.js, host.js.map, host.meta.json) — which carries the plugin's host RPC entry, its provider bridge, or both; each *.meta.json stamps SDK/identity metadata; no server required",
    )
    .action(
      action(async (path: string | undefined) => {
        const rootDir = resolve(process.cwd(), path ?? ".");
        const appVersion = resolveOmnyoCliVersion();
        const manifest = await readPluginManifest(rootDir);
        const hasApp = typeof manifest?.omnyo.app === "string";
        const hasHost = typeof manifest?.omnyo.host === "string";
        await checkPluginSdkLayout(rootDir);
        const toolchain = await cliBuildToolchain();
        const server = await buildPluginServer(rootDir, appVersion, toolchain);
        const files = [server.jsPath, server.mapPath, server.metaPath];

        if (hasApp) {
          const app = await buildPluginApp(rootDir, appVersion, toolchain);
          files.push(app.jsPath, app.cssPath, app.metaPath);
        }

        if (hasHost) {
          const host = await buildPluginHost(rootDir, appVersion, toolchain);
          files.push(host.jsPath, host.mapPath, host.metaPath);
        }

        for (const file of files) {
          console.log(relative(process.cwd(), file));
        }
      }),
    );

  plugin
    .command("dev [path]")
    .description(
      "Watch a plugin's sources: rebuild its frontend (unminified, for readable stack traces), host, and provider-bridge bundles when declared, then reload it on every change (Ctrl+C to stop)",
    )
    .action(
      action(async (path: string | undefined) => {
        const rootDir = resolve(process.cwd(), path ?? ".");
        const manifest = await requirePluginManifest(rootDir);
        const hasApp = typeof manifest.omnyo.app === "string";
        const hasHost = typeof manifest.omnyo.host === "string";
        await checkPluginSdkLayout(rootDir);
        const realDir = await realpath(rootDir).catch(() => rootDir);
        const list = await createCliOmnyoSdk(getUrl()).plugins.list();

        const entry = list.plugins.find(
          (candidate) =>
            candidate.rootDir === rootDir || candidate.rootDir === realDir,
        );

        if (!entry) {
          console.error(
            `This directory is not installed as a plugin — run \`omnyo plugin install ${path ?? "."}\` first, then re-run \`omnyo plugin dev\`.`,
          );
          process.exit(1);
        }

        const loop = createPluginDevLoop({
          pluginId: entry.id,

          targets: async () => {
            const current = await requirePluginManifest(rootDir);

            return {
              hasApp: typeof current.omnyo.app === "string",
              hasHost: typeof current.omnyo.host === "string",
            };
          },
          buildApp: async () => {
            await buildPluginApp(
              rootDir,
              resolveOmnyoCliVersion(),
              await cliBuildToolchain(),
              { minify: false },
            );
          },
          buildHost: async () => {
            await buildPluginHost(
              rootDir,
              resolveOmnyoCliVersion(),
              await cliBuildToolchain(),
            );
          },
          reloadPlugin: async () => {
            const result = pluginMutationResponseSchema.parse(
              await callPlugins(
                getUrl(),
                `/reload?id=${encodeURIComponent(entry.id)}`,
                "POST",
              ),
            );

            if (!result.ok) throw new Error(result.error ?? "reload failed");
          },
          log: (line) => console.log(line),
        });

        const watcher = watch(
          rootDir,
          { recursive: true },
          (_event, filename) => {
            if (typeof filename === "string" && filename.length > 0) {
              loop.handleChange(filename);
            }
          },
        );

        console.log(
          `Watching ${rootDir} for plugin "${entry.id}"${hasApp || hasHost ? ` (${[hasApp ? "frontend" : null, hasHost ? "host" : null].filter(Boolean).join(" + ")} rebuild + reload on change)` : " (reload on change)"} — Ctrl+C to stop.`,
        );
        await new Promise<void>((resolveDone) => {
          const stop = (): void => {
            watcher.close();
            loop.dispose();
            resolveDone();
          };

          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      }),
    );

  plugin
    .command("reload [id]")
    .description(
      "Reload one plugin, or all plugins. Naming a local path plugin that runs a verified snapshot loads it from its source folder instead, keeping its settings, secrets, schedules and enabled state; if it cannot start there, the snapshot stays",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (id: string | undefined, opts: JsonOutputOptions) => {
        const query = id ? `?id=${encodeURIComponent(id)}` : "";

        const response = pluginMutationResponseSchema.parse(
          await callPlugins(getUrl(), `/reload${query}`, "POST"),
        );

        const result =
          id !== undefined &&
          response.ok &&
          !response.plugins?.some((entry) => entry.id === id)
            ? { ok: false as const, error: `unknown plugin "${id}"` }
            : response;

        if (outputMutationJson(opts, result)) return;

        const reloaded =
          id === undefined
            ? (result.plugins ?? [])
            : (result.plugins ?? []).filter((entry) => entry.id === id);

        for (const entry of reloaded) {
          printPlugin(entry);
        }

        const snapshots =
          id === undefined
            ? reloaded.filter(
                (entry) =>
                  entry.source.startsWith("path:") &&
                  entry.rootDir !== entry.source.slice("path:".length),
              )
            : [];

        if (snapshots.length > 0) {
          console.log(
            `${snapshots.length} local path plugin${snapshots.length === 1 ? "" : "s"} kept a verified snapshot instead of the source folder: ${snapshots.map((entry) => entry.id).join(", ")}. Run \`omnyo plugin reload <id>\` to load one from its source folder.`,
          );
        }

        if (!result.ok) exitWithError(result);
      }),
    );

  for (const [name, description] of [
    ["enable", "Enable an installed plugin"],
    ["disable", "Disable an installed plugin (its code is unloaded)"],
  ] as const) {
    plugin
      .command(`${name} <id>`)
      .description(description)
      .option("--json", "Output JSON")
      .action(
        action(async (id: string, opts: JsonOutputOptions) => {
          const response = pluginMutationResponseSchema.parse(
            await callPlugins(
              getUrl(),
              `/${encodeURIComponent(id)}/${name}`,
              "POST",
            ),
          );

          const failedPlugin =
            name === "enable" &&
            response.plugin?.enabled === true &&
            response.plugin.status === "error"
              ? response.plugin
              : null;

          const result = failedPlugin
            ? {
                ...response,
                ok: false,
                error:
                  failedPlugin.statusDetail ?? `plugin "${id}" failed to load`,
              }
            : response;

          if (outputMutationJson(opts, result)) return;

          if (result.plugin) printPlugin(result.plugin);

          if (!result.ok || !result.plugin) exitWithError(result);
        }),
      );
  }

  plugin
    .command("safe-mode [state]")
    .description(
      "Show plugin safe mode, or turn it on or off. `on` stops every plugin you installed (official store plugins included) while plugins included with Omnyo keep running; `off` restarts the ones that were enabled and exits 1 if any fail to start",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (state: string | undefined, opts: JsonOutputOptions) => {
        if (state !== undefined && state !== "on" && state !== "off") {
          exitWithError({ error: `expected "on" or "off", got "${state}"` });
        }

        const plugins = createCliOmnyoSdk(getUrl()).plugins;

        const updated =
          state === undefined
            ? null
            : await plugins.experimental_setSafeMode({
                enabled: state === "on",
              });

        const result = updated ?? (await plugins.experimental_getSafeMode());
        const problems = updated?.problems ?? [];

        if (opts.json) {
          outputJson(opts, result);
        } else {
          console.log(`Plugin safe mode is ${result.enabled ? "on" : "off"}.`);

          for (const problem of problems) console.error(problem);
        }

        if (problems.length > 0) process.exit(1);
      }),
    );

  plugin
    .command("prune")
    .description(
      "Delete cached plugin versions that no installed plugin uses, such as versions left by earlier Omnyo releases, rolled-back updates, or interrupted operations, and unrecorded cache directories. Updates and removals already delete what they replace. Never touches a version an installed plugin runs or a local path source",
    )
    .option("--dry-run", "List what would be deleted without deleting it")
    .option("--max-items <number>", "Maximum number of cache entries to remove")
    .option("--max-bytes <number>", "Maximum reported cache bytes to remove")
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          opts: JsonOutputOptions & {
            dryRun?: boolean;
            maxItems?: string;
            maxBytes?: string;
          },
        ) => {
          const result = await createCliOmnyoSdk(
            getUrl(),
          ).plugins.experimental_pruneCache({
            dryRun: opts.dryRun === true,
            maxItems:
              opts.maxItems === undefined ? undefined : Number(opts.maxItems),
            maxBytes:
              opts.maxBytes === undefined ? undefined : Number(opts.maxBytes),
          });

          if (opts.json) {
            outputJson(opts, result);

            return;
          }

          if (result.removed.length === 0) {
            console.log("No unused cached plugin versions.");

            return;
          }

          for (const entry of result.removed) {
            console.log(
              `${formatCacheBytes(entry.bytes).padStart(9)}  ${entry.pluginId ?? "(unrecorded)"}@${entry.version}  ${entry.path}`,
            );
          }

          console.log(
            `${result.dryRun ? "Would free" : "Freed"} ${formatCacheBytes(result.bytes)} from ${result.removed.length} cached plugin version${result.removed.length === 1 ? "" : "s"}.`,
          );
        },
      ),
    );

  plugin
    .command("relocate <from> <to>")
    .description(
      "Point installed local path plugins at a folder that moved from <from> to <to>, for example after renaming a checkout. <from> must still lead to <to> through a link. Plugins that run from a verified snapshot keep it; plugins that run from the folder reload from <to>. Settings, secrets, and schedules are kept",
    )
    .option("--dry-run", "List the plugins that would be relocated")
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          from: string,
          to: string,
          opts: JsonOutputOptions & { dryRun?: boolean },
        ) => {
          const result = await createCliOmnyoSdk(
            getUrl(),
          ).plugins.experimental_relocatePathSources({
            from: resolve(from),
            to: resolve(to),
            dryRun: opts.dryRun === true,
          });

          if (opts.json) {
            outputJson(opts, result);

            return;
          }

          if (result.relocated.length === 0) {
            console.log(
              `No installed plugin uses a source under ${resolve(from)}.`,
            );

            return;
          }

          for (const entry of result.relocated) {
            console.log(
              `${entry.pluginId}: ${entry.from} -> ${entry.to} (${entry.mode === "snapshot" ? "keeps its verified snapshot" : entry.reloaded ? "reloads from the new folder" : "disabled; starts from the new folder when enabled"})`,
            );
          }

          console.log(
            `${result.dryRun ? "Would relocate" : "Relocated"} ${result.relocated.length} plugin${result.relocated.length === 1 ? "" : "s"}.`,
          );
        },
      ),
    );

  plugin
    .command("config <id> [action] [key] [value]")
    .description(
      "Show a plugin's settings, or change them: config <id> set <key> <value> | config <id> unset <key>",
    )
    .option("--json", "Output JSON")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(
      action(
        async (
          id: string,
          actionName: string | undefined,
          key: string | undefined,
          value: string | undefined,
          opts: JsonOutputOptions,
          command: Command,
        ) => {
          const rawArgs = (program as Command & { rawArgs: string[] }).rawArgs;
          const terminatorIndex = rawArgs.indexOf("--");

          const valueIsOption =
            value?.startsWith("-") === true &&
            (terminatorIndex < 0 ||
              terminatorIndex > rawArgs.lastIndexOf(value));

          const valueIsUnknownOption =
            valueIsOption &&
            (actionName !== "set" || !negativeNumberValuePattern.test(value));

          const unknownOption =
            [id, actionName, key, ...command.args.slice(4)].find((argument) =>
              argument?.startsWith("-"),
            ) ?? (valueIsUnknownOption ? value : undefined);

          if (unknownOption !== undefined)
            command.error(`error: unknown option '${unknownOption}'`);
          const expectedArgumentCount = actionName === "unset" ? 3 : 4;

          if (command.args.length > expectedArgumentCount)
            command.error(
              `error: too many arguments for 'config'. Expected ${expectedArgumentCount} arguments but got ${command.args.length}.`,
            );

          if (actionName === undefined) {
            const result = await requestCompatiblePluginSettings(
              { baseUrl: getUrl(), fetch: cliFetch },
              { pluginId: id, method: "GET" },
            );

            if (outputMutationJson(opts, result)) return;

            if (!result.ok) exitWithError(result);
            printSettings(result);

            return;
          }

          if (actionName !== "set" && actionName !== "unset") {
            console.error(
              `Unknown action "${actionName}" — use "set" or "unset".`,
            );
            process.exit(1);
          }

          if (
            key === undefined ||
            (actionName === "set" && value === undefined)
          ) {
            console.error(
              actionName === "set"
                ? "Usage: omnyo plugin config <id> set <key> <value>"
                : "Usage: omnyo plugin config <id> unset <key>",
            );
            process.exit(1);
          }

          let parsedValue: string | number | boolean | null = null;

          if (actionName === "set") {
            if (value === undefined) {
              console.error(
                "Usage: omnyo plugin config <id> set <key> <value>",
              );
              process.exit(1);
            }

            const current = await requestCompatiblePluginSettings(
              { baseUrl: getUrl(), fetch: cliFetch },
              { pluginId: id, method: "GET" },
            );

            if (!current.ok || !current.schema) exitWithError(current);
            const descriptor = current.schema[key];

            if (!descriptor) {
              const known = Object.keys(current.schema).join(", ");
              console.error(
                `Unknown setting "${key}"${known ? ` — known settings: ${known}` : ""}`,
              );
              process.exit(1);
            }

            if (valueIsOption && descriptor.type !== "number") {
              command.error(`error: unknown option '${value}'`);
            }

            parsedValue = parseSettingValue(descriptor, key, value);
          }

          const result = await requestCompatiblePluginSettings(
            { baseUrl: getUrl(), fetch: cliFetch },
            { pluginId: id, method: "PUT", values: { [key]: parsedValue } },
          );

          if (outputMutationJson(opts, result)) return;

          if (!result.ok) exitWithError(result);
          printSettings(result);
        },
      ),
    );

  plugin
    .command("token <id>")
    .description(
      'Print the plugin\'s HTTP token (for routes registered with auth: "token")',
    )
    .option("--rotate", "Generate a new token, invalidating the old one")
    .option("--json", "Output JSON")
    .action(
      action(
        async (id: string, opts: JsonOutputOptions & { rotate?: boolean }) => {
          const result = pluginTokenResultSchema.parse(
            await callPlugins(
              getUrl(),
              `/${encodeURIComponent(id)}/token`,
              "POST",
              opts.rotate ? { rotate: true } : {},
            ),
          );

          if (outputMutationJson(opts, result)) return;

          if (!result.ok || !result.token) exitWithError(result);
          console.log(result.token);
        },
      ),
    );

  plugin
    .command("run <id> [args...]")
    .description(
      "Run a plugin's CLI command (explicit form of `omnyo <command> ...`)",
    )
    .passThroughOptions()
    .allowUnknownOption()
    .helpOption(false)
    .action(
      action(async (id: string, args: string[]) => {
        process.exit(await runPluginCliCommand(getUrl(), id, args ?? []));
      }),
    );

  plugin
    .command("logs <id>")
    .description("Print a plugin's log (api.log output)")
    .option("-n, --lines <count>", "Number of lines to show", "100")
    .option("-f, --follow", "Poll for new lines every second (Ctrl+C to stop)")
    .action(
      action(async (id: string, opts: { lines: string; follow?: boolean }) => {
        const requested = Number.parseInt(opts.lines, 10);

        const tail =
          Number.isFinite(requested) && requested > 0 ? requested : 100;

        const fetchTail = async (count: number): Promise<string[]> => {
          const result = pluginLogsResultSchema.parse(
            await callPlugins(
              getUrl(),
              `/${encodeURIComponent(id)}/logs?tail=${count}`,
              "GET",
            ),
          );

          if (!result.ok || !result.lines) exitWithError(result);

          return result.lines;
        };

        let lines = await fetchTail(tail);

        for (const line of lines) console.log(line);

        if (!opts.follow) return;

        for (;;) {
          await sleep(1000);
          const next = await fetchTail(1000);
          const lastPrinted = lines.at(-1);

          const startAfter =
            lastPrinted === undefined ? -1 : next.lastIndexOf(lastPrinted);

          for (const line of next.slice(startAfter + 1)) console.log(line);
          lines = next;
        }
      }),
    );

  plugin
    .command("remove <id>")
    .alias("uninstall")
    .description(
      "Remove an installed plugin and delete its settings, secrets, and schedules (git:/npm: managed files are deleted; local path sources stay on disk). Included plugins from Omnyo's plugin collection can be removed and reinstalled from Omnyo Official with `omnyo plugin install <name>`; core plugins can only be disabled. To move a local plugin to another directory, install the new path instead",
    )
    .option("--json", "Output JSON")
    .addOption(new Option("--yes").hideHelp())
    .action(
      action(async (id: string, opts: JsonOutputOptions) => {
        const result = pluginMutationResponseSchema.parse(
          await callPlugins(getUrl(), `/${encodeURIComponent(id)}`, "DELETE"),
        );

        if (outputMutationJson(opts, result)) return;

        if (!result.ok) exitWithError(result);
        console.log(`Removed ${id}.`);
      }),
    );
}
