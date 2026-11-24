import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrivateSdkArtifact } from "@omnyo/templates/plugin-scaffold";
import { RESERVED_CORE_CLI_COMMANDS } from "@omnyo/domain/plugin-cli";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerPluginCommands,
  resolveNewPluginTarget,
} from "../commands/plugin.js";
import { installFakeNpm } from "./helpers/fake-npm.js";

describe("resolveNewPluginTarget", () => {
  it.each([
    ["hello", "omnyo-plugin-hello", "omnyo-plugin-hello"],
    ["omnyo-plugin-hello", "omnyo-plugin-hello", "omnyo-plugin-hello"],
    [
      "@acme/omnyo-plugin-hello",
      "@acme/omnyo-plugin-hello",
      "omnyo-plugin-hello",
    ],
  ])("resolves %s", (name, expectedPackageName, expectedDirectoryName) => {
    expect(resolveNewPluginTarget(name)).toEqual({
      packageName: expectedPackageName,
      directoryName: expectedDirectoryName,
    });
  });

  it.each([
    "Hello",
    "omnyo-plugin-",
    "@acme/hello",
    "@acme/omnyo-plugin-Hello",
    "@acme/team/omnyo-plugin-hello",
  ])("rejects %s", (name) => {
    expect(resolveNewPluginTarget(name)).toBeNull();
  });

  it.each(RESERVED_CORE_CLI_COMMANDS)("rejects reserved id %s", (id) => {
    expect(resolveNewPluginTarget(id)).toBeNull();
    expect(resolveNewPluginTarget(`omnyo-plugin-${id}`)).toBeNull();
    expect(resolveNewPluginTarget(`@acme/omnyo-plugin-${id}`)).toBeNull();
  });
});

describe.sequential("omnyo plugin new dependency install", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let logged: string[];
  let warned: string[];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "omnyo-plugin-new-"));
    process.chdir(workDir);
    await installFakeNpm(workDir);
    vi.stubEnv("NODE_ENV", "production");
    logged = [];
    warned = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warned.push(String(line));
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  async function runPluginNew(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerPluginCommands(program, () => "http://localhost");
    await program.parseAsync(["node", "omnyo", "plugin", "new", ...args]);
  }

  async function isInstalled(
    directoryName: string,
    packageName: string,
  ): Promise<boolean> {
    return stat(join(workDir, directoryName, "node_modules", packageName))
      .then(() => true)
      .catch(() => false);
  }

  it("installs the packages the plugin needs to build under NODE_ENV=production", async () => {
    await runPluginNew(["prod-env"]);

    expect(await isInstalled("omnyo-plugin-prod-env", "zod")).toBe(true);
    expect(await isInstalled("omnyo-plugin-prod-env", "typescript")).toBe(true);
    expect(await isInstalled("omnyo-plugin-prod-env", "clsx")).toBe(true);
    expect(warned).toEqual([]);
    expect(logged).toContain("Installed dependencies (npm install).");
    expect(logged).not.toContain("  npm install --include=dev");
  });

  it("accepts a tree npm hoisted to a workspace root", async () => {
    await writeFile(
      join(workDir, "package.json"),
      JSON.stringify({ name: "host", private: true, workspaces: ["*"] }),
    );
    vi.stubEnv("OMNYO_TEST_NPM_HOIST_TO", workDir);

    await runPluginNew(["hoisted"]);

    expect(await isInstalled("omnyo-plugin-hoisted", "zod")).toBe(false);
    expect(warned).toEqual([]);
    expect(logged).toContain("Installed dependencies (npm install).");
  });

  it("does not report success when npm exits 0 without installing the tree", async () => {
    vi.stubEnv("OMNYO_TEST_NPM_ALWAYS_OMIT_DEV", "1");

    await runPluginNew(["silent-omit"]);

    expect(await isInstalled("omnyo-plugin-silent-omit", "typescript")).toBe(
      false,
    );
    expect(logged).not.toContain("Installed dependencies (npm install).");
    expect(warned.join("\n")).toMatch(
      /npm install reported success but .*\btypescript\b.* missing from node_modules/,
    );
    expect(logged).toContain("  npm install --include=dev");
  });

  it("pins and copies the selected private SDK archive", async () => {
    const artifact = await resolvePrivateSdkArtifact({
      sourceUrl: import.meta.url,
    });

    await runPluginNew(["pinned"]);

    const manifest: { devDependencies: Record<string, string> } = JSON.parse(
      await readFile(
        join(workDir, "omnyo-plugin-pinned", "package.json"),
        "utf8",
      ),
    );

    expect(manifest.devDependencies["@omnyo/plugin-sdk"]).toBe(
      `file:./vendor/${artifact.file}`,
    );
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBeUndefined();
    expect(
      await readFile(
        join(workDir, "omnyo-plugin-pinned", "vendor", artifact.file),
      ),
    ).toEqual(await readFile(artifact.artifactPath));
    expect(await isInstalled("omnyo-plugin-pinned", "@omnyo/plugin-sdk")).toBe(
      true,
    );
    expect(warned).toEqual([]);
  });

  it("creates from the private artifact without querying a public SDK registry", async () => {
    const marker = join(workDir, "unexpected-registry-query");
    vi.stubEnv("OMNYO_TEST_NPM_VIEW_MARKER", marker);
    await runPluginNew(["local-sdk"]);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(logged).toContain(
      "Created omnyo-plugin-local-sdk/ (omnyo-plugin-local-sdk).",
    );
    expect(warned).toEqual([]);
  });

  it("passes npm's own reason through when the install fails", async () => {
    vi.stubEnv("OMNYO_TEST_NPM_INSTALL", "fail");

    await runPluginNew(["npm-broken"]);

    const warnings = warned.join("\n");
    expect(warnings).toContain("Could not run npm install");
    expect(warnings).toContain("npm error code EPERM");
    expect(warnings).toContain("Your cache folder contains root-owned files");
  });

  it("keeps stderr details when a failed install also writes stdout", async () => {
    vi.stubEnv("OMNYO_TEST_NPM_INSTALL", "fail-noisy-stdout");

    await runPluginNew(["npm-noisy"]);

    const warnings = warned.join("\n");
    expect(warnings).toContain("npm error code EPERM");
    expect(warnings).not.toContain("progress line");
  });

  it("falls back to the manual step when npm is not on PATH", async () => {
    vi.stubEnv("PATH", join(workDir, "empty-bin"));

    await runPluginNew(["no-npm"]);

    expect(warned.join("\n")).toContain("Could not run npm install");
    expect(logged).toContain("  npm install --include=dev");
  });
});
