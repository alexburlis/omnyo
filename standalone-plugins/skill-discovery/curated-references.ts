import { createHash, randomUUID } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { packDigestSchema } from "./pack.ts";

export const curatedReferenceMigration =
  "CREATE TABLE curated_use_once (reference TEXT PRIMARY KEY, entry_id TEXT NOT NULL, digest TEXT NOT NULL, content TEXT NOT NULL, expires INTEGER NOT NULL)";

const referenceLifetime = 30 * 24 * 60 * 60 * 1000;

const maximumReferences = 256;

const maximumContentBytes = 64 * 1024;

const referenceRow = z.object({
  reference: z.uuid(),
  entry_id: z.string(),
  digest: packDigestSchema,
  content: z.string(),
  expires: z.number(),
});

export function createCuratedReferences(
  db: ReturnType<PluginApi["storage"]["database"]>,
  now = Date.now,
) {
  const get = db.prepare(
    "SELECT reference, entry_id, digest, content, expires FROM curated_use_once WHERE reference = ?",
  );

  const find = db.prepare(
    "SELECT reference, entry_id, digest, content, expires FROM curated_use_once WHERE entry_id = ? AND digest = ? AND expires > ? LIMIT 1",
  );

  const removeExpired = db.prepare("DELETE FROM curated_use_once WHERE expires <= ?");
  const count = db.prepare("SELECT COUNT(*) AS total FROM curated_use_once");

  const insert = db.prepare(
    "INSERT INTO curated_use_once (reference, entry_id, digest, content, expires) VALUES (?, ?, ?, ?, ?)",
  );

  const renew = db.prepare("UPDATE curated_use_once SET expires = ? WHERE reference = ?");
  const countRow = z.object({ total: z.number().int() });

  const prepare = db.transaction((entryId: string, content: string, digest: string) => {
    if (Buffer.byteLength(content, "utf8") > maximumContentBytes)
      throw new Error("This skill is too large for one-time use. Install it instead.");

    if (createHash("sha256").update(content).digest("hex") !== digest)
      throw new Error("The skill instructions changed. Refresh the catalog and try again.");

    const timestamp = now();
    removeExpired.run(timestamp);
    const existing = find.get(entryId, digest, timestamp);

    if (existing !== undefined) {
      const value = referenceRow.parse(existing);
      renew.run(timestamp + referenceLifetime, value.reference);

      return { reference: value.reference };
    }

    if (countRow.parse(count.get()).total >= maximumReferences)
      throw new Error(
        "Too many skills are prepared for one-time use. Try again after older drafts expire.",
      );

    const reference = randomUUID();
    insert.run(reference, entryId, digest, content, timestamp + referenceLifetime);

    return { reference };
  });

  return {
    prepare,
    lookup(entryId: string, digest: string) {
      const row = referenceRow.safeParse(find.get(entryId, digest, now()));

      return row.success ? row.data.reference : null;
    },
    resolve(reference: string) {
      const row = referenceRow.safeParse(get.get(reference));

      if (!row.success || row.data.expires <= now())
        throw new Error(
          "This one-time skill expired. Remove its pill and add it again from Find skills.",
        );

      if (createHash("sha256").update(row.data.content).digest("hex") !== row.data.digest)
        throw new Error(
          "This one-time skill changed. Remove its pill and add it again from Find skills.",
        );

      renew.run(now() + referenceLifetime, reference);

      return { context: row.data.content };
    },
  };
}
