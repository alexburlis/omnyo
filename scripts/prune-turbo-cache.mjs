#!/usr/bin/env node

import { readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

const ENTRY_PATTERN = /^([0-9a-f]+)(-meta\.json|\.tar\.zst)$/;

function parseArgs(argv) {
  const args = { dir: ".turbo/cache", maxSizeMb: 1024, runSummaries: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dir") {
      args.dir = argv[i + 1];
      i += 1;
    } else if (arg === "--keep-run-summaries") {
      args.runSummaries = argv[i + 1];
      i += 1;
    } else if (arg === "--max-size-mb") {
      args.maxSizeMb = Number(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.dir) {
    throw new Error("--dir requires a value");
  }

  if (args.runSummaries === undefined) {
    throw new Error("--keep-run-summaries requires a value");
  }

  if (!Number.isFinite(args.maxSizeMb) || args.maxSizeMb <= 0) {
    throw new Error("--max-size-mb requires a positive number");
  }

  return args;
}

async function collectEntries(dir) {
  let names;

  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const entries = new Map();

  for (const name of names) {
    const match = ENTRY_PATTERN.exec(name);

    if (!match) {
      continue;
    }

    const hash = match[1];
    const stats = await stat(path.join(dir, name));

    if (!stats.isFile()) {
      continue;
    }

    const entry = entries.get(hash) ?? { hash, files: [], size: 0, mtimeMs: 0 };
    entry.files.push(name);
    entry.size += stats.size;
    entry.mtimeMs = Math.max(entry.mtimeMs, stats.mtimeMs);
    entries.set(hash, entry);
  }

  return [...entries.values()];
}

async function collectUsedHashes(dir) {
  let names;

  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const summaries = names.filter((name) => name.endsWith(".json"));

  if (summaries.length === 0) {
    return null;
  }

  const hashes = new Set();

  for (const name of summaries) {
    const summary = JSON.parse(await readFile(path.join(dir, name), "utf8"));

    for (const task of summary.tasks ?? []) {
      if (typeof task.hash === "string") {
        hashes.add(task.hash);
      }
    }
  }

  return hashes;
}

async function removeEntries(dir, entries) {
  for (const entry of entries) {
    await Promise.all(entry.files.map((name) => unlink(path.join(dir, name))));
  }

  return entries.reduce((sum, entry) => sum + entry.size, 0);
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const { dir, maxSizeMb, runSummaries } = parseArgs(process.argv.slice(2));
  let entries = await collectEntries(dir);

  if (entries === null) {
    console.log(`Turbo cache prune: ${dir} does not exist yet; nothing to do.`);

    return;
  }

  if (runSummaries !== null) {
    const usedHashes = await collectUsedHashes(runSummaries);

    if (usedHashes === null) {
      console.log(
        `Turbo cache prune: no run summaries in ${runSummaries}; keeping unused entries.`,
      );
    } else {
      const unused = entries.filter((entry) => !usedHashes.has(entry.hash));
      const unusedSize = await removeEntries(dir, unused);
      entries = entries.filter((entry) => usedHashes.has(entry.hash));
      console.log(
        `Turbo cache prune: removed ${unused.length} entries this job did not use ` +
          `(${formatMb(unusedSize)}); ${entries.length} used entries remain.`,
      );
    }
  }

  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const maxSizeBytes = maxSizeMb * 1024 * 1024;

  if (totalSize <= maxSizeBytes) {
    console.log(
      `Turbo cache prune: ${entries.length} entries, ${formatMb(totalSize)} of ${maxSizeMb} MB budget; nothing to remove.`,
    );

    return;
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let keptSize = 0;
  let removedSize = 0;
  let removedCount = 0;

  for (const entry of entries) {
    if (keptSize + entry.size <= maxSizeBytes) {
      keptSize += entry.size;
      continue;
    }

    await Promise.all(entry.files.map((name) => unlink(path.join(dir, name))));
    removedSize += entry.size;
    removedCount += 1;
  }

  console.log(
    `Turbo cache prune: removed ${removedCount} of ${entries.length} entries ` +
      `(${formatMb(removedSize)}); ${formatMb(keptSize)} kept of ${maxSizeMb} MB budget.`,
  );
}

await main();
