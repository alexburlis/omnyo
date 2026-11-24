import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@omnyo/domain";
import {
  getThreadTimelineRecord,
  putThreadTimelineRecord,
} from "../../src/data/timeline-derived-cache.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

describe("bounded derived timeline records", () => {
  it("shares root/page limits, orders tied evictions, removes oversized replacements and rolls back failed writes", () => {
    const db = createMigratedConnection();

    const thread = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
    });

    const limits = { maxBytes: 8, maxEntries: 3, maxEntryBytes: 8 };

    const put = (
      key: string,
      body: string,
      kind: "page" | "root",
      threadId = thread.id,
    ) =>
      putThreadTimelineRecord(
        db,
        { key, body, kind, threadId, createdAt: 10, expiresAt: null },
        limits,
      );

    const get = (key: string) => getThreadTimelineRecord(db, { key, now: 11 });

    const epoch = () =>
      db.$client
        .prepare("SELECT epoch FROM thread_history_epochs WHERE thread_id = ?")
        .get(thread.id);

    try {
      const before = epoch();
      put("z", "root", "root");
      put("a", "page", "page");
      put("m", "m", "page");
      expect(get("a")).toBeNull();
      expect(get("z")).toMatchObject({ body: "root", kind: "root" });
      expect(get("m")?.body).toBe("m");
      put("z", "x".repeat(9), "root");
      expect(get("z")).toBeNull();
      expect(get("m")?.body).toBe("m");
      expect(() => put("m", "new", "page", "missing-thread")).toThrow();
      expect(get("m")?.body).toBe("m");
      expect(epoch()).toEqual(before);
      expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("bounds UTF8 bytes and count, replaces accounting, and expires without changing history", () => {
    const db = createMigratedConnection();
    const host = upsertHost(db, noopNotifier, { name: "derived-cache-host" });

    const { project } = createProject(db, noopNotifier, {
      name: "derived-cache-project",
      source: { type: "local_path", hostId: host.id, path: "/inert/cache" },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const limits = { maxBytes: 24, maxEntries: 2, maxEntryBytes: 16 };

    const put = (
      key: string,
      body: string,
      now: number,
      expiresAt: number | null = null,
    ) =>
      putThreadTimelineRecord(
        db,
        {
          key,
          threadId: thread.id,
          body,
          kind: "page",
          createdAt: now,
          expiresAt,
        },
        limits,
      );

    const get = (key: string, now: number) =>
      getThreadTimelineRecord(db, { key, now });

    try {
      put("a", "🦊".repeat(3), 10);
      put("b", "b".repeat(12), 11);
      expect(get("a", 12)?.body).toBe("🦊".repeat(3));
      put("c", "c".repeat(12), 12);
      expect(get("a", 12)).toBeNull();
      expect(get("b", 12)?.body).toHaveLength(12);
      put("c", "c", 13);
      put("d", "d", 14, 20);
      expect(get("b", 14)).toBeNull();
      expect(get("c", 14)?.body).toBe("c");
      expect(get("d", 19)?.body).toBe("d");
      expect(get("d", 20)).toBeNull();
      expect(get("d", 13)).toBeNull();
      put("oversized", "🦊".repeat(5), 15);
      expect(get("oversized", 16)).toBeNull();
      expect(get("c", 16)?.body).toBe("c");
      expect(
        db.$client.prepare("SELECT count(*) AS count FROM events").get(),
      ).toEqual({ count: 0 });
      db.$client.prepare("DELETE FROM threads WHERE id = ?").run(thread.id);
      expect(get("c", 16)).toBeNull();
    } finally {
      db.$client.close();
    }
  });
});
