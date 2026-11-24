import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import { noopNotifier } from "../../src/notifier.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { ensureProjectAttachmentBackfill } from "../../src/data/project-attachment-backfill.js";
import {
  acquireProjectAttachmentOwnership,
  acquireProjectAttachmentReferences,
  claimProjectAttachments,
  copyProjectAttachmentOwnership,
  PROJECT_ATTACHMENT_GRACE_MS,
  recordProjectAttachment,
} from "../../src/data/project-attachments.js";
import {
  projectAttachmentBackfills,
  projectAttachments,
  projectAttachmentThreads,
  threads,
} from "../../src/schema.js";

function fixture() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "retention-host" });

  const owner = createProject(db, noopNotifier, {
    name: "owner",
    source: { type: "local_path", hostId: host.id, path: "/owner" },
  }).project;

  const source = createProject(db, noopNotifier, {
    name: "images",
    source: { type: "local_path", hostId: host.id, path: "/images" },
  }).project;

  const thread = createThread(db, noopNotifier, {
    projectId: owner.id,
    providerId: "codex",
  });

  const attachment = recordProjectAttachment(db, {
    projectId: source.id,
    storedPath: "result.png",
    originalName: "result.png",
    mimeType: "image/png",
    sizeBytes: 8,
    createdAt: Date.now() - PROJECT_ATTACHMENT_GRACE_MS - 1000,
    readyAt: Date.now(),
  });

  ensureProjectAttachmentBackfill(db, source.id);
  db.update(projectAttachmentBackfills)
    .set({ phase: "done" })
    .where(eq(projectAttachmentBackfills.projectId, source.id))
    .run();

  return { db, owner, source, thread, attachment };
}

describe("explicit project attachment retention", () => {
  it("retains a foreign-project image through same-project forks until the last owning thread is deleted", () => {
    const { db, owner, source, thread, attachment } = fixture();

    try {
      expect(() =>
        acquireProjectAttachmentOwnership(db, thread.id, [
          attachment.storedPath,
        ]),
      ).toThrow("not uploaded");
      const reference = { projectId: source.id, path: attachment.storedPath };
      acquireProjectAttachmentReferences(db, thread.id, [reference, reference]);
      acquireProjectAttachmentReferences(db, thread.id, [reference]);
      expect(db.select().from(projectAttachmentThreads).all()).toEqual([
        { attachmentId: attachment.id, threadId: thread.id },
      ]);
      expect(claimProjectAttachments(db, source.id, Date.now())).toEqual([]);

      const fork = createThread(db, noopNotifier, {
        projectId: owner.id,
        providerId: "codex",
      });

      copyProjectAttachmentOwnership(db, thread.id, fork.id);
      db.delete(threads).where(eq(threads.id, thread.id)).run();
      expect(claimProjectAttachments(db, source.id, Date.now())).toEqual([]);
      db.delete(threads).where(eq(threads.id, fork.id)).run();
      expect(
        claimProjectAttachments(db, source.id, Date.now()).map((row) => row.id),
      ).toEqual([attachment.id]);
    } finally {
      db.$client.close();
    }
  });

  it.each(["missing", "pending", "deletion-claimed"] as const)(
    "rejects a %s reference atomically without protecting another valid file",
    (state) => {
      const { db, source, thread, attachment } = fixture();

      try {
        const second = recordProjectAttachment(db, {
          projectId: source.id,
          storedPath: "other.png",
          originalName: "other.png",
          mimeType: "image/png",
          sizeBytes: 8,
          createdAt: attachment.createdAt,
          readyAt: state === "pending" ? null : Date.now(),
        });

        if (state === "deletion-claimed")
          db.update(projectAttachments)
            .set({ deletionClaimedAt: Date.now() })
            .where(eq(projectAttachments.id, second.id))
            .run();
        expect(() =>
          acquireProjectAttachmentReferences(db, thread.id, [
            { projectId: source.id, path: attachment.storedPath },
            {
              projectId: source.id,
              path: state === "missing" ? "missing.png" : second.storedPath,
            },
          ]),
        ).toThrow();
        expect(db.select().from(projectAttachmentThreads).all()).toEqual([]);
      } finally {
        db.$client.close();
      }
    },
  );
});
