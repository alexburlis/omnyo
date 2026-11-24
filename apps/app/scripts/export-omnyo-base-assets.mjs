import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const variants = {
  black: "#080808",
  white: "#faf9f6",
  orange: "#ff771a",
  green: "#080808",
  yellow: "#080808",
  shaded: "url(#omnyo-shade)",
};

const backgrounds = { green: "#378055", yellow: "#f9d71c" };

const families = new Set(["root", "browser", "desktop", "mobile", "site"]);

function validateOutput(output) {
  if (
    !families.has(output.family) ||
    !["tile", "opaque", "transparent"].includes(output.canvas) ||
    !Object.hasOwn(variants, output.variant)
  )
    throw new Error("Invalid Omnyo asset variant");

  if (
    ![output.width, output.height].every(
      (value) => Number.isInteger(value) && value > 0 && value <= 4096,
    )
  )
    throw new Error("Invalid Omnyo asset dimensions");

  if (!(output.markScale > 0 && output.markScale <= 1))
    throw new Error("Invalid Omnyo mark safe area");
}

async function ownedPath(root, path) {
  const target = resolve(root, path);
  const local = relative(root, target);

  if (isAbsolute(path) || !local || local.startsWith("../") || local === "..")
    throw new Error("Omnyo asset path escapes source");
  let current = root;

  for (const part of local.split("/").slice(0, -1)) {
    current = join(current, part);

    const info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });

    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error("Omnyo asset directory is not owned source");
  }

  const info = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

  if (info && (!info.isFile() || info.isSymbolicLink()))
    throw new Error("Omnyo asset target is not a regular file");

  return target;
}

function renderSvg(source, output) {
  const size = Math.min(output.width, output.height) * output.markScale;
  const x = (output.width - size) / 2;
  const y = (output.height - size) / 2;

  const markSource = output.monochrome
    ? source.replaceAll("#ff4f17", "currentColor")
    : source;

  const mark = markSource
    .replace(/^.*?<svg[^>]*>/su, "")
    .replace(/<\/svg>\s*$/u, "")
    .replaceAll("currentColor", variants[output.variant]);

  const background =
    output.canvas === "transparent"
      ? ""
      : `<rect x="0" y="0" width="${output.width}" height="${output.height}" rx="${output.canvas === "tile" ? output.width * 0.22 : 0}" fill="${backgrounds[output.variant] ?? "#ffffff"}"/>`;

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${output.width}" height="${output.height}" viewBox="0 0 ${output.width} ${output.height}"><defs><linearGradient id="omnyo-shade" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#555555"/><stop offset="1" stop-color="#050505"/></linearGradient></defs>${background}<g transform="translate(${x} ${y}) scale(${size / 64})">${mark}</g></svg>\n`,
  );
}

async function outputBytes(source, output) {
  const svg = renderSvg(source, output);

  if (output.path.endsWith(".svg")) return svg;

  if (!output.path.endsWith(".png"))
    throw new Error("Unsupported Omnyo asset output format");
  let image = sharp(svg);

  if (output.canvas === "opaque") image = image.removeAlpha();

  return image.png().toBuffer();
}

export async function exportOmnyoBaseAssets({
  root,
  selectedFamilies = ["browser"],
  checkOnly = false,
  scratchRoot,
}) {
  const sourceRoot = await realpath(root);

  if (selectedFamilies.some((family) => !families.has(family)))
    throw new Error("Unknown Omnyo asset family");

  const manifest = JSON.parse(
    await readFile(join(sourceRoot, "assets/omnyo/exports.json"), "utf8"),
  );

  if (
    manifest.formatVersion !== 1 ||
    !Array.isArray(manifest.outputs) ||
    !Array.isArray(manifest.icns)
  )
    throw new Error("Unsupported Omnyo asset export manifest");
  const sourcePath = await ownedPath(sourceRoot, manifest.source);
  const source = await readFile(sourcePath, "utf8");

  if (
    !source.includes('viewBox="0 0 64 64"') ||
    !source.includes("currentColor")
  )
    throw new Error("Expected canonical Omnyo source geometry");

  const outputs = manifest.outputs.filter((output) =>
    selectedFamilies.includes(output.family),
  );

  const icns = manifest.icns.filter((output) =>
    selectedFamilies.includes(output.family),
  );

  const targets = new Set();

  for (const output of outputs) {
    validateOutput(output);
    await ownedPath(sourceRoot, output.path);
    const key = output.path.toLowerCase();

    if (targets.has(key)) throw new Error("Colliding Omnyo asset output");
    targets.add(key);
  }

  for (const output of icns) {
    if (process.platform !== "darwin")
      throw new Error("ICNS exports require the existing macOS iconutil owner");

    if (!scratchRoot || !isAbsolute(scratchRoot))
      throw new Error("ICNS export requires an absolute owned scratch root");
    await ownedPath(sourceRoot, output.path);
    await ownedPath(sourceRoot, output.png);
    const key = output.path.toLowerCase();

    if (targets.has(key)) throw new Error("Colliding Omnyo asset output");
    targets.add(key);
  }

  const mismatches = [];
  const records = [];

  const writeOutput = async (path, bytes, dimensions) => {
    const target = await ownedPath(sourceRoot, path);

    const existing = await readFile(target).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });

    const hash = (value) =>
      value ? createHash("sha256").update(value).digest("hex") : null;

    records.push({
      path,
      beforeSha256: hash(existing),
      sha256: hash(bytes),
      ...dimensions,
    });

    if (existing?.equals(bytes)) return;

    if (checkOnly) {
      mismatches.push(path);

      return;
    }

    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  };

  for (const output of outputs)
    await writeOutput(output.path, await outputBytes(source, output), {
      width: output.width,
      height: output.height,
      canvas: output.canvas,
      variant: output.variant,
      markScale: output.markScale,
    });

  for (const output of icns) {
    const png = await ownedPath(sourceRoot, output.png);
    const work = await mkdtemp(join(scratchRoot, "omnyo-icon-"));

    try {
      const iconset = join(work, "app.iconset");
      await mkdir(iconset);

      for (const size of [16, 32, 128, 256, 512])
        for (const scale of [1, 2])
          await sharp(png)
            .resize(size * scale, size * scale)
            .png()
            .toFile(
              join(
                iconset,
                `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
              ),
            );
      const destination = join(work, "icon.icns");
      await execFileAsync(
        "/usr/bin/iconutil",
        ["--convert", "icns", "--output", destination, iconset],
        { timeout: 10000 },
      );
      await writeOutput(output.path, await readFile(destination), {
        format: "icns",
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  if (mismatches.length)
    throw new Error(
      `Omnyo base assets are out of date:\n${mismatches.join("\n")}`,
    );

  return {
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    records,
  };
}
