import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function inventoryRepository(repo, directory, baseline) {
  const root = await realpath(directory);

  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });

  const paths = [
    ...new Set(
      git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();

  const old = new Map(
    baseline.filter((row) => row.repo === repo).map((row) => [row.path, row]),
  );

  const files = [];

  for (const path of paths) {
    const absolute = resolve(root, path);
    const local = relative(root, absolute);

    if (isAbsolute(local) || local === ".." || local.startsWith("../"))
      throw new Error("Inventory path escapes repository");

    const info = await lstat(absolute).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });

    if (!info) continue;
    const previous = old.get(path);
    old.delete(path);

    if (!info.isFile()) {
      files.push({
        repo,
        path,
        state: info.isSymbolicLink()
          ? "symlink-not-followed"
          : "nonregular-not-read",
        delta: "needs-inspection",
      });
      continue;
    }

    if (/(^|\/)\.env(?:\.|$)|\.(?:1p|pem|key|p12|pfx)$/.test(path)) {
      files.push({
        repo,
        path,
        state: "protected-not-read",
        delta: "protected-owner-required",
      });
      continue;
    }

    const actual = await realpath(absolute);

    if (actual !== absolute)
      throw new Error("Inventory parent symlink refused");
    const bytes = await readFile(absolute);
    const sha256 = digest(bytes);
    files.push({
      repo,
      path,
      bytes: bytes.length,
      sha256,
      delta: !previous
        ? "added"
        : previous.sha256 === sha256
          ? "unchanged"
          : "changed",
      disposition: "unclassified",
    });
  }

  for (const [path] of old)
    files.push({ repo, path, delta: "removed", disposition: "verify-removal" });

  return {
    repo,
    root,
    commit: git("rev-parse", "HEAD").trim(),
    files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
  };
}

export async function inventoryMigration({
  baselineDirectory,
  repositories,
  coveragePath,
  assetsPath,
}) {
  const baselineBytes = await readFile(
    resolve(baselineDirectory, "all-files.jsonl"),
  );

  const baseline = baselineBytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const table = async (path) =>
    (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("\t"));

  const coverage = await table(coveragePath);
  const assets = await table(assetsPath);
  const ledgerIds = coverage.slice(1).map((row) => row[0]);
  const assetKeys = assets.slice(1).map((row) => `${row[0]}:${row[1]}`);

  if (ledgerIds.length !== 166 || new Set(ledgerIds).size !== 166)
    throw new Error("Expected exactly 166 unique coverage categories");

  if (assetKeys.length !== 504 || new Set(assetKeys).size !== 504)
    throw new Error("Expected exactly 504 unique asset paths");
  const source = [];

  for (const [repo, directory] of repositories)
    source.push(await inventoryRepository(repo, directory, baseline));

  return {
    formatVersion: 1,
    method:
      "git tracked and nonignored untracked files; no lexical replacement authority",
    baseline: {
      directory: resolve(baselineDirectory),
      indexSha256: digest(baselineBytes),
    },
    ledgerIds,
    assetKeys,
    repositories: source,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = { repositories: [] };

  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];

    if (!value) throw new Error(`Missing value for ${name}`);

    if (name === "--repo") {
      const separator = value.indexOf("=");

      if (separator < 1)
        throw new Error("--repo requires name=absolute-directory");
      options.repositories.push([
        value.slice(0, separator),
        value.slice(separator + 1),
      ]);
    } else if (name === "--baseline") options.baselineDirectory = value;
    else if (name === "--coverage") options.coveragePath = value;
    else if (name === "--assets") options.assetsPath = value;
    else if (name === "--output") options.output = value;
    else throw new Error(`Unknown option ${name}`);
  }

  if (
    !options.output ||
    !isAbsolute(options.output) ||
    !options.repositories.length
  )
    throw new Error("An absolute output and repository inputs are required");
  const report = await inventoryMigration(options);
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      output: options.output,
      repositories: report.repositories.map(({ repo, commit, files }) => ({
        repo,
        commit,
        paths: files.length,
      })),
      categories: report.ledgerIds.length,
      assets: report.assetKeys.length,
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
