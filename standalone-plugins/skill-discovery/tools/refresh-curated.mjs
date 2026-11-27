import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { fetchCuratedBytes, loadPinnedCuratedFiles } from "../curated-artifacts.ts";
import { curatedSnapshot } from "../curated-snapshot.ts";
import { validateCuratedEntries } from "../curated-sources.ts";

const root = new URL("../", import.meta.url);

const mode = process.argv[2] ?? "--check";

if (!["--check", "--write"].includes(mode) || process.argv.length > 3) {
  throw new Error("Usage: pnpm curated:refresh [--check|--write]");
}

const entries = validateCuratedEntries(
  JSON.parse(await fs.readFile(new URL("curated-allowlist.json", root), "utf8")),
).sort((left, right) => left.id.localeCompare(right.id, "en"));

const publisherManifest = z
  .object({
    skills: z.array(
      z.object({
        name: z.string(),
        url: z.url(),
        digest: z.string(),
        type: z.enum(["archive", "skill-md"]),
      }),
    ),
  })
  .parse(JSON.parse(await fs.readFile(new URL("curated-vercel-manifest.json", root), "utf8")));

for (const entry of entries) {
  if (entry.artifact.kind === "github-files") continue;
  const source = publisherManifest.skills.find((skill) => skill.name === entry.name);

  if (
    !source ||
    source.url !== entry.artifact.url ||
    source.digest !== `sha256:${entry.artifact.sha256}` ||
    source.type !== (entry.artifact.kind === "tar-gzip" ? "archive" : "skill-md")
  ) {
    throw new Error(`The publisher manifest does not match ${entry.id}.`);
  }
}

const noticeSources = z
  .array(
    z
      .object({
        url: z.url(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  )
  .parse(JSON.parse(await fs.readFile(new URL("curated-notice-sources.json", root), "utf8")));

await Promise.all(noticeSources.map((source) => fetchCuratedBytes(source.url, source.sha256)));

const verified = [];

for (let offset = 0; offset < entries.length; offset += 3) {
  const batch = await Promise.all(
    entries.slice(offset, offset + 3).map(async (entry) => {
      const files = await loadPinnedCuratedFiles(entry);

      return {
        id: entry.id,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
        useOnce: entry.useOnce,
      };
    }),
  );

  verified.push(...batch);
}

const previous = new Map(validateCuratedEntries(curatedSnapshot).map((entry) => [entry.id, entry]));

const current = new Map(entries.map((entry) => [entry.id, entry]));

const report = {
  added: entries.filter((entry) => !previous.has(entry.id)).map((entry) => entry.id),
  updated: entries
    .filter(
      (entry) =>
        previous.has(entry.id) && JSON.stringify(previous.get(entry.id)) !== JSON.stringify(entry),
    )
    .map((entry) => entry.id),
  removed: curatedSnapshot.filter((entry) => !current.has(entry.id)).map((entry) => entry.id),
  exclusions: JSON.parse(await fs.readFile(new URL("curated-exclusions.json", root), "utf8")),
  verified,
};

const target = new URL("curated-snapshot.ts", root);

const source = `export const curatedSnapshot = ${JSON.stringify(entries)};\n`;

const existing = validateCuratedEntries(curatedSnapshot);

if (mode === "--write") {
  const temporary = fileURLToPath(new URL("curated-snapshot.tmp.ts", root));
  await fs.writeFile(temporary, source, { flag: "wx" });

  try {
    await promisify(execFile)(
      fileURLToPath(new URL("node_modules/.bin/oxfmt", root)),
      [temporary],
      { timeout: 15000 },
    );
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
} else if (JSON.stringify(existing) !== JSON.stringify(entries)) {
  throw new Error(
    "The approved allowlist differs from the snapshot. Review the changes, then run --write.",
  );
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
