import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { cssDependencyChunkHash } from "../vite-css-dependency-hash";

async function buildAssets(
  root: string,
  color: string,
  outDir: string,
): Promise<Map<string, string>> {
  await writeFile(join(root, "app.css"), `body { color: ${color}; }`);
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [cssDependencyChunkHash()],
    build: {
      outDir,
      minify: false,
      chunkImportMap: true,
    },
  });
  const assets = join(root, outDir, "assets");
  const files = await readdir(assets);

  return new Map(
    await Promise.all(
      files.map(
        async (file) =>
          [file, await readFile(join(assets, file), "utf8")] as const,
      ),
    ),
  );
}

it("renames a chunk whose preload list names a changed stylesheet", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-css-dependency-hash-")),
  );

  try {
    await Promise.all(
      Object.entries({
        "index.html": '<script type="module" src="/main.js"></script>',
        "main.js":
          'import "./app.css"; import { value } from "./shared.js"; window.value = value; window.toggle = () => import("./toggle.js");',
        "shared.js": "export const value = Math.random();",
        "toggle.js":
          'import { value } from "./shared.js"; window.panel = () => import("./panel.js"); export default value;',
        "panel.js":
          'import { value } from "./shared.js"; export default value * 2;',
      }).map(([name, source]) => writeFile(join(root, name), source)),
    );

    const first = await buildAssets(root, "red", "first");
    const second = await buildAssets(root, "blue", "second");

    const changedCss = [...second.keys()].filter(
      (file) => file.endsWith(".css") && !first.has(file),
    );

    expect(changedCss).toHaveLength(1);

    const reusedNames = [...second.keys()].filter((file) => first.has(file));

    for (const file of reusedNames)
      expect(second.get(file), file).toBe(first.get(file));
    expect(
      [...second.entries()].some(
        ([file, code]) =>
          file.endsWith(".js") && code.includes(changedCss[0] ?? "\0"),
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
