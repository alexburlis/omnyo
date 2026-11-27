// Core-shaped thread history for runner and coordinator tests. Rows follow the
// SDK's ThreadEventRow contract and the GET /threads/:id/events semantics: typed
// filters, exclusive cursors, ascending default order and a limit per type that
// is applied before the merge.

type TurnEventType = "turn/started" | "turn/completed" | "system/thread/interrupted";

type TurnStatus = "completed" | "failed" | "interrupted";

type InterruptReason = "manual-stop" | "host-removed" | "host-daemon-restarted";

type EventScope = { kind: "thread" } | { kind: "turn"; turnId: string };

type EventData = {
  providerThreadId?: string | null;
  parentToolCallId?: string;
  status?: TurnStatus;
  reason?: InterruptReason;
};

export type TurnEventRow = {
  id: string;
  scope: EventScope;
  threadId: string;
  seq: number;
  createdAt: number;
  type: TurnEventType;
  data: EventData;
};

export type EventsListInput = {
  threadId: string;
  types?: readonly string[];
  order?: "asc" | "desc";
  limit?: string;
  afterSeq?: string;
  beforeSeq?: string;
};

export class TurnHistory {
  private rows: TurnEventRow[] = [];
  private nextSeq = 1;
  private nextTurn = 1;

  append(threadId: string, type: TurnEventType, scope: EventScope, data: EventData) {
    const seq = this.nextSeq++;

    const row: TurnEventRow = {
      id: "evt_" + seq,
      scope,
      threadId,
      seq,
      createdAt: 1_792_000_000_000 + seq,
      type,
      data,
    };

    this.rows.push(row);

    return row;
  }

  started(threadId: string, turnId: string, parentToolCallId?: string) {
    const data: EventData = { providerThreadId: "provider_" + threadId };

    if (parentToolCallId) data.parentToolCallId = parentToolCallId;

    return this.append(threadId, "turn/started", { kind: "turn", turnId }, data);
  }

  completed(threadId: string, turnId: string, status: TurnStatus) {
    return this.append(
      threadId,
      "turn/completed",
      { kind: "turn", turnId },
      { providerThreadId: "provider_" + threadId, status },
    );
  }

  interrupted(threadId: string, reason: InterruptReason) {
    return this.append(threadId, "system/thread/interrupted", { kind: "thread" }, { reason });
  }

  turnId() {
    return "turn_" + this.nextTurn++;
  }

  // A root turn that ended normally.
  completedTurn(threadId: string) {
    const turnId = this.turnId();
    this.started(threadId, turnId);

    return this.completed(threadId, turnId, "completed");
  }

  // Manual stop path: the stop request records the reason before the turn settles.
  stoppedTurn(threadId: string) {
    const turnId = this.turnId();
    this.started(threadId, turnId);
    this.interrupted(threadId, "manual-stop");

    return this.completed(threadId, turnId, "interrupted");
  }

  // Host path: the synthetic interrupted completion precedes the reason.
  hostInterruptedTurn(threadId: string, reason: InterruptReason) {
    const turnId = this.turnId();
    this.started(threadId, turnId);
    const completion = this.completed(threadId, turnId, "interrupted");
    this.interrupted(threadId, reason);

    return completion;
  }

  // A stop requested while the turn was already finishing naturally.
  racedStopTurn(threadId: string) {
    const turnId = this.turnId();
    this.started(threadId, turnId);
    this.interrupted(threadId, "manual-stop");

    return this.completed(threadId, turnId, "completed");
  }

  // A subagent turn: core stores it, but it never changes the thread's state.
  nestedTurn(threadId: string, status: TurnStatus) {
    const turnId = this.turnId();
    this.started(threadId, turnId, "call_" + turnId);

    return this.completed(threadId, turnId, status);
  }

  // A root turn that started and has no recorded outcome yet.
  openTurn(threadId: string) {
    return this.started(threadId, this.turnId());
  }

  list(input: EventsListInput) {
    const after = input.afterSeq === undefined ? null : Number(input.afterSeq);
    const before = input.beforeSeq === undefined ? null : Number(input.beforeSeq);
    const limit = input.limit === undefined ? 100 : Math.min(100, Number(input.limit));
    const descending = input.order === "desc";

    const select = (rows: TurnEventRow[]) => {
      const ordered = rows
        .filter(
          (row) =>
            row.threadId === input.threadId &&
            (after === null || row.seq > after) &&
            (before === null || row.seq < before),
        )
        .sort((left, right) => (descending ? right.seq - left.seq : left.seq - right.seq));

      return ordered.slice(0, limit);
    };

    if (!input.types?.length) return select(this.rows);

    const merged = input.types.flatMap((type) =>
      select(this.rows.filter((row) => row.type === type)),
    );

    return merged.sort((left, right) => (descending ? right.seq - left.seq : left.seq - right.seq));
  }
}

// Lets fire-and-forget plugin event handlers finish before absence assertions.
export async function settle() {
  for (let tick = 0; tick < 25; tick++) await new Promise((resolve) => setImmediate(resolve));
}
