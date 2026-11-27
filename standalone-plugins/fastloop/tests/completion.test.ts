import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  CompletionOutbox,
  completionRecordSchema,
  type CompletionInput,
  type CompletionPort,
  type CompletionRecord,
  type ReceiptEvent,
} from "../completion.js";

interface ThreadContext {
  id: string;
  projectId: string | null;
  archived: boolean;
}

interface SentCompletion {
  threadId: string;
  text: string;
}

class SqlitePort implements CompletionPort {
  readonly db = new DatabaseSync(":memory:");
  readonly sent: SentCompletion[] = [];
  readonly states: CompletionRecord["state"][] = [];
  readonly eventCursors: number[] = [];
  context: ThreadContext = { id: "owner-thread", projectId: "owner-project", archived: false };
  messages: string[] = [];
  history: ReceiptEvent[] = [];
  sendEntered = Promise.withResolvers<void>();
  sendHandler: CompletionPort["send"] = async () => true;
  beforeSave?: (entry: CompletionRecord) => Promise<void>;

  constructor() {
    this.db.exec("CREATE TABLE completions (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    this.db.exec("CREATE TABLE stopped_completions (run_id TEXT PRIMARY KEY)");
  }
  async suppress(runId: string): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO stopped_completions VALUES (?)").run(runId);
  }
  async isSuppressed(runId: string): Promise<boolean> {
    return (
      this.db.prepare("SELECT 1 FROM stopped_completions WHERE run_id=?").get(runId) !== undefined
    );
  }
  async load(runId: string): Promise<CompletionRecord | undefined> {
    const row = z
      .object({ payload: z.string() })
      .optional()
      .parse(this.db.prepare("SELECT payload FROM completions WHERE run_id=?").get(runId));

    return row ? completionRecordSchema.parse(JSON.parse(row.payload)) : undefined;
  }
  async save(input: CompletionRecord): Promise<void> {
    const entry = completionRecordSchema.parse(input);
    await this.beforeSave?.(entry);
    this.db
      .prepare(
        "INSERT INTO completions(run_id,payload) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(entry.runId, JSON.stringify(entry));
    this.states.push(entry.state);
  }
  async entries(): Promise<CompletionRecord[]> {
    const rows = z
      .array(z.object({ payload: z.string() }))
      .parse(this.db.prepare("SELECT payload FROM completions ORDER BY run_id").all());

    return rows.map((row) => completionRecordSchema.parse(JSON.parse(row.payload)));
  }
  async thread(): Promise<ThreadContext> {
    return { ...this.context };
  }
  async checkpoint(): Promise<number> {
    return 42;
  }
  async queued(): Promise<string[]> {
    return [...this.messages];
  }
  async events(_threadId: string, after: number): Promise<ReceiptEvent[]> {
    this.eventCursors.push(after);

    return this.history.filter((event) => event.sequence > after).slice(0, 100);
  }
  async send(threadId: string, text: string): Promise<boolean> {
    this.sent.push({ threadId, text });
    this.sendEntered.resolve();

    return this.sendHandler(threadId, text);
  }
}

const input: CompletionInput = {
  runId: "owned-run",
  threadId: "owner-thread",
  projectId: "owner-project",
  summary: "Required settings checks passed; evidence is available.",
};

const ports: SqlitePort[] = [];

const boxes: CompletionOutbox[] = [];

function port(): SqlitePort {
  const value = new SqlitePort();
  ports.push(value);

  return value;
}

function box(store: SqlitePort): CompletionOutbox {
  const value = new CompletionOutbox(store);
  boxes.push(value);

  return value;
}

afterEach(async () => {
  for (const value of boxes.splice(0)) await value.close();

  for (const store of ports.splice(0)) store.db.close();
});

async function uncertain(store: SqlitePort): Promise<string> {
  store.sendHandler = async () => false;
  const owner = box(store);
  await owner.enqueue(input);
  await owner.drain();
  await owner.close();
  expect((await store.load(input.runId))?.state).toBe("uncertain");

  return store.sent[0]?.text ?? "";
}

it("persists queued and sending checkpoints in real SQLite before the single SDK send", async () => {
  const store = port();
  const owner = box(store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  store.beforeSave = async (entry) => {
    if (entry.state === "sending") {
      entered.resolve();
      await release.promise;
    }
  };

  await owner.enqueue(input);
  const draining = owner.drain();
  await entered.promise;

  try {
    expect((await store.load(input.runId))?.state).toBe("queued");
    expect(store.sent).toHaveLength(0);
  } finally {
    release.resolve();
  }

  store.sendHandler = async () => {
    expect(await store.load(input.runId)).toMatchObject({ state: "sending", checkpoint: 42 });

    return true;
  };

  await draining;
  expect(store.states).toEqual(["queued", "sending", "delivered"]);
  expect(store.sent).toHaveLength(1);
  expect(store.sent[0]).toMatchObject({ threadId: input.threadId });
  expect(store.sent[0]?.text).toContain(input.runId);
  expect(store.sent[0]?.text).toContain(input.summary);
});

it("duplicate enqueues, concurrent drains and reload preserve exactly one completion callback", async () => {
  const store = port();
  const owner = box(store);
  await Promise.all([owner.enqueue(input), owner.enqueue(input), owner.drain(), owner.drain()]);
  await owner.close();
  const reloaded = box(store);
  await reloaded.enqueue(input);
  await Promise.all([reloaded.drain(), reloaded.drain()]);
  expect(store.sent).toHaveLength(1);
  expect(await store.entries()).toHaveLength(1);
  expect((await store.load(input.runId))?.state).toBe("delivered");
});

it("a Stop before enqueue suppresses its callback across reload without blocking another run", async () => {
  const store = port();
  const owner = box(store);
  await owner.suppress(input.runId);
  await owner.enqueue(input);
  await owner.enqueue({ ...input, runId: "other-run" });
  await owner.drain();
  await box(store).drain();
  expect((await owner.status(input.runId))?.state).toBe("suppressed");
  expect(store.sent).toHaveLength(1);
  expect(store.sent[0]?.text).toContain("other-run");
});

it("Stop with no outbox entry survives reload before a terminal producer enqueues", async () => {
  const store = port();
  const first = box(store);
  await first.suppress(input.runId);
  expect(await first.status(input.runId)).toBeUndefined();
  await first.close();
  const reloaded = box(store);
  await reloaded.enqueue(input);
  await reloaded.drain();
  expect((await reloaded.status(input.runId))?.state).toBe("suppressed");
  expect(store.sent).toHaveLength(0);
});

it("Stop races a pending sending-record write without allowing a later SDK send", async () => {
  const store = port();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  store.beforeSave = async (entry) => {
    if (entry.state === "sending") {
      entered.resolve();
      await release.promise;
    }
  };

  const owner = box(store);
  await owner.enqueue(input);
  const draining = owner.drain();
  await entered.promise;

  try {
    await owner.suppress(input.runId);
  } finally {
    release.resolve();
  }

  await draining;
  expect((await owner.status(input.runId))?.state).toBe("suppressed");
  await box(store).drain();
  expect(store.sent).toHaveLength(0);
});

it("Stop retains uncertainty for an already dispatched send even after a late acknowledgement", async () => {
  const store = port();
  const acknowledgement = Promise.withResolvers<boolean>();
  store.sendHandler = () => acknowledgement.promise;
  const owner = box(store);
  await owner.enqueue(input);
  const draining = owner.drain();
  await store.sendEntered.promise;
  await owner.suppress(input.runId);
  expect((await owner.status(input.runId))?.state).toBe("uncertain");
  await box(store).drain();
  acknowledgement.resolve(true);
  await draining;
  expect((await owner.status(input.runId))?.state).toBe("uncertain");
  expect(store.sent).toHaveLength(1);
});

for (const failure of ["false", "throw"] as const)
  it(`an SDK ${failure} outcome stays uncertain across reload without blindly resending`, async () => {
    const store = port();
    store.sendHandler = async () => {
      if (failure === "throw") throw new Error("UNCERTAIN_SDK_FAILURE");

      return false;
    };

    const owner = box(store);
    await owner.enqueue(input);
    await owner.drain();
    await owner.close();
    const reloaded = box(store);
    await reloaded.drain();
    await reloaded.drain();
    expect(store.sent).toHaveLength(1);
    expect((await store.load(input.runId))?.state).toBe("uncertain");
  });

it("close interrupts a nonresponsive send wait while a late SDK acknowledgement cannot trigger another callback", async () => {
  const store = port();
  const acknowledgement = Promise.withResolvers<boolean>();
  store.sendHandler = () => acknowledgement.promise;
  const owner = box(store);
  await owner.enqueue(input);
  const draining = owner.drain();
  await store.sendEntered.promise;
  await owner.close();
  await draining;
  expect((await store.load(input.runId))?.state).toBe("uncertain");
  acknowledgement.resolve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await store.load(input.runId))?.state).toBe("uncertain");
  await box(store).drain();
  expect(store.sent).toHaveLength(1);
});

it("a persisted uncertain receipt found in the actual queued text reconciles without another send", async () => {
  const store = port();
  const text = await uncertain(store);
  store.messages = ["Unrelated queued message", text];
  await box(store).drain();
  expect((await store.load(input.runId))?.state).toBe("delivered");
  expect(store.sent).toHaveLength(1);
  expect(store.eventCursors).toHaveLength(0);
});

it("requested text plus matching accepted request across ascending pages reconciles exactly once", async () => {
  const store = port();
  const text = await uncertain(store);
  store.history = [
    { kind: "requested", sequence: 43, requestId: "receipt-request", texts: [text] },
    ...Array.from({ length: 99 }, (_, index): ReceiptEvent => ({
      kind: "accepted",
      sequence: 44 + index,
      requestId: `unrelated-${index}`,
    })),
    { kind: "accepted", sequence: 143, requestId: "receipt-request" },
  ];
  await box(store).drain();
  expect((await store.load(input.runId))?.state).toBe("delivered");
  expect(store.eventCursors).toEqual([42, 142]);
  expect(store.sent).toHaveLength(1);
});

for (const kind of ["requested-only", "unrelated-acceptance", "rejected"] as const)
  it(`${kind} history cannot promote uncertain delivery or authorize a resend`, async () => {
    const store = port();
    const text = await uncertain(store);
    store.history = [
      { kind: "requested", sequence: 43, requestId: "receipt-request", texts: [text] },
    ];

    if (kind === "unrelated-acceptance")
      store.history.push({ kind: "accepted", sequence: 44, requestId: "different-request" });

    if (kind === "rejected")
      store.history.push({ kind: "rejected", sequence: 44, requestId: "receipt-request" });
    await box(store).drain();
    expect((await store.load(input.runId))?.state).toBe("uncertain");
    expect(store.sent).toHaveLength(1);
  });

it("event page exhaustion remains uncertain when acceptance exists beyond the bounded history window", async () => {
  const store = port();
  const text = await uncertain(store);
  store.history = [
    { kind: "requested", sequence: 43, requestId: "receipt-request", texts: [text] },
    ...Array.from({ length: 999 }, (_, index): ReceiptEvent => ({
      kind: "accepted",
      sequence: 44 + index,
      requestId: `other-${index}`,
    })),
    { kind: "accepted", sequence: 1043, requestId: "receipt-request" },
  ];
  await box(store).drain();
  expect(store.eventCursors).toHaveLength(10);
  expect(store.eventCursors.at(-1)).toBe(942);
  expect((await store.load(input.runId))?.state).toBe("uncertain");
  expect(store.sent).toHaveLength(1);
});

for (const reason of ["wrong-thread", "wrong-project", "archived"] as const)
  it(`${reason} owner context suppresses callbacks`, async () => {
    const store = port();

    if (reason === "wrong-thread") store.context.id = "different-thread";

    if (reason === "wrong-project") store.context.projectId = "different-project";

    if (reason === "archived") store.context.archived = true;
    const owner = box(store);
    await owner.enqueue(input);
    await owner.drain();
    expect(store.sent).toHaveLength(0);
    expect((await store.load(input.runId))?.state).toBe("suppressed");
  });

it("the same run cannot be rebound to another thread, project or summary", async () => {
  const store = port();
  const owner = box(store);
  await owner.enqueue(input);

  for (const changed of [
    { ...input, threadId: "other-thread" },
    { ...input, projectId: "other-project" },
    { ...input, summary: "Different completion" },
  ])
    await expect(owner.enqueue(changed)).rejects.toThrow("COMPLETION_CONTEXT_CONFLICT");
  expect(await store.entries()).toHaveLength(1);
  expect(await store.load(input.runId)).toMatchObject(input);
  expect(store.sent).toHaveLength(0);
});

it("close before work never sends and rejects later enqueue", async () => {
  const store = port();
  const owner = box(store);
  await owner.close();
  await expect(owner.enqueue(input)).rejects.toThrow("COMPLETION_CLOSED");
  await owner.drain();
  expect(await store.entries()).toHaveLength(0);
  expect(store.sent).toHaveLength(0);
});
