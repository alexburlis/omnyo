import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

const sourceRoot = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../../../", import.meta.url)),
);

const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const sdkEntry = import.meta.resolve("@omnyo/plugin-sdk");

const installedSdk = JSON.parse(await readFile(new URL("../package.json", sdkEntry), "utf8"));

assert.equal(installedSdk.version, manifest.devDependencies["@omnyo/plugin-sdk"]);

assert.equal(manifest.private, true);

assert.equal(manifest.engines.node, ">=22.19 <23");

assert.equal(manifest.omnyo.server, "./server.ts");

assert.equal(manifest.omnyo.host, "./host.ts");

assert.equal(manifest.omnyo.app, "./app.tsx");

assert.equal(
  await lstat(resolve(root, ".git")).then(
    () => true,
    () => false,
  ),
  false,
);

const contracts = [
  [
    "packages/plugin-sdk/src/backend-contract.ts",
    [
      "export interface PluginAgentToolContext",
      "threadId: string",
      "projectId: string",
      "experimental_client<",
    ],
  ],
  [
    "packages/plugin-sdk/src/host-contract.ts",
    [
      "readonly hostId: string",
      "readonly signal?: AbortSignal",
      "call<MethodName extends keyof Contract & string>",
    ],
  ],
  ["packages/plugin-sdk/src/cli-spec.ts", ["stdin?: boolean", "export function defineCli"]],
  ["packages/sdk/src/areas/threads.ts", ["get(args: ThreadGetArgs)"]],
  ["packages/sdk/src/areas/environments.ts", ["get(args: EnvironmentGetArgs)"]],
  ["packages/sdk/src/areas/hosts.ts", ["get(args: HostGetArgs)"]],
  ["packages/sdk/src/areas/projects.ts", ["get(args: ProjectGetArgs)"]],
  ["packages/domain/src/environment.ts", ["hostId: z.string()", "path: z.string().nullable()"]],
  [
    "apps/cli/src/plugin-cli-proxy.ts",
    [
      "value.length === 0 || /[\\r\\n]/u.test(value)",
      "input exceeds 16 KiB",
      "PLUGIN_CLI_STDIN_FLAG",
    ],
  ],
];

const evidence = [];

for (const [relativePath, snippets] of contracts) {
  const source = await readFile(resolve(sourceRoot, relativePath), "utf8");

  for (const snippet of snippets)
    assert.ok(source.includes(snippet), `${relativePath}: missing ${snippet}`);
  evidence.push({ path: relativePath, sha256: createHash("sha256").update(source).digest("hex") });
}

for (const file of ["contracts.ts", "routing.ts"]) {
  const source = await readFile(resolve(root, file), "utf8");
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:fastloop\/src|\/omnyo\/|openai|playwright)[^"']*["']/,
  );
}

const started = performance.now();

const checked = [];

for (const args of [
  ["run", "typecheck"],
  ["run", "lint"],
  ["run", "format:check"],
  ["test", "--", "tests/routing.test.ts"],
]) {
  const timeout = Math.max(1, 14000 - Math.ceil(performance.now() - started));
  execFileSync("pnpm", args, { cwd: root, timeout, maxBuffer: 262144, stdio: "pipe" });
  checked.push(["pnpm", ...args].join(" "));
}

process.stdout.write(
  JSON.stringify({
    surface: "source SDK and routing verification",
    sdkVersion: installedSdk.version,
    verificationNode: process.versions.node,
    targetNode: "22",
    runtimePreparation: "not performed by this command",
    installsRuntime: false,
    commands: checked,
    sourceEvidence: evidence,
  }) + "\n",
);
