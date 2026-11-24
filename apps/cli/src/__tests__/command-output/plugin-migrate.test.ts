import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_SDK_VERSION } from "@omnyo/domain";
import {
  resolvePrivateSdkArtifact,
  setPluginSdkPin,
} from "@omnyo/templates/plugin-scaffold";
import {
  collectLogPayloads,
  readlineMocks,
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";
import { installFakeNpm } from "../helpers/fake-npm.js";
import { registerPluginCommands } from "../../commands/plugin.js";

const register = (program: Parameters<typeof registerPluginCommands>[0]) => {
  registerPluginCommands(program, () => "http://server");
};

setupCommandOutputTestEnvironment();

const SDK_ARTIFACT = await resolvePrivateSdkArtifact({
  sourceUrl: import.meta.url,
});

const SDK_PIN = `file:./vendor/${SDK_ARTIFACT.file}`;

const PLUGIN_METADATA = {
  name: "Fixture plugin",
  description: "Plugin SDK layout fixture.",
  branding: { icon: "Zap" },
  server: "./server.ts",
};

let rootDir: string;

let toolsDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "omnyo-cli-migrate-"));
  toolsDir = await mkdtemp(join(tmpdir(), "omnyo-cli-migrate-tools-"));
  await installFakeNpm(toolsDir);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await rm(toolsDir, { recursive: true, force: true });
});

async function writeManifest(value: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function writeVendoredPlugin(): Promise<void> {
  await writeManifest({
    name: "bb-plugin-legacy",
    version: "0.1.0",
    engines: { bbPluginSdk: ">=0.2.0" },
    bb: {
      name: "Legacy plugin",
      description: "Legacy SDK layout fixture.",
      branding: { icon: "Zap" },
      server: "./server.ts",
    },
    devDependencies: { typescript: "^5.7.0" },
  });
  await writeFile(
    join(rootDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          paths: { "@get-bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"] },
        },
        include: ["server.ts", "types"],
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(rootDir, "types"), { recursive: true });
  await writeFile(join(rootDir, "types", "bb-plugin-sdk.d.ts"), "// old\n");
}

async function readManifest(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    await readFile(join(rootDir, "package.json"), "utf8"),
  );

  return parsed as Record<string, unknown>;
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
}

describe("omnyo plugin migrate", () => {
  it("prints the plan and changes nothing without --yes on a non-TTY", async () => {
    await writeVendoredPlugin();
    setTty(false);
    const before = await readFile(join(rootDir, "package.json"), "utf8");
    const logSpy = vi.mocked(console.log);

    await expect(
      runCommand(["plugin", "migrate", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    const logged = collectLogPayloads(logSpy).join("\n");
    expect(logged).toContain(`"@omnyo/plugin-sdk": (none) → ${SDK_PIN}`);
    expect(logged).toContain(
      "preserve       types/bb-plugin-sdk.d.ts → vendor/legacy-plugin-sdk-v1/",
    );
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Re-run with --yes to apply the displayed migration.",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(
      await stat(join(rootDir, "types", "bb-plugin-sdk.d.ts")).then(() => true),
    ).toBe(true);
  });

  it("migrates with --yes, preserves declarations and reports the private follow-up install", async () => {
    await writeVendoredPlugin();
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)["@omnyo/plugin-sdk"],
    ).toBe(SDK_PIN);
    await expect(
      stat(join(rootDir, "types", "bb-plugin-sdk.d.ts")),
    ).rejects.toThrow();
    expect(
      await readFile(
        join(rootDir, "vendor", "legacy-plugin-sdk-v1", "bb-plugin-sdk.d.ts"),
        "utf8",
      ),
    ).toBe("// old\n");
    expect(await readFile(join(rootDir, "vendor", SDK_ARTIFACT.file))).toEqual(
      await readFile(SDK_ARTIFACT.artifactPath),
    );
    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain(
      "Migrated to the private Omnyo SDK. Original declaration bytes are retained in vendor/legacy-plugin-sdk-v1/.",
    );
    expect(logged).toContain("Run `pnpm install`");
  });

  it("plans and applies the pre-rename import rewrite", async () => {
    await writeVendoredPlugin();
    await writeFile(
      join(rootDir, "server.ts"),
      'import type { BbPluginApi } from "@bb/plugin-sdk";\nimport "@bb/plugin-sdk/testing";\n',
    );
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain(
      'rewrite        server.ts (3 SDK import/member updates to "@omnyo/plugin-sdk")',
    );
    expect(await readFile(join(rootDir, "server.ts"), "utf8")).toBe(
      'import type { PluginApi as BbPluginApi } from "@omnyo/plugin-sdk";\nimport "@omnyo/plugin-sdk/testing";\n',
    );
  });

  it("reports an already-migrated plugin without touching it", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      engines: { omnyoPluginSdk: `>=${PLUGIN_SDK_VERSION}` },
      omnyo: PLUGIN_METADATA,
      devDependencies: { "@omnyo/plugin-sdk": SDK_PIN },
    });
    await setPluginSdkPin({ rootDir, sdkArtifact: SDK_ARTIFACT });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await runCommand(["plugin", "migrate", rootDir], register);

    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      "already uses the selected private Omnyo SDK",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
  });

  it("migrates a public same-version package instead of treating legacy metadata as current", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      engines: { bbPluginSdk: `>=${PLUGIN_SDK_VERSION}` },
      bb: PLUGIN_METADATA,
      devDependencies: { "@get-bb/plugin-sdk": PLUGIN_SDK_VERSION },
    });
    const legacy = await readFile(join(rootDir, "package.json"));
    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);
    expect(await readFile(join(rootDir, "package.json"))).not.toEqual(legacy);
    const manifest = await readManifest();
    expect(manifest.bb).toBeUndefined();
    expect(manifest.omnyo).toEqual(PLUGIN_METADATA);
    expect(
      (manifest.devDependencies as Record<string, string>)["@omnyo/plugin-sdk"],
    ).toBe(SDK_PIN);
    expect(await readFile(join(rootDir, "vendor", SDK_ARTIFACT.file))).toEqual(
      await readFile(SDK_ARTIFACT.artifactPath),
    );
  });

  it("pins a package-layout plugin that never got the devDependency", async () => {
    await writeManifest({
      name: "bb-plugin-pinless",
      version: "0.1.0",
      bb: PLUGIN_METADATA,
      devDependencies: { typescript: "^5.7.0" },
    });
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)["@omnyo/plugin-sdk"],
    ).toBe(SDK_PIN);
    expect((manifest.engines as Record<string, string>).omnyoPluginSdk).toBe(
      `>=${PLUGIN_SDK_VERSION}`,
    );
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).not.toContain(
      "already uses the selected private Omnyo SDK",
    );
  });

  it("aborts when the plugin changes between the plan and the confirmation", async () => {
    await writeVendoredPlugin();
    setTty(true);
    readlineMocks.question.mockImplementation(async () => {
      await writeFile(
        join(rootDir, "types", "bb-plugin-sdk-app.d.ts"),
        "// appeared mid-prompt\n",
      );

      return "y";
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await expect(
      runCommand(["plugin", "migrate", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "changed while awaiting confirmation",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(
      await stat(join(rootDir, "types", "bb-plugin-sdk.d.ts")).then(() => true),
    ).toBe(true);
  });
});

describe("private plugin SDK digest checks", () => {
  it("refuses a public exact pin without changing the legacy manifest", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      bb: PLUGIN_METADATA,
      devDependencies: { "@omnyo/plugin-sdk": "0.2.0" },
    });
    const before = await readFile(join(rootDir, "package.json"));

    await expect(
      runCommand(["plugin", "types", rootDir, "--check"], register),
    ).rejects.toThrow("process.exit:1");
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Plugin SDK bytes or declarations differ from this runtime.",
    );
    expect(await readFile(join(rootDir, "package.json"))).toEqual(before);
    await expect(stat(join(rootDir, "vendor"))).rejects.toThrow();
  });

  it("refuses a public same-version pin without mistaking it for verified private bytes", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      bb: PLUGIN_METADATA,
      devDependencies: { "@omnyo/plugin-sdk": PLUGIN_SDK_VERSION },
    });
    const before = await readFile(join(rootDir, "package.json"));
    await expect(
      runCommand(["plugin", "types", rootDir, "--check"], register),
    ).rejects.toThrow("process.exit:1");
    expect(await readFile(join(rootDir, "package.json"))).toEqual(before);
    await expect(stat(join(rootDir, "vendor"))).rejects.toThrow();
  });

  it("accepts a matching digest but refuses a public range without writing", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      omnyo: PLUGIN_METADATA,
      devDependencies: { "@omnyo/plugin-sdk": SDK_PIN },
    });
    await setPluginSdkPin({ rootDir, sdkArtifact: SDK_ARTIFACT });
    const current = await readFile(join(rootDir, "package.json"));
    const archive = await readFile(join(rootDir, "vendor", SDK_ARTIFACT.file));
    await runCommand(["plugin", "types", rootDir, "--check"], register);
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      `Private @omnyo/plugin-sdk ${PLUGIN_SDK_VERSION} is current.`,
    );
    expect(await readFile(join(rootDir, "package.json"))).toEqual(current);
    expect(await readFile(join(rootDir, "vendor", SDK_ARTIFACT.file))).toEqual(
      archive,
    );

    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      bb: PLUGIN_METADATA,
      devDependencies: { "@omnyo/plugin-sdk": "^0.2.0" },
    });
    const range = await readFile(join(rootDir, "package.json"));
    await expect(
      runCommand(["plugin", "types", rootDir, "--check"], register),
    ).rejects.toThrow("process.exit:1");
    expect(await readFile(join(rootDir, "package.json"))).toEqual(range);
    expect(await readFile(join(rootDir, "vendor", SDK_ARTIFACT.file))).toEqual(
      archive,
    );
  });
});

describe("legacy vendored SDK layout", () => {
  const message =
    "This plugin uses the legacy vendored SDK layout. Its SDK types will not be updated.\n" +
    "Please run `omnyo plugin migrate` to update to the latest SDK types.";

  it.each([false, true])(
    "requires migration for bb plugin types with check=%s",
    async (check) => {
      await writeVendoredPlugin();
      const declarationsPath = join(rootDir, "types", "bb-plugin-sdk.d.ts");
      const before = await readFile(declarationsPath, "utf8");

      await expect(
        runCommand(
          ["plugin", "types", rootDir, ...(check ? ["--check"] : [])],
          register,
        ),
      ).rejects.toThrow("process.exit:1");

      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        `Error: ${message}`,
      );
      expect(await readFile(declarationsPath, "utf8")).toBe(before);
    },
  );

  it("requires migration for a legacy package identity without vendored declarations", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      bb: PLUGIN_METADATA,
      devDependencies: { "@get-bb/plugin-sdk": "0.2.0" },
    });
    const before = await readFile(join(rootDir, "package.json"));

    await expect(
      runCommand(["plugin", "types", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.error)).toHaveBeenCalledWith(`Error: ${message}`);
    expect(await readFile(join(rootDir, "package.json"))).toEqual(before);
    await expect(stat(join(rootDir, "vendor"))).rejects.toThrow();
  });

  it("warns and continues omnyo plugin dev", async () => {
    await writeVendoredPlugin();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ plugins: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      runCommand(["plugin", "dev", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(message);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "This directory is not installed as a plugin",
    );
  });

  it("warns and continues omnyo plugin build", async () => {
    await writeVendoredPlugin();
    await writeFile(join(rootDir, "server.ts"), "export default () => {};\n");

    await runCommand(["plugin", "build", rootDir], register);

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(message);
    await expect(
      stat(join(rootDir, "dist", "server.js")),
    ).resolves.toBeDefined();
  });
});

describe("omnyo plugin types on a package-layout plugin", () => {
  it("repoints an outdated pin to the running host's SDK version", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      engines: { bbPluginSdk: ">=0.2.0" },
      bb: PLUGIN_METADATA,
      devDependencies: { "@omnyo/plugin-sdk": "0.2.0" },
    });

    await runCommand(["plugin", "types", rootDir], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)["@omnyo/plugin-sdk"],
    ).toBe(SDK_PIN);
    expect((manifest.engines as Record<string, string>).omnyoPluginSdk).toBe(
      ">=0.2.0",
    );
    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain(
      `Private @omnyo/plugin-sdk ${PLUGIN_SDK_VERSION} copied and pinned in vendor/.`,
    );
    expect(logged).toContain("Run `pnpm install`");
  });

  it("--check reports the mismatch and writes nothing", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      bb: PLUGIN_METADATA,
      devDependencies: { "@omnyo/plugin-sdk": "0.2.0" },
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await expect(
      runCommand(["plugin", "types", rootDir, "--check"], register),
    ).rejects.toThrow("process.exit:1");

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
  });

  it("is a no-op when the digest pin and actual archive already match", async () => {
    await writeManifest({
      name: "bb-plugin-modern",
      version: "0.1.0",
      omnyo: PLUGIN_METADATA,
      devDependencies: { "@omnyo/plugin-sdk": SDK_PIN },
    });
    await setPluginSdkPin({ rootDir, sdkArtifact: SDK_ARTIFACT });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await runCommand(["plugin", "types", rootDir], register);

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      `Private @omnyo/plugin-sdk ${PLUGIN_SDK_VERSION} copied and pinned in vendor/.`,
    );
  });
});
