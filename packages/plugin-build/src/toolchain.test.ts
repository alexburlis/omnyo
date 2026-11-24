import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  symlink,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPluginApp } from "./build-plugin-app.js";
import {
  PLUGIN_TOOLCHAIN_PINS,
  resolvePluginBuildToolchain,
  toolchainCacheDir,
} from "./toolchain.js";

describe("plugin build toolchain", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "omnyo-toolchain-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("keys the cache directory on the pinned versions", () => {
    const dir = toolchainCacheDir("/data");

    for (const version of Object.values(PLUGIN_TOOLCHAIN_PINS)) {
      expect(basename(dir)).toContain(version);
    }

    expect(dir.startsWith(`${join("/data")}${sep}`)).toBe(true);
  });

  it("prefers a locally resolvable toolchain over fetching", async () => {
    const toolchain = await resolvePluginBuildToolchain(baseDir, {
      onFetchStart: () => {
        throw new Error("fetched despite a locally resolvable toolchain");
      },
    });

    expect(toolchain.esbuild).toMatch(/^file:\/\//);
    expect(toolchain.esbuild).toContain("esbuild");
    expect(toolchain.tailwindNode).toContain("@tailwindcss/node");
    expect(toolchain.tailwindOxide).toContain("@tailwindcss/oxide");
    expect(
      await rm(toolchainCacheDir(baseDir), { recursive: true }).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  function localPackages(
    local: Awaited<ReturnType<typeof resolvePluginBuildToolchain>>,
  ) {
    return {
      esbuild: dirname(dirname(fileURLToPath(local.esbuild))),
      "@tailwindcss/node": dirname(dirname(fileURLToPath(local.tailwindNode))),
      "@tailwindcss/oxide": dirname(fileURLToPath(local.tailwindOxide)),
      tailwindcss: local.tailwindCssDir,
    };
  }

  async function cachedToolchain(marker: string, raw?: string) {
    const dir = toolchainCacheDir(baseDir);
    await mkdir(join(dir, "node_modules"), { recursive: true });
    const local = await resolvePluginBuildToolchain(baseDir);
    const packages = localPackages(local);
    await Promise.all(
      Object.entries(packages).map(async ([name, source]) => {
        const target = join(dir, "node_modules", name);
        await mkdir(dirname(target), { recursive: true });
        await symlink(
          source,
          target,
          process.platform === "win32" ? "junction" : "dir",
        );
      }),
    );

    const payload =
      raw ??
      JSON.stringify({
        pins: Object.entries(PLUGIN_TOOLCHAIN_PINS)
          .map(([name, version]) => `${name}@${version}`)
          .sort()
          .join(","),
      });

    await writeFile(join(dir, marker), payload);

    return { dir, payload, local };
  }

  it("reads a finite cached canonical marker without mutating bytes or fetching", async () => {
    const marker = ".omnyo-toolchain.json";
    const { dir, payload, local } = await cachedToolchain(marker);
    const before = await stat(join(dir, marker));

    const toolchain = await resolvePluginBuildToolchain(baseDir, {
      ignoreLocal: true,
      onFetchStart: () => {
        throw new Error("unexpected tool fetch");
      },
    });

    expect(toolchain).toEqual(local);
    expect(await readFile(join(dir, marker), "utf8")).toBe(payload);
    expect((await stat(join(dir, marker))).ino).toBe(before.ino);
  });

  it("adopts a legacy marker in place without fetching", async () => {
    const { dir, payload, local } = await cachedToolchain(".bb-toolchain.json");
    const before = await stat(join(dir, ".bb-toolchain.json"));

    const resolve = () =>
      resolvePluginBuildToolchain(baseDir, {
        ignoreLocal: true,
        onFetchStart: () => {
          throw new Error("unexpected tool fetch");
        },
      });

    expect(await resolve()).toEqual(local);
    expect(await readFile(join(dir, ".omnyo-toolchain.json"), "utf8")).toBe(
      payload,
    );
    expect((await stat(join(dir, ".omnyo-toolchain.json"))).ino).toBe(
      before.ino,
    );
    await expect(
      readFile(join(dir, ".bb-toolchain.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await resolve()).toEqual(local);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a valid legacy cache usable when the marker cannot be renamed",
    async () => {
      const { dir, payload, local } =
        await cachedToolchain(".bb-toolchain.json");

      await chmod(dir, 0o555);

      try {
        await expect(
          resolvePluginBuildToolchain(baseDir, {
            ignoreLocal: true,
            onFetchStart: () => {
              throw new Error("unexpected tool fetch");
            },
          }),
        ).resolves.toEqual(local);
      } finally {
        await chmod(dir, 0o755);
      }

      expect(await readFile(join(dir, ".bb-toolchain.json"), "utf8")).toBe(
        payload,
      );
    },
  );

  it("keeps concurrent resolvers on the cache while a legacy marker is adopted", async () => {
    const { dir, payload, local } = await cachedToolchain(".bb-toolchain.json");

    const pending: ReturnType<typeof resolvePluginBuildToolchain>[] = [];

    for (let started = 0; started < 400; started += 1) {
      pending.push(
        resolvePluginBuildToolchain(baseDir, {
          ignoreLocal: true,
          onFetchStart: () => {
            throw new Error("unexpected tool fetch");
          },
        }),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }

    const results = await Promise.all(pending);

    expect(results).toEqual(results.map(() => local));
    expect(await readFile(join(dir, ".omnyo-toolchain.json"), "utf8")).toBe(
      payload,
    );
  });

  it.each(["equal", "different"])(
    "refuses %s dual cache markers before fetching",
    async (kind) => {
      const { dir, payload } = await cachedToolchain(".bb-toolchain.json");

      const canonical =
        kind === "equal" ? payload : JSON.stringify({ pins: "foreign" });

      await writeFile(join(dir, ".omnyo-toolchain.json"), canonical);
      let fetches = 0;
      await expect(
        resolvePluginBuildToolchain(baseDir, {
          ignoreLocal: true,
          onFetchStart: () => {
            fetches += 1;
            throw new Error("unexpected tool fetch");
          },
        }),
      ).rejects.toThrow(/both.*toolchain.*markers/);
      expect(fetches).toBe(0);
      expect(await readFile(join(dir, ".bb-toolchain.json"), "utf8")).toBe(
        payload,
      );
      expect(await readFile(join(dir, ".omnyo-toolchain.json"), "utf8")).toBe(
        canonical,
      );
    },
  );

  it("refuses a malformed legacy marker before fetching", async () => {
    const { dir } = await cachedToolchain(".bb-toolchain.json", "{invalid");
    let fetches = 0;
    await expect(
      resolvePluginBuildToolchain(baseDir, {
        ignoreLocal: true,
        onFetchStart: () => {
          fetches += 1;
          throw new Error("unexpected tool fetch");
        },
      }),
    ).rejects.toThrow(/invalid.*toolchain.*marker/);
    expect(fetches).toBe(0);
    expect(await readFile(join(dir, ".bb-toolchain.json"), "utf8")).toBe(
      "{invalid",
    );
  });

  it.skipIf(process.platform === "win32")(
    "emits only canonical fresh marker and staging package without fetching packages",
    async () => {
      const local = await resolvePluginBuildToolchain(baseDir);
      const capture = join(baseDir, "staged-package.json");
      const preload = join(baseDir, "local-pinned-installer.mjs");
      await writeFile(
        preload,
        [
          'import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";',
          'import { dirname, join } from "node:path";',
          'const prefix = process.argv[process.argv.indexOf("--prefix") + 1];',
          `writeFileSync(${JSON.stringify(capture)}, readFileSync(join(prefix, "package.json")));`,
          `for (const [name, source] of Object.entries(${JSON.stringify(localPackages(local))})) { const target = join(prefix, "node_modules", name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(source, target, "dir"); }`,
          "process.exit(0);",
        ].join("\n"),
      );
      const previous = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
      let fetches = 0;

      try {
        await resolvePluginBuildToolchain(baseDir, {
          ignoreLocal: true,
          onFetchStart: () => {
            fetches += 1;
          },
        });
      } finally {
        if (previous === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previous;
      }

      expect(fetches).toBe(1);
      expect(JSON.parse(await readFile(capture, "utf8"))).toMatchObject({
        name: "omnyo-plugin-toolchain",
        private: true,
      });
      const dir = toolchainCacheDir(baseDir);
      expect(
        JSON.parse(await readFile(join(dir, ".omnyo-toolchain.json"), "utf8")),
      ).toEqual({
        pins: Object.entries(PLUGIN_TOOLCHAIN_PINS)
          .map(([name, version]) => `${name}@${version}`)
          .sort()
          .join(","),
      });
      await expect(
        readFile(join(dir, ".bb-toolchain.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  describe("fetched toolchain", () => {
    it.runIf(process.env.OMNYO_TEST_TOOLCHAIN_FETCH === "1")(
      "builds a plugin frontend with nothing resolvable locally",
      async () => {
        const fetchEvents: string[] = [];

        const toolchain = await resolvePluginBuildToolchain(baseDir, {
          ignoreLocal: true,
          onFetchStart: () => fetchEvents.push("start"),
          onFetchDone: (ms) => fetchEvents.push(`done:${ms > 0}`),
        });

        expect(fetchEvents).toEqual(["start", "done:true"]);

        expect(toolchain.esbuild).toContain("toolchain-");
        expect(toolchain.tailwindCssDir).toContain("toolchain-");

        const pluginDir = join(baseDir, "plugin");
        await mkdir(pluginDir, { recursive: true });
        await writeFile(
          join(pluginDir, "package.json"),
          JSON.stringify({
            name: "omnyo-plugin-fetched",
            version: "0.1.0",
            omnyo: {
              name: "Fetched",
              description: "Fetched toolchain fixture.",
              branding: { icon: "Zap" },
              server: "./server.ts",
              app: "./app.tsx",
            },
          }),
        );
        await writeFile(
          join(pluginDir, "server.ts"),
          "export default function plugin() {}",
        );
        await writeFile(
          join(pluginDir, "app.tsx"),
          `import { definePluginApp } from "@omnyo/plugin-sdk/app";\n` +
            `export default definePluginApp({});\n`,
        );

        const result = await buildPluginApp(pluginDir, "0.9.0-test", toolchain);
        const css = await readFile(result.cssPath, "utf8");

        expect(css.length).toBeGreaterThan(0);
        expect(css).toContain("--");
      },
      600_000,
    );

    it.skipIf(process.platform === "win32")(
      "fetches with the shipped npm and excludes script-policy config without PATH executables",
      async () => {
        const envDump = join(baseDir, "npm-env.txt");
        const preload = join(baseDir, "capture-npm-env.mjs");
        await writeFile(
          preload,
          [
            'import { writeFileSync } from "node:fs";',
            `writeFileSync(${JSON.stringify(envDump)}, ["PATH", "NODE_OPTIONS", "npm_config_allow_scripts", "NPM_CONFIG_IGNORE_SCRIPTS", "npm_config_registry"].filter(key => process.env[key] !== undefined).map(key => key + "=" + process.env[key]).join("\\n"));`,
            "process.exit(0);",
          ].join("\n"),
        );

        const overrides: Record<string, string> = {
          PATH: baseDir,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          npm_config_allow_scripts: "@github/keytar,node-pty",
          NPM_CONFIG_IGNORE_SCRIPTS: "false",
          npm_config_registry: "https://registry.example.invalid/",
        };

        const previous = new Map<string, string | undefined>();

        for (const [key, value] of Object.entries(overrides)) {
          previous.set(key, process.env[key]);
          process.env[key] = value;
        }

        try {
          await expect(
            resolvePluginBuildToolchain(baseDir, { ignoreLocal: true }),
          ).rejects.toThrow(/incomplete or misversioned/);
        } finally {
          for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }

        const seen = new Map(
          (await readFile(envDump, "utf8"))
            .split("\n")
            .filter((line) => line.includes("="))
            .map((line) => {
              const at = line.indexOf("=");

              return [line.slice(0, at), line.slice(at + 1)] as const;
            }),
        );

        expect(seen.has("npm_config_allow_scripts")).toBe(false);
        expect(seen.has("NPM_CONFIG_IGNORE_SCRIPTS")).toBe(false);
        expect(seen.get("npm_config_registry")).toBe(
          "https://registry.example.invalid/",
        );
      },
    );
  });
});
