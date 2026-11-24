import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, join } from "node:path";
import { inspectMacStateAclV1 } from "@omnyo/server-archive/mac-state-acl-v1";

const sha = (value) => createHash("sha256").update(value).digest("hex");

export const DESKTOP_PROFILE_MARKER_NAME_V1 = "product-profile-v1.json";

const markerName = DESKTOP_PROFILE_MARKER_NAME_V1;

export function canonicalDesktopProfilePathV2(key, migrated = false) {
  return migrated
    ? key.replace(
        /^Partitions\/omnyo-browser(?=\/|$)/u,
        "Partitions/bb-browser",
      )
    : key;
}

export async function readDesktopProfileSessionsV2(root, migrated = false) {
  await assertDesktopProfileOwnedPathV2(root, true);
  const sessions = [{ key: "", path: root }];
  const partitions = join(root, "Partitions");

  const info = await lstat(partitions).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (info === null) return sessions;
  await assertDesktopProfileOwnedPathV2(partitions, true);

  for (const name of (await readdir(partitions)).sort()) {
    const path = join(partitions, name);
    await assertDesktopProfileOwnedPathV2(path, true);
    sessions.push({
      key: canonicalDesktopProfilePathV2(`Partitions/${name}`, migrated),
      path,
    });
  }

  if (new Set(sessions.map((entry) => entry.key)).size !== sessions.length)
    throw new Error("Desktop profile session paths collide");

  return sessions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function isInsideDesktopProfilePathV2(root, path) {
  const part = relative(root, path);

  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith("../"))
  );
}

export async function assertDesktopProfileOwnedPathV2(path, directory) {
  const info = await lstat(path);

  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (await realpath(path)) !== path ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    throw new Error(
      "Desktop profile adoption requires its exact current filesystem owner",
    );

  return info;
}

export async function inspectDesktopProfileAdoptionTreeV1(
  root,
  migrated = false,
) {
  return (await readDesktopProfileCatalogV2(root, migrated)).sha256;
}

export async function readDesktopProfileCatalogV2(root, migrated = false) {
  const info = await assertDesktopProfileOwnedPathV2(root, true);
  const records = [`root:${info.mode & 0o777}:${info.uid}:${info.gid}`];

  async function visit(path, prefix) {
    const children = (await readdir(path)).sort();
    const directories = [];

    for (let offset = 0; offset < children.length; offset += 4) {
      const results = await Promise.allSettled(
        children.slice(offset, offset + 4).map(async (name) => {
          const key = prefix ? `${prefix}/${name}` : name;

          if (key === markerName && migrated) return null;

          if (key === markerName)
            throw new Error(
              "The source profile already has an application identity marker",
            );
          const file = join(path, name);
          const stat = await lstat(file);

          if (stat.uid !== info.uid)
            throw new Error("Desktop profile contains foreign-owned state");

          const mapped = canonicalDesktopProfilePathV2(key, migrated);

          const metadata = `${stat.mode & 0o777}:${stat.uid}:${stat.gid}`;

          if (stat.isDirectory())
            return {
              record: `directory:${mapped}:${metadata}`,
              directory: { path: file, key },
            };

          if (stat.isFile()) {
            const hash = createHash("sha256");

            for await (const chunk of createReadStream(file))
              hash.update(chunk);

            return {
              record: `file:${mapped}:${metadata}:${hash.digest("hex")}`,
              directory: null,
            };
          }

          if (stat.isSymbolicLink()) {
            const link = await readlink(file);

            if (
              isAbsolute(link) ||
              !isInsideDesktopProfilePathV2(root, resolve(dirname(file), link))
            )
              throw new Error(
                "Desktop profile contains an external symbolic link",
              );

            return { record: `link:${mapped}:${link}`, directory: null };
          }

          throw new Error(
            "Desktop profile contains an active socket or special file",
          );
        }),
      );

      for (const result of results) {
        if (result.status === "rejected") throw result.reason;

        if (result.value === null) continue;
        records.push(result.value.record);

        if (result.value.directory !== null)
          directories.push(result.value.directory);
      }
    }

    for (const directory of directories)
      await visit(directory.path, directory.key);
  }

  await visit(root, "");

  if (process.platform === "darwin") {
    const acl = (await inspectMacStateAclV1(root))
      .filter((record) => !(migrated && record.path === markerName))
      .map((record) => ({
        ...record,
        path: canonicalDesktopProfilePathV2(record.path, migrated),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    records.push(`acl:${sha(JSON.stringify(acl))}`);
  }

  records.sort();

  return { version: 2, records, sha256: sha(records.join("\n")) };
}
