import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  threadScope,
  turnScope,
  type Thread,
  type ThreadEventItemType,
  type ThreadEventType,
} from "@omnyo/domain";
import {
  createConnection,
  createProject,
  createThread,
  getLatestThreadSequence,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";

export type Random = () => number;

export interface TestThread {
  coldDb: DbConnection;
  db: DbConnection;
  projectId: string;
  thread: Thread;
}

export interface RowSpec {
  data?: Record<string, unknown>;
  itemId?: string | null;
  itemKind?: ThreadEventItemType | null;
  parentToolCallId?: string | null;
  providerThreadId?: string | null;
  turnId?: string | null;
  type: ThreadEventType;
}

export const PROVIDER_THREAD_ID = "provider-memo";

let migratedImage: Buffer | null = null;

function readMigratedImage(): Buffer {
  if (migratedImage === null) {
    const db = createConnection(":memory:");
    migrate(db);
    migratedImage = db.$client.serialize();
    db.$client.close();
  }

  return migratedImage;
}

export function withTestThread(run: (testThread: TestThread) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnyo-timeline-cache-"));
  const file = path.join(dir, "app.db");
  fs.writeFileSync(file, readMigratedImage());
  const db = createConnection(file);
  const coldDb = createConnection(file);

  try {
    const host = upsertHost(db, noopNotifier, { name: "timeline-cache-host" });

    const { project } = createProject(db, noopNotifier, {
      name: "timeline-cache-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/memo" },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });

    run({ coldDb, db, projectId: project.id, thread });
  } finally {
    coldDb.$client.close();
    db.$client.close();
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

export function appendRows(
  testThread: Pick<TestThread, "db" | "thread">,
  specs: readonly RowSpec[],
): number {
  const threadId = testThread.thread.id;
  const start = getLatestThreadSequence(testThread.db, { threadId });
  insertEvents(
    testThread.db,
    noopNotifier,
    specs.map((spec, index) => {
      const sequence = start + index + 1;
      const turnId = spec.turnId ?? null;

      return {
        createdAt: 1_800_000_000_000 + sequence * 1_000,
        data: JSON.stringify(spec.data ?? {}),
        itemId: spec.itemId ?? null,
        itemKind: spec.itemKind ?? null,
        parentToolCallId: spec.parentToolCallId ?? null,
        providerThreadId:
          spec.providerThreadId === undefined
            ? turnId === null
              ? null
              : PROVIDER_THREAD_ID
            : spec.providerThreadId,
        scope: turnId === null ? threadScope() : turnScope(turnId),
        sequence,
        threadId,
        type: spec.type,
      };
    }),
  );

  return start + specs.length;
}

export function createRandom(seed: number): Random {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function randomInteger(
  random: Random,
  min: number,
  max: number,
): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: Random, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];

  if (value === undefined) {
    throw new Error("Expected a non-empty choice list");
  }

  return value;
}

export function countSelectedEventRows(
  db: DbConnection,
  run: () => void,
): number {
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  const restores = new Map<object, () => void>();
  let count = 0;
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);

      if (
        !restores.has(statement) &&
        source.includes('from "events"') &&
        source.includes('"created_at"')
      ) {
        const unwrapped = statement.all;
        const originalAll = unwrapped.bind(statement);

        restores.set(statement, () => {
          statement.all = unwrapped;
        });
        statement.all = function (...params: unknown[]) {
          const rows = originalAll(...params);
          count += rows.length;

          return rows;
        };
      }

      return statement;
    },
  });

  try {
    run();
  } finally {
    raw.prepare = originalPrepare;

    for (const restore of restores.values()) restore();
  }

  return count;
}
