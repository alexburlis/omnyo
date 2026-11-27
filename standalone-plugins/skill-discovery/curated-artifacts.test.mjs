import assert from "node:assert/strict";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import {
  curatedEntries,
  curatedSha256,
  decodeCuratedArchive,
  fetchCuratedBytes,
  loadCuratedFiles,
} from "./curated-artifacts.ts";
import { validateCuratedEntries, validateCuratedFiles } from "./curated-sources.ts";

async function archive(entries) {
  const tar = pack();

  for (const entry of entries) tar.entry(entry.header, entry.content ?? "");
  tar.finalize();

  return gzipSync(await buffer(tar));
}

test("catalog pins every source and binds each use-once approval to exact instructions", () => {
  assert.equal(curatedEntries.length, 22);
  assert.equal(curatedEntries.filter((entry) => entry.useOnce).length, 8);
  assert.equal(new Set(curatedEntries.map((entry) => entry.id)).size, 22);

  for (const entry of curatedEntries) {
    assert.equal(entry.useOnce, entry.useOnceReview !== null);
    assert.match(entry.notice.content, /Permission is hereby granted/);
    assert.ok(entry.sourceUrl.includes(entry.pin));
  }

  assert.throws(
    () => validateCuratedEntries([...curatedEntries, curatedEntries[0]]),
    /duplicate ID/,
  );
  assert.throws(() => validateCuratedEntries([{ ...curatedEntries[0], pin: "f".repeat(40) }]));
  assert.throws(() =>
    validateCuratedEntries([{ ...curatedEntries[0], useOnce: !curatedEntries[0].useOnce }]),
  );
});

test("archive decoding preserves supporting files and rejects links, traversal, invalid text and excessive expansion", async () => {
  const entries = [
    { header: { name: "SKILL.md" }, content: "Skill" },
    { header: { name: "rules/_sections.md" }, content: "Sections" },
  ];

  assert.deepEqual(
    await decodeCuratedArchive(await archive(entries)),
    entries.map((entry) => ({ path: entry.header.name, content: entry.content })),
  );

  for (const header of [
    { name: "../escape.md" },
    { name: "/absolute.md" },
    { name: "bad\\path.md" },
    { name: "link", type: "symlink", linkname: "SKILL.md" },
    { name: "link", type: "link", linkname: "SKILL.md" },
  ])
    await assert.rejects(
      decodeCuratedArchive(await archive([{ header }])),
      /unsafe path|unsupported entry/,
    );
  await assert.rejects(
    decodeCuratedArchive(
      await archive([{ header: { name: "bad.md" }, content: Buffer.from([0xff]) }]),
    ),
  );
  await assert.rejects(decodeCuratedArchive(gzipSync(Buffer.alloc(3 * 1024 * 1024))));
});

test("verified downloads enforce SHA, redirect hosts and byte bounds without writing files", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bytes = Buffer.from("reviewed artifact");
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;

    return new Response(bytes);
  };

  assert.deepEqual(
    await fetchCuratedBytes(
      "https://raw.githubusercontent.com/owner/repo/pin/SKILL.md",
      curatedSha256(bytes),
    ),
    bytes,
  );
  await assert.rejects(
    fetchCuratedBytes("https://raw.githubusercontent.com/owner/repo/pin/SKILL.md", "0".repeat(64)),
    /SHA-256/,
  );
  await assert.rejects(
    fetchCuratedBytes("http://127.0.0.1/artifact", curatedSha256(bytes)),
    /unapproved/,
  );
  assert.equal(calls, 2);
  globalThis.fetch = async () =>
    new Response(null, { status: 302, headers: { location: "https://example.com/private" } });
  await assert.rejects(
    fetchCuratedBytes(
      "https://github.com/owner/repo/releases/download/pin/asset",
      curatedSha256(bytes),
    ),
    /unapproved/,
  );
  globalThis.fetch = async () => new Response(Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(
    fetchCuratedBytes("https://raw.githubusercontent.com/owner/repo/pin/SKILL.md", "0".repeat(64)),
    /download limit/,
  );
});

test("one-time validation refuses disabled declarations and mismatched names", () => {
  const entry = curatedEntries.find((candidate) => candidate.useOnce);

  for (const header of [
    `name: another-name`,
    `name: ${entry.name}\ndisable-model-invocation: true`,
    `name: ${entry.name}\nuser-invocable: false`,
  ]) {
    assert.throws(() =>
      validateCuratedFiles(entry, [
        { path: "SKILL.md", content: `---\n${header}\ndescription: Test\n---\nTest` },
      ]),
    );
  }
});

test("unknown selections cannot supply their own download targets", async () => {
  await assert.rejects(
    loadCuratedFiles({ ...curatedEntries[0], id: "unknown/repo/entry" }),
    /no longer/,
  );
});
