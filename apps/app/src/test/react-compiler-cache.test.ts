import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import * as cacache from "cacache";
import { build, createServer } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import {
  compilerCacheNamespace,
  cachedReactCompiler,
  compilerTransformKey,
  containsWorktreePath,
} from "../../vite-react-compiler.js";

const workspace = fileURLToPath(new URL("../../../../", import.meta.url));

afterEach(() => vi.unstubAllEnvs());

it("reuses exact compiler output and maps, invalidates inputs, and repairs corrupt entries", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ENABLE_REACT_COMPILER_TIMINGS", undefined);
  const temporary = resolve(workspace, ".tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(resolve(temporary, "react-compiler-test-"));
  const directory = resolve(root, "cache");
  const input = resolve(root, "component.tsx");
  const configFile = resolve(root, "vite.config.mjs");
  const configDependency = resolve(root, "compiler-config.mjs");

  const source =
    "export function Component({ name }: { name: string }) { return <div>Hello {name}</div>; }";

  try {
    await writeFile(input, source);
    await writeFile(configDependency, 'export default "first";');
    await writeFile(
      configFile,
      'import label from "./compiler-config.mjs"; export default { define: { BUILD_LABEL: JSON.stringify(label) } };',
    );

    async function compile() {
      const compiler = await cachedReactCompiler(directory);

      const result = await build({
        configFile,
        root,
        logLevel: "silent",
        plugins: [react(), compiler],
        build: {
          write: false,
          minify: false,
          sourcemap: true,
          rolldownOptions: {
            input,
            external: [/^react\//],
            preserveEntrySignatures: "strict",
          },
        },
      });

      if (Array.isArray(result) || !("output" in result))
        throw new Error("Expected one build output");

      return {
        output: result.output.map((item) =>
          item.type === "chunk"
            ? { code: item.code, map: item.map?.toString() }
            : { source: item.source, fileName: item.fileName },
        ),
        stats: compiler.api.compilerCache,
      };
    }

    const cold = await compile();
    expect(cold.stats.misses).toBeGreaterThan(0);
    expect(cold.stats.hits).toBe(0);
    expect(JSON.stringify(cold.output)).toContain("$[0] !== name");
    const warm = await compile();
    expect(warm.stats.hits).toBe(cold.stats.misses);
    expect(warm.stats.misses).toBe(0);
    expect(warm.output).toEqual(cold.output);

    await writeFile(input, source.replace("Hello", "Welcome"));
    const edited = await compile();
    expect(edited.stats.misses).toBeGreaterThan(0);
    expect(edited.output).not.toEqual(cold.output);

    vi.stubEnv("BABEL_ENV", "cache-invalidation-test");
    expect((await compile()).stats.misses).toBeGreaterThan(0);
    const entries = await cacache.ls(directory);
    await Promise.all(
      Object.values(entries).map((entry) => writeFile(entry.path, "corrupt")),
    );
    const repaired = await compile();
    expect(repaired.stats.misses).toBeGreaterThan(0);
    expect(repaired.output).toEqual(edited.output);
    expect((await compile()).stats.misses).toBe(0);
    await writeFile(configDependency, 'export default "changed";');

    const [concurrentA, concurrentB] = await Promise.all([
      compile(),
      compile(),
    ]);

    expect(concurrentA.stats.misses + concurrentB.stats.misses).toBeGreaterThan(
      0,
    );
    expect(concurrentA.output).toEqual(concurrentB.output);
    expect((await compile()).stats.misses).toBe(0);
    await writeFile(input, "export function Component( {");
    await expect(compile()).rejects.toThrow();
    await writeFile(input, source.replace("Hello", "Welcome"));
    expect((await compile()).stats.misses).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("reuses compiler output across Vitest servers but not other dev servers", async () => {
  vi.stubEnv("ENABLE_REACT_COMPILER_TIMINGS", undefined);
  const temporary = resolve(workspace, ".tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(resolve(temporary, "react-compiler-test-"));
  const directory = resolve(root, "cache");

  await writeFile(
    resolve(root, "component.tsx"),
    "export function Component({ name }: { name: string }) { return <div>Hello {name}</div>; }",
  );

  async function transform() {
    const compiler = await cachedReactCompiler(directory);

    const server = await createServer({
      configFile: false,
      root,
      cacheDir: resolve(root, ".vite"),
      logLevel: "silent",
      appType: "custom",
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true },
      plugins: [
        react(),
        compiler,
        {
          name: "react-compiler-test-external-react",
          enforce: "pre",
          resolveId(id) {
            return /^react(?:\/|$)/.test(id)
              ? { id, external: true }
              : undefined;
          },
        },
      ],
    });

    try {
      const result =
        await server.environments.client.transformRequest("/component.tsx");

      return { code: result?.code, stats: compiler.api.compilerCache };
    } finally {
      await server.close();
    }
  }

  try {
    const cold = await transform();
    expect(cold.stats).toEqual({ hits: 0, misses: 1 });
    expect(cold.code).toContain("$[0] !== name");
    const warm = await transform();
    expect(warm.stats).toEqual({ hits: 1, misses: 0 });
    expect(warm.code).toBe(cold.code);
    vi.stubEnv("VITEST", undefined);
    expect((await transform()).stats).toEqual({ hits: 0, misses: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("compiles ordinary hooks while calling experimental SDK hooks on every render", async () => {
  vi.stubEnv("ENABLE_REACT_COMPILER_TIMINGS", undefined);
  const temporary = resolve(workspace, ".tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(resolve(temporary, "react-compiler-test-"));

  await writeFile(
    resolve(root, "sdk.ts"),
    "export function experimental_useNav() { return 'nav'; }",
  );
  await writeFile(
    resolve(root, "component.tsx"),
    `import { useState } from "react";
import { experimental_useNav } from "./sdk";
export function useThing(value: string) { const [count] = useState(0); return { count, value, read: () => value }; }
export function Component() { const nav = experimental_useNav(); return <div>{nav}</div>; }`,
  );

  const compiler = await cachedReactCompiler(resolve(root, "cache"));

  const server = await createServer({
    configFile: false,
    root,
    cacheDir: resolve(root, ".vite"),
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [
      react(),
      compiler,
      {
        name: "react-compiler-test-external-react",
        enforce: "pre",
        resolveId(id) {
          return /^react(?:\/|$)/.test(id) ? { id, external: true } : undefined;
        },
      },
    ],
  });

  try {
    const result =
      await server.environments.client.transformRequest("/component.tsx");

    const code = result?.code ?? "";
    const thing = code.slice(code.indexOf("function useThing"));
    const component = code.slice(code.indexOf("function Component"));

    expect(thing.slice(0, thing.indexOf("function Component"))).toContain(
      "_c(",
    );
    expect(component).toContain("experimental_useNav()");
    expect(
      component.slice(0, component.indexOf("experimental_useNav()")),
    ).not.toContain("memo_cache_sentinel");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("leaves components that use TanStack Virtual uncompiled", async () => {
  vi.stubEnv("ENABLE_REACT_COMPILER_TIMINGS", undefined);
  const temporary = resolve(workspace, ".tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(resolve(temporary, "react-compiler-test-"));

  await writeFile(
    resolve(root, "component.tsx"),
    `import { useVirtualizer } from "@tanstack/react-virtual";
export function Component({ count }: { count: number }) {
  const virtualizer = useVirtualizer({ count, estimateSize: () => 20, getScrollElement: () => null });
  return <div>{virtualizer.getVirtualItems().length}</div>;
}`,
  );

  const compiler = await cachedReactCompiler(resolve(root, "cache"));

  const server = await createServer({
    configFile: false,
    root,
    cacheDir: resolve(root, ".vite"),
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [
      react(),
      compiler,
      {
        name: "react-compiler-test-external-react",
        enforce: "pre",
        resolveId(id) {
          return /^(?:react(?:\/|$)|@tanstack\/react-virtual$)/.test(id)
            ? { id, external: true }
            : undefined;
        },
      },
    ],
  });

  try {
    const result =
      await server.environments.client.transformRequest("/component.tsx");

    expect(result?.code).toContain("useVirtualizer(");
    expect(result?.code).not.toContain("_c(");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("shares relative identities while separating transform inputs", () => {
  const key = compilerTransformKey(
    "compiler-v1",
    "/one",
    "/one/src/app.tsx?transform",
    "source",
    "tsx",
    "client",
  );

  expect(
    compilerTransformKey(
      "compiler-v1",
      "/two",
      "/two/src/app.tsx?transform",
      "source",
      "tsx",
      "client",
    ),
  ).toBe(key);
  expect(
    compilerTransformKey(
      "compiler-v2",
      "/one",
      "/one/src/app.tsx?transform",
      "source",
      "tsx",
      "client",
    ),
  ).not.toBe(key);
  expect(
    compilerTransformKey(
      "compiler-v1",
      "/one",
      "/one/src/other.tsx?transform",
      "source",
      "tsx",
      "client",
    ),
  ).not.toBe(key);
  expect(
    compilerTransformKey(
      "compiler-v1",
      "/one",
      "/one/src/app.tsx?other",
      "source",
      "tsx",
      "client",
    ),
  ).not.toBe(key);
  expect(
    compilerTransformKey(
      "compiler-v1",
      "/one",
      "/one/src/app.tsx?transform",
      "edited",
      "tsx",
      "client",
    ),
  ).not.toBe(key);
  expect(
    compilerTransformKey(
      "compiler-v1",
      "/one",
      "/one/src/app.tsx?transform",
      "source",
      "ts",
      "client",
    ),
  ).not.toBe(key);
  expect(
    compilerTransformKey(
      "compiler-v1",
      "/one",
      "/one/src/app.tsx?transform",
      "source",
      "tsx",
      "server",
    ),
  ).not.toBe(key);
  expect(
    compilerTransformKey(
      "compiler-v1",
      "/one",
      "/elsewhere/app.tsx",
      "source",
      "tsx",
      "client",
    ),
  ).toBeNull();
  expect(
    compilerTransformKey(
      "compiler-v1",
      "/one",
      "\0virtual",
      "source",
      "tsx",
      "client",
    ),
  ).toBeNull();
});

it("invalidates dependency, configuration, toolchain, and environment identity", () => {
  const identity: Parameters<typeof compilerCacheNamespace>[0] = {
    dependencies: [["vite.config.ts", "config"]],
    node: "v22.23.1",
    nodeOptions: null,
    execArgv: [],
    platform: "darwin" as const,
    arch: "arm64",
    mode: "production",
    production: true,
    env: [["NODE_ENV", "production"]],
  };

  const key = compilerCacheNamespace(identity);

  const changes: Array<Partial<typeof identity>> = [
    { dependencies: [["vite.config.ts", "changed"]] },
    { node: "v24.0.0" },
    { nodeOptions: "--max-old-space-size=4096" },
    { execArgv: ["--conditions=source"] },
    { platform: "linux" as const },
    { arch: "x64" },
    { mode: "staging" },
    { production: false },
    { env: [["BABEL_ENV", "test"]] },
  ];

  for (const changed of changes) {
    expect(compilerCacheNamespace({ ...identity, ...changed })).not.toBe(key);
  }
});

it("rejects worktree paths in maps and escaped generated literals", () => {
  for (const root of [
    "/checkout/one",
    "C:\\checkout\\one",
    '/checkout/"quoted"',
  ]) {
    expect(
      containsWorktreePath(
        JSON.stringify({ map: { sources: [root + "/file.tsx"] } }),
        root,
      ),
    ).toBe(true);
    expect(
      containsWorktreePath(
        JSON.stringify({
          code: `const file = ${JSON.stringify(root + "/file.tsx")};`,
        }),
        root,
      ),
    ).toBe(true);
    expect(
      containsWorktreePath(
        JSON.stringify({
          map: { sources: [root.replaceAll("\\", "/") + "/file.tsx"] },
        }),
        root,
      ),
    ).toBe(true);
    expect(
      containsWorktreePath(
        JSON.stringify({ code: "compiled", map: { sources: ["file.tsx"] } }),
        root,
      ),
    ).toBe(false);
  }
});
