import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const app = resolve(server, "../app");

const appRequire = createRequire(join(app, "package.json"));

const { build } = await import(pathToFileURL(appRequire.resolve("vite")).href);

const output = join(server, "dist/assets/origin-adoption-v1");

await build({
  configFile: join(app, "vite.origin-adoption-v1.config.ts"),
  build: { outDir: output, emptyOutDir: true },
});

const hash = (value) => createHash("sha256").update(value).digest("hex");

const viteManifest = JSON.parse(
  await readFile(join(output, ".vite/manifest.json"), "utf8"),
);

const entries = Object.values(viteManifest);

if (
  entries.filter((value) => value.isEntry).length !== 1 ||
  !entries.every(
    (value) =>
      typeof value.file === "string" &&
      /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/u.test(value.file) &&
      !value.css?.length &&
      !value.assets?.length,
  )
)
  throw new Error(
    "Neutral origin bundle contains an unselected entry or asset",
  );

const names = [
  "origin-adoption-v1.html",
  ...new Set(entries.map((value) => value.file)),
].sort();

if (names.length > 16)
  throw new Error("Neutral origin bundle exceeds its finite bound");

const actual = (await readdir(join(output, "assets")))
  .map((name) => "assets/" + name)
  .sort();

if (
  JSON.stringify(actual) !==
  JSON.stringify(names.filter((name) => name.startsWith("assets/")))
)
  throw new Error("Neutral origin bundle contains an unlisted asset");

const files = await Promise.all(
  names.map(async (file) => {
    const info = await lstat(join(output, file));

    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      throw new Error("Neutral origin bundle file ownership differs");
    const bytes = await readFile(join(output, file));

    return {
      file,
      path:
        file === "origin-adoption-v1.html"
          ? "/" + file
          : "/origin-adoption-v1/" + file,
      sha256: hash(bytes),
      bytes: bytes.length,
    };
  }),
);

await writeFile(
  join(output, "manifest.json"),
  JSON.stringify({ version: 1, files }) + "\n",
);
