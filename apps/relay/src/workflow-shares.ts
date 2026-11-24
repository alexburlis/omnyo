import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  WORKFLOW_PACKAGE_MAX_BYTES,
  WORKFLOW_SHARE_ID,
} from "omnyo-plugin-automations/workflow-package";

export { WORKFLOW_SHARE_ID } from "omnyo-plugin-automations/workflow-package";

import type { RelayDb } from "./db.js";
import type { RevocationJournalInput } from "./gate/revocation.js";
import { isUserBlocked } from "./user-blocks.js";

export const WORKFLOW_SHARE_MAX_BYTES = WORKFLOW_PACKAGE_MAX_BYTES;

const metadataSchema = z.object({
  id: z.string().regex(WORKFLOW_SHARE_ID),
  title: z.string().max(200),
  description: z.string().max(2000),
  revision: z.number().int(),
  packageDigest: z.string(),
  executionDigest: z.string(),
  capabilities: z.array(z.string()),
  expiresAt: z.number().int(),
});

type WorkflowShareMetadata = z.infer<typeof metadataSchema>;

export function shareOwnerAllowed(db: RelayDb, userId: string): boolean {
  return (
    !isUserBlocked(db, userId) &&
    db.get(
      sql`SELECT 1 FROM user WHERE id = ${userId} AND email_verified = 1`,
    ) !== undefined
  );
}

export function readWorkflowShare(
  db: RelayDb,
  id: string,
  now: number,
): { bytes: Buffer; metadata: WorkflowShareMetadata } | null {
  if (!WORKFLOW_SHARE_ID.test(id)) return null;

  const row = db.get<{ user_id: string; package: Buffer; metadata: string }>(
    sql`SELECT s.user_id, s.package, s.metadata FROM relay_workflow_share s JOIN user u ON u.id = s.user_id WHERE s.id = ${id} AND s.expires_at > ${now} AND u.email_verified = 1`,
  );

  if (!row || isUserBlocked(db, row.user_id)) return null;

  return {
    bytes: row.package,
    metadata: metadataSchema.parse(JSON.parse(row.metadata)),
  };
}

export function listWorkflowShares(
  db: RelayDb,
  userId: string,
  now: number,
): WorkflowShareMetadata[] {
  return db
    .all<{ metadata: string }>(
      sql`SELECT metadata FROM relay_workflow_share WHERE user_id = ${userId} AND expires_at > ${now} ORDER BY created_at DESC`,
    )
    .map((row) => metadataSchema.parse(JSON.parse(row.metadata)));
}

export function revokeWorkflowShare(
  db: RelayDb,
  record: (entry: RevocationJournalInput) => void,
  input: { id: string; userId: string; now: number },
): boolean {
  if (
    !WORKFLOW_SHARE_ID.test(input.id) ||
    !db.get(
      sql`SELECT 1 FROM relay_workflow_share WHERE id = ${input.id} AND user_id = ${input.userId}`,
    )
  )
    return false;
  record({
    kind: "workflow-share",
    id: input.id,
    userId: input.userId,
    at: input.now,
  });
  db.run(
    sql`DELETE FROM relay_workflow_share WHERE id = ${input.id} AND user_id = ${input.userId}`,
  );

  return true;
}
