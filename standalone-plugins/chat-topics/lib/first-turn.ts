import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";

const markerSchema = z.object({ createdAt: z.number().int().nonnegative() });

export function createFirstTurnLedger(api: Pick<PluginApi, "storage" | "log">) {
  const suppressed = new Set<string>();

  const statements = (() => {
    try {
      const database = api.storage.database();
      database.pragma("busy_timeout = 0");
      api.storage.migrate(database, [
        "CREATE TABLE naming_eligibility (thread_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
      ]);

      return {
        read: database.prepare<[string], unknown>(
          "SELECT created_at AS createdAt FROM naming_eligibility WHERE thread_id = ?",
        ),
        grant: database.prepare<[string, number]>(
          "INSERT INTO naming_eligibility (thread_id, created_at) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET created_at = excluded.created_at",
        ),
        retire: database.prepare<[string]>("DELETE FROM naming_eligibility WHERE thread_id = ?"),
      };
    } catch {
      api.log.warn(
        "Automatic naming is unavailable because its local eligibility store could not open. Chats can still start.",
      );

      return null;
    }
  })();

  function suppress(threadId: string) {
    if (suppressed.has(threadId)) return;
    suppressed.add(threadId);
    api.log.warn(
      "Automatic naming was disabled for a chat because its local eligibility store failed. The chat can still start.",
    );
  }

  return {
    read(threadId: string) {
      if (statements === null || suppressed.has(threadId)) return null;

      try {
        const row = statements.read.get(threadId);

        return row === undefined ? null : markerSchema.parse(row);
      } catch {
        suppress(threadId);

        return null;
      }
    },
    grant(threadId: string, createdAt: number) {
      if (statements === null || suppressed.has(threadId)) return;

      try {
        statements.grant.run(threadId, createdAt);
      } catch {
        suppress(threadId);
      }
    },
    retire(threadId: string) {
      if (statements === null) return;

      try {
        statements.retire.run(threadId);
        suppressed.delete(threadId);
      } catch {
        suppress(threadId);
      }
    },
  };
}
