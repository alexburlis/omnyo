import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

const publicDir = join(appDir, "public");

const checkOnly = process.argv.includes("--check");

if (
  process.argv.includes("--export-base") ||
  process.argv.includes("--export-all-base")
) {
  const { exportOmnyoBaseAssets } =
    await import("./export-omnyo-base-assets.mjs");

  const scratchIndex = process.argv.indexOf("--scratch-root");
  await exportOmnyoBaseAssets({
    root: join(appDir, "..", ".."),
    selectedFamilies: process.argv.includes("--export-all-base")
      ? ["root", "browser", "desktop", "mobile", "site"]
      : ["browser"],
    checkOnly,
    scratchRoot: scratchIndex >= 0 ? process.argv[scratchIndex + 1] : undefined,
  });
}

const faviconColorValues = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffba18",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  purple: "#8e4ec6",
  pink: "#d6409f",
};

const icons = [
  "icon-192.png",
  "icon-512.png",
  "icon-192-maskable.png",
  "icon-512-maskable.png",

  "apple-touch-icon.png",
];

const monochromeIcons = [
  { source: "icon-192.png", target: "icon-monochrome-192.png" },
  { source: "icon-512.png", target: "icon-monochrome-512.png" },
];

const mismatches = [];

function parseHex(hex) {
  return [1, 3, 5].map((index) =>
    Number.parseInt(hex.slice(index, index + 2), 16),
  );
}

function outputFileName(file, color) {
  return file.replace(/\.png$/u, `-${color}.png`);
}

function tintTileIcon(data, colorRgb) {
  const output = Buffer.from(data);

  for (let index = 0; index < output.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];

    if (alpha === 0) continue;

    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

    if (luma >= 245) continue;

    const maskAlpha = Math.round(
      255 * Math.sqrt((245 - luma) / 245) * (alpha / 255),
    );

    if (maskAlpha <= 0) continue;

    const ratio = maskAlpha / 255;
    output[index] = Math.round(colorRgb[0] * ratio + 255 * (1 - ratio));
    output[index + 1] = Math.round(colorRgb[1] * ratio + 255 * (1 - ratio));
    output[index + 2] = Math.round(colorRgb[2] * ratio + 255 * (1 - ratio));
    output[index + 3] = alpha;
  }

  return output;
}

async function generatedPng(file, hex) {
  const { data, info } = await sharp(join(publicDir, file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const output = tintTileIcon(data, parseHex(hex));

  return sharp(output, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

function generatedManifest(baseManifest, color) {
  return Buffer.from(
    `${JSON.stringify(
      {
        ...baseManifest,
        icons: baseManifest.icons.map((icon) =>
          icon.purpose === "monochrome"
            ? icon
            : {
                ...icon,
                src: icon.src.replace(/\.png$/u, `-${color}.png`),
              },
        ),
      },
      null,
      2,
    )}\n`,
  );
}

async function generatedMonochromePng(sourceFile) {
  const { data, info } = await sharp(join(publicDir, sourceFile))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const output = Buffer.from(data);

  for (let index = 0; index < output.length; index += 4) {
    const luma =
      0.2126 * data[index] +
      0.7152 * data[index + 1] +
      0.0722 * data[index + 2];

    const maskAlpha =
      luma >= 245
        ? 0
        : Math.round(
            255 * Math.sqrt((245 - luma) / 245) * (data[index + 3] / 255),
          );

    output[index] = 255;
    output[index + 1] = 255;
    output[index + 2] = 255;
    output[index + 3] = maskAlpha;
  }

  return sharp(output, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function writeOrCheck(fileName, content) {
  const filePath = join(publicDir, fileName);

  const existing = await readFile(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (existing?.equals(content)) return;

  if (checkOnly) {
    mismatches.push(fileName);

    return;
  }

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const baseManifest = JSON.parse(
  await readFile(join(publicDir, "manifest.webmanifest"), "utf8"),
);

for (const monochromeIcon of monochromeIcons) {
  await writeOrCheck(
    monochromeIcon.target,
    await generatedMonochromePng(monochromeIcon.source),
  );
}

for (const [color, hex] of Object.entries(faviconColorValues)) {
  for (const file of icons) {
    await writeOrCheck(
      outputFileName(file, color),
      await generatedPng(file, hex),
    );
  }

  await writeOrCheck(
    `manifest-${color}.webmanifest`,
    generatedManifest(baseManifest, color),
  );
}

if (mismatches.length > 0) {
  console.error(
    [
      "Generated PWA icon assets are out of date:",
      ...mismatches.map((fileName) => `  ${fileName}`),
      "Run `pnpm --filter @omnyo/app generate:pwa-icons`.",
    ].join("\n"),
  );
  process.exitCode = 1;
}
