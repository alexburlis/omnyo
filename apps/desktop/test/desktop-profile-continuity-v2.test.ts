import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  compareDesktopCookiesV2,
  desktopCookieSnapshotV2,
  desktopContinuityReportSchemaV2,
  inspectDesktopContinuityContextsV2,
  inspectDesktopCookieDatabaseV2,
  verifyDesktopEncryptedFileV2,
  verifyDesktopContinuityArtifactV2,
} from "../src/desktop-profile-continuity-v2.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-continuity-source-")),
  );

  roots.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  await Promise.all([source, target].map((path) => mkdir(path)));

  return { root, source, target };
}

function database(path: string, encrypted = true, expires = 2000000000) {
  const db = new DatabaseSync(path);

  try {
    db.exec(
      "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,encrypted_value BLOB,has_expires INTEGER,expires_utc INTEGER)",
    );
    db.prepare("INSERT INTO cookies VALUES(?,?,?,?,1,?)").run(
      "example.test",
      "continuity",
      "/",
      encrypted ? Buffer.from("synthetic-ciphertext") : Buffer.alloc(0),
      BigInt(expires) * 1000000n + 11644473600000000n,
    );
  } finally {
    db.close();
  }
}

const cookie = {
  domain: "example.test",
  name: "continuity",
  path: "/",
  value: "synthetic-decoded",
  session: false,
  sameSite: "lax",
  secure: false,
  expirationDate: 2000000000,
};

test("compares real copied DB expectations and rejects silent encrypted-row loss", async () => {
  const f = await fixture();
  database(join(f.source, "Cookies"));
  database(join(f.target, "Cookies"));

  const [source, target] = await Promise.all(
    [f.source, f.target].map((path) =>
      inspectDesktopCookieDatabaseV2(path, Date.now()),
    ),
  );

  expect(
    compareDesktopCookiesV2(source, target, [cookie], [cookie]),
  ).toMatchObject({ count: 1, encrypted: 1, encryptedWitness: true });
  expect(() => compareDesktopCookiesV2(source, target, [], [])).toThrow(
    "complete source expectations",
  );
  expect(() =>
    compareDesktopCookiesV2(
      source,
      target,
      [cookie],
      [{ ...cookie, value: "changed" }],
    ),
  ).toThrow();
  expect(() =>
    compareDesktopCookiesV2(
      source,
      target,
      [cookie],
      [{ ...cookie, name: "other" }],
    ),
  ).toThrow();
});

test("includes default and every opaque session path while mapping only the owned browser partition", async () => {
  const f = await fixture();

  for (const [base, name] of [
    [f.source, "bb-browser"],
    [f.target, "omnyo-browser"],
  ]) {
    await mkdir(join(base, `Partitions/${name}`), { recursive: true });
    await mkdir(join(base, "Partitions/raw-bb-user-context"));
  }

  const contexts = await inspectDesktopContinuityContextsV2(f.source, f.target);
  expect(contexts.map((entry) => entry.key)).toEqual([
    "",
    "Partitions/bb-browser",
    "Partitions/raw-bb-user-context",
  ]);
  await mkdir(join(f.target, "Partitions/extra"));
  await expect(
    inspectDesktopContinuityContextsV2(f.source, f.target),
  ).rejects.toThrow("omitted or changed");
});

test("rejects aliased session paths and ambiguous Cookie DB locations without touching source bytes", async () => {
  const f = await fixture();
  await mkdir(join(f.source, "Partitions"));
  await symlink(f.target, join(f.source, "Partitions/alias"));
  await expect(
    inspectDesktopContinuityContextsV2(f.source, f.target),
  ).rejects.toThrow("filesystem owner");
  database(join(f.target, "Cookies"));
  await mkdir(join(f.target, "Network"));
  database(join(f.target, "Network/Cookies"));
  const before = await readFile(join(f.target, "Cookies"));
  await expect(
    inspectDesktopCookieDatabaseV2(f.target, Date.now()),
  ).rejects.toThrow("collide");
  expect(await readFile(join(f.target, "Cookies"))).toEqual(before);
});

test("keeps full unknown cookie fields in equality and rejects a missing decrypt witness", () => {
  const a = { ...cookie, future: { raw: [1, { preserved: true }] } };
  const b = { ...a, future: { raw: [1, { preserved: false }] } };
  expect(desktopCookieSnapshotV2([a]).sha256).not.toBe(
    desktopCookieSnapshotV2([b]).sha256,
  );
  const sha = "a".repeat(64);
  expect(
    desktopContinuityReportSchemaV2.safeParse({
      version: 2,
      processId: process.pid,
      requestSha256: sha,
      bindingSha256: sha,
      nativeOwnerSha256: sha,
      protectedStore: true,
      cookies: true,
      contextCount: 1,
      cookieCount: 0,
      encryptedCookieCount: 0,
      encryptedFileWitness: false,
      encryptedCookieWitness: false,
      snapshotsSha256: sha,
      interactionNotAllowed: true,
      networkServices: 0,
      windows: 0,
    }).success,
  ).toBe(false);
});

test("requires encryption availability and rejects corrupted or changed existing encrypted copies", async () => {
  const f = await fixture();

  const unavailable = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };

  await expect(
    verifyDesktopEncryptedFileV2(f.source, f.target, unavailable),
  ).rejects.toThrow("unavailable");

  const available = {
    ...unavailable,
    isEncryptionAvailable: () => true,
    decryptString: () => {
      throw new Error("synthetic decode denied");
    },
  };

  expect(
    await verifyDesktopEncryptedFileV2(f.source, f.target, available),
  ).toBe(false);
  await Promise.all(
    [f.source, f.target].map((path) =>
      writeFile(join(path, "connect-credential.bin"), "synthetic-ciphertext", {
        mode: 0o600,
      }),
    ),
  );
  await expect(
    verifyDesktopEncryptedFileV2(f.source, f.target, available),
  ).rejects.toThrow("cannot be decrypted");
  await writeFile(
    join(f.target, "connect-credential.bin"),
    "foreign-ciphertext",
  );
  await expect(
    verifyDesktopEncryptedFileV2(f.source, f.target, available),
  ).rejects.toThrow("copies differ");
});

test("refuses an unheld profile lock before any installed artifact or protected-store access", async () => {
  const f = await fixture();
  const digest = "a".repeat(64);
  await expect(
    verifyDesktopContinuityArtifactV2(f.root, {
      executable: digest,
      asar: digest,
      framework: digest,
      consumers: digest,
    }),
  ).rejects.toThrow("existing profile preparation lock");
});
