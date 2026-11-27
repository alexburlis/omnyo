import { inArray } from "drizzle-orm";
import { queuedThreadMessages, type DbConnection } from "@omnyo/db";

export class ThreadWorkFacts {
  private readonly covered = new Set<string>();
  readonly queue = new Map<string, ReturnType<typeof readQueuedWorkFacts>>();

  constructor(private readonly db: DbConnection) {}

  ensure(threadIds: readonly string[]): void {
    const missing = [...new Set(threadIds)].filter(
      (id) => !this.covered.has(id),
    );

    for (let offset = 0; offset < missing.length; offset += 400) {
      const batch = missing.slice(offset, offset + 400);

      for (const row of readQueuedWorkFacts(this.db, batch)) {
        const entries = this.queue.get(row.threadId) ?? [];
        entries.push(row);
        this.queue.set(row.threadId, entries);
      }

      for (const id of batch) this.covered.add(id);
    }
  }
}

function readQueuedWorkFacts(db: DbConnection, threadIds: string[]) {
  return db
    .select({
      id: queuedThreadMessages.id,
      threadId: queuedThreadMessages.threadId,
      sendAt: queuedThreadMessages.sendAt,
      failureReason: queuedThreadMessages.failureReason,
      waitingOn: queuedThreadMessages.waitingOn,
      payloadKind: queuedThreadMessages.payloadKind,
      senderThreadId: queuedThreadMessages.senderThreadId,
      requestedByInitiator: queuedThreadMessages.requestedByInitiator,
      systemNotice: queuedThreadMessages.systemNotice,
    })
    .from(queuedThreadMessages)
    .where(inArray(queuedThreadMessages.threadId, threadIds))
    .all();
}
