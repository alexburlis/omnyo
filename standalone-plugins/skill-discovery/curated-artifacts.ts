import { createHash } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import { encodeSkillPack } from "./pack-encoding.ts";
import { maxPackBytes } from "./pack.ts";
import { curatedSnapshot } from "./curated-snapshot.ts";
import {
  validateCuratedEntries,
  validateCuratedFiles,
  type CuratedEntry,
  type CuratedFile,
} from "./curated-sources.ts";

export type { CuratedEntry } from "./curated-sources.ts";

export const curatedEntries = validateCuratedEntries(curatedSnapshot);

const maxDownloadBytes = 1024 * 1024;

const maxArchiveBytes = 2 * 1024 * 1024;

const timeoutMs = 15000;

const decoder = new TextDecoder("utf-8", { fatal: true });

export function curatedSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedUrl(value: string, redirect: boolean): URL {
  const url = new URL(value);

  const hosts = redirect
    ? ["github.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com"]
    : ["github.com", "raw.githubusercontent.com"];

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.includes(url.hostname)
  ) {
    throw new Error("The curated artifact uses an unapproved source host.");
  }

  return url;
}

export async function fetchCuratedBytes(
  url: string,
  sha256: string,
  overallSignal?: AbortSignal,
): Promise<Buffer> {
  let next = checkedUrl(url, false);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = overallSignal ? AbortSignal.any([timeout, overallSignal]) : timeout;

  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const response = await fetch(next, { redirect: "manual", signal });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");

      if (!location) throw new Error("The curated artifact redirect has no destination.");
      next = checkedUrl(new URL(location, next).href, true);
      continue;
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("The curated artifact could not be downloaded. Try again.");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;

    try {
      while (true) {
        const chunk = await reader.read();

        if (chunk.done) break;
        length += chunk.value.byteLength;

        if (length > maxDownloadBytes)
          throw new Error("The curated artifact exceeds the download limit.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }

    const bytes = Buffer.concat(chunks);

    if (curatedSha256(bytes) !== sha256)
      throw new Error("The curated artifact does not match its reviewed SHA-256.");

    return bytes;
  }

  throw new Error("The curated artifact redirected too many times.");
}

export async function decodeCuratedArchive(bytes: Buffer): Promise<CuratedFile[]> {
  const expanded = gunzipSync(bytes, { maxOutputLength: maxArchiveBytes });
  const archive = extract();
  const files: CuratedFile[] = [];
  let length = 0;
  let count = 0;
  archive.end(expanded);

  try {
    for await (const stream of archive) {
      count += 1;

      if (count > 512) throw new Error("The curated archive contains too many entries.");
      const { header } = stream;

      if (header.type !== "file" && header.type !== "directory")
        throw new Error("The curated archive contains a link or unsupported entry.");

      if (
        !/^[a-z0-9_][a-z0-9._/-]*\/?$/iu.test(header.name) ||
        header.name
          .replace(/\/$/u, "")
          .split("/")
          .some((segment) => !segment || segment === ".." || segment === ".")
      ) {
        throw new Error("The curated archive contains an unsafe path.");
      }

      length += header.size ?? 0;

      if (length > maxPackBytes || files.length >= 255)
        throw new Error("The curated archive exceeds the skill file limit.");
      const content = await buffer(stream);

      if (header.type === "directory") {
        if (content.length !== 0) throw new Error("The curated archive directory contains data.");
        continue;
      }

      files.push({ path: header.name, content: decoder.decode(content) });
    }
  } finally {
    archive.destroy();
  }

  return files;
}

export async function loadPinnedCuratedFiles(entry: CuratedEntry): Promise<CuratedFile[]> {
  const artifact = entry.artifact;
  const signal = AbortSignal.timeout(45000);
  let files: CuratedFile[];

  if (artifact.kind === "github-files") {
    files = [];

    for (let offset = 0; offset < artifact.files.length; offset += 4) {
      const batch = await Promise.all(
        artifact.files.slice(offset, offset + 4).map(async (file) => ({
          path: file.path,
          content: decoder.decode(await fetchCuratedBytes(file.url, file.sha256, signal)),
        })),
      );

      files.push(...batch);

      if (
        files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > maxPackBytes
      ) {
        throw new Error("The curated skill exceeds the file size limit.");
      }
    }
  } else {
    const bytes = await fetchCuratedBytes(artifact.url, artifact.sha256, signal);
    files =
      artifact.kind === "tar-gzip"
        ? await decodeCuratedArchive(bytes)
        : [{ path: "SKILL.md", content: decoder.decode(bytes) }];
  }

  const markdown = files.find((file) => file.path === "SKILL.md");

  if (
    entry.useOnceReview &&
    (!markdown || curatedSha256(markdown.content) !== entry.useOnceReview.skillSha256)
  ) {
    throw new Error("The one-time instructions do not match the approved review.");
  }

  files.push({ path: entry.notice.path, content: entry.notice.content });

  return validateCuratedFiles(entry, files);
}

export async function loadCuratedFiles(entry: CuratedEntry): Promise<CuratedFile[]> {
  const approved = curatedEntries.find((candidate) => candidate.id === entry.id);

  if (!approved)
    throw new Error("This skill is no longer in the curated catalog. Refresh and try again.");

  return loadPinnedCuratedFiles(approved);
}

export function curatedPackArtifact(entry: CuratedEntry, files: CuratedFile[]) {
  return encodeSkillPack({
    schemaVersion: 1,
    publisher: "curated",
    slug: createHash("sha256").update(entry.id).digest("hex"),
    version: "1.0.0",
    title: entry.name,
    description: entry.description,
    license: entry.license,
    skills: [{ id: entry.name, files }],
    prompts: [],
  });
}
