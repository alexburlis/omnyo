import { z } from "zod";
import {
  SEND_OUTBOX_DATABASE,
  SEND_OUTBOX_DATABASE_VERSION,
  SEND_OUTBOX_ENTRIES_STORE,
} from "./send-outbox-database";
import {
  outboxEntrySchema,
  type NewOutboxEntry,
  type OutboxEntry,
  type OutboxEntryState,
} from "./send-outbox-entry";

const ENTRIES_STORE = SEND_OUTBOX_ENTRIES_STORE;

const ALIASES_STORE = "aliases";

const META_STORE = "meta";

const KNOWN_STORE_ID_KEY = "known-store-id";

const CHANGE_CHANNEL = "omnyo-send-outbox-v1";

const aliasRecordSchema = z.object({
  pendingChatId: z.string().min(1),
  threadId: z.string().min(1),
});

const knownStoreIdRecordSchema = z.object({
  key: z.literal(KNOWN_STORE_ID_KEY),
  storeId: z.string().min(1),
});

export interface OutboxChatAlias {
  pendingChatId: string;
  threadId: string;
}

export interface SendOutboxStore {
  stage(entry: NewOutboxEntry): Promise<OutboxEntry>;
  list(): Promise<OutboxEntry[]>;
  count(): Promise<number>;
  recordUpload(args: {
    path: string;
    submissionId: string;
    token: string;
  }): Promise<void>;
  setState(submissionId: string, state: OutboxEntryState): Promise<void>;
  reset(submissionId: string): Promise<void>;
  discard(submissionId: string): Promise<void>;
  settle(args: {
    alias: OutboxChatAlias | null;
    submissionId: string;
  }): Promise<void>;
  readAlias(pendingChatId: string): Promise<string | null>;
  readKnownStoreId(): Promise<string | null>;
  rememberStoreId(storeId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

function requestResult<TValue>(request: IDBRequest<TValue>): Promise<TValue> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("The send outbox request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("The send outbox write failed"));
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("The send outbox write was aborted"),
      );
  });
}

function openSendOutboxDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no storage for waiting messages"));

      return;
    }

    const request = indexedDB.open(
      SEND_OUTBOX_DATABASE,
      SEND_OUTBOX_DATABASE_VERSION,
    );

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(ENTRIES_STORE)) {
        database
          .createObjectStore(ENTRIES_STORE, { keyPath: "submissionId" })
          .createIndex("sequence", "sequence", { unique: true });
      }

      if (!database.objectStoreNames.contains(ALIASES_STORE)) {
        database.createObjectStore(ALIASES_STORE, { keyPath: "pendingChatId" });
      }

      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("The send outbox could not be opened"));
    request.onblocked = () =>
      reject(new Error("The send outbox is blocked by another open tab"));
  });
}

export function createIndexedDbSendOutboxStore(): SendOutboxStore {
  let database: Promise<IDBDatabase> | null = null;
  const listeners = new Set<() => void>();

  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CHANGE_CHANNEL);

  const notifyLocal = (): void => {
    for (const listener of listeners) listener();
  };

  if (channel !== null) {
    channel.onmessage = notifyLocal;
  }

  const announce = (): void => {
    notifyLocal();
    channel?.postMessage("changed");
  };

  const open = (): Promise<IDBDatabase> => {
    database ??= openSendOutboxDatabase().catch((error: unknown) => {
      database = null;
      throw error;
    });

    return database;
  };

  const updateEntry = async (
    submissionId: string,
    update: (entry: OutboxEntry) => OutboxEntry,
  ): Promise<void> => {
    const transaction = (await open()).transaction(ENTRIES_STORE, "readwrite");
    const store = transaction.objectStore(ENTRIES_STORE);
    const done = transactionDone(transaction);
    const stored: unknown = await requestResult(store.get(submissionId));

    if (stored !== undefined) {
      store.put(update(outboxEntrySchema.parse(stored)));
    }

    await done;
    announce();
  };

  return {
    async stage(entry) {
      const transaction = (await open()).transaction(
        ENTRIES_STORE,
        "readwrite",
      );

      const store = transaction.objectStore(ENTRIES_STORE);
      const done = transactionDone(transaction);

      const last = await requestResult(
        store.index("sequence").openCursor(null, "prev"),
      );

      const lastSequence: unknown = last?.key;

      const staged: OutboxEntry = {
        ...entry,
        schema: 1,
        sequence: typeof lastSequence === "number" ? lastSequence + 1 : 1,
        state: { kind: "waiting" },
      };

      store.add(staged);
      await done;
      announce();

      return staged;
    },
    async list() {
      const transaction = (await open()).transaction(ENTRIES_STORE, "readonly");

      const stored: unknown[] = await requestResult(
        transaction.objectStore(ENTRIES_STORE).index("sequence").getAll(),
      );

      return stored.map((value) => outboxEntrySchema.parse(value));
    },
    async count() {
      const transaction = (await open()).transaction(ENTRIES_STORE, "readonly");

      return requestResult(transaction.objectStore(ENTRIES_STORE).count());
    },
    async recordUpload(args) {
      await updateEntry(args.submissionId, (entry) => ({
        ...entry,
        attachments: entry.attachments.map((attachment) =>
          attachment.token === args.token
            ? { ...attachment, uploadedPath: args.path }
            : attachment,
        ),
      }));
    },
    async setState(submissionId, state) {
      await updateEntry(submissionId, (entry) => ({ ...entry, state }));
    },
    async reset(submissionId) {
      await updateEntry(submissionId, (entry) => ({
        ...entry,
        attachments: entry.attachments.map((attachment) => ({
          ...attachment,
          uploadedPath: null,
        })),
        state: { kind: "waiting" },
      }));
    },
    async discard(submissionId) {
      const transaction = (await open()).transaction(
        ENTRIES_STORE,
        "readwrite",
      );

      const done = transactionDone(transaction);
      transaction.objectStore(ENTRIES_STORE).delete(submissionId);
      await done;
      announce();
    },
    async settle(args) {
      const transaction = (await open()).transaction(
        [ENTRIES_STORE, ALIASES_STORE],
        "readwrite",
      );

      const done = transactionDone(transaction);
      transaction.objectStore(ENTRIES_STORE).delete(args.submissionId);

      if (args.alias !== null) {
        transaction.objectStore(ALIASES_STORE).put(args.alias);
      }

      await done;
      announce();
    },
    async readAlias(pendingChatId) {
      const transaction = (await open()).transaction(ALIASES_STORE, "readonly");

      const stored: unknown = await requestResult(
        transaction.objectStore(ALIASES_STORE).get(pendingChatId),
      );

      const parsed = aliasRecordSchema.safeParse(stored);

      return parsed.success ? parsed.data.threadId : null;
    },
    async readKnownStoreId() {
      const transaction = (await open()).transaction(META_STORE, "readonly");

      const stored: unknown = await requestResult(
        transaction.objectStore(META_STORE).get(KNOWN_STORE_ID_KEY),
      );

      const parsed = knownStoreIdRecordSchema.safeParse(stored);

      return parsed.success ? parsed.data.storeId : null;
    },
    async rememberStoreId(storeId) {
      const transaction = (await open()).transaction(META_STORE, "readwrite");
      const done = transactionDone(transaction);

      transaction
        .objectStore(META_STORE)
        .put({ key: KNOWN_STORE_ID_KEY, storeId });
      await done;
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
