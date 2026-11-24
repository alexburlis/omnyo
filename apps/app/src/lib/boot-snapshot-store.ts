import { z } from "zod";

export const BOOT_SNAPSHOT_DATABASE = "omnyo-boot-snapshot";

export const BOOT_SNAPSHOT_DATABASE_VERSION = 1;

const BOOT_SNAPSHOT_STORE = "records";

export const BOOT_SNAPSHOT_MAX_CHARS = 512 * 1024;

export const bootSnapshotRecordSchema = z.object({
  schema: z.literal(1),
  origin: z.string().min(1),
  serverIdentity: z.string().min(1),
  savedAt: z.number().int().nonnegative(),
  parts: z.record(z.string(), z.unknown()),
});

export type BootSnapshotRecord = z.infer<typeof bootSnapshotRecordSchema>;

export interface BootSnapshotStore {
  read(origin: string): Promise<BootSnapshotRecord | null>;
  write(record: BootSnapshotRecord): Promise<void>;
  clear(origin: string): Promise<void>;
}

export function bootSnapshotSize(record: BootSnapshotRecord): number {
  return JSON.stringify(record).length;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise !== null) return databasePromise;

  databasePromise =
    typeof indexedDB === "undefined"
      ? Promise.resolve(null)
      : new Promise<IDBDatabase | null>((resolve) => {
          let request: IDBOpenDBRequest;

          try {
            request = indexedDB.open(
              BOOT_SNAPSHOT_DATABASE,
              BOOT_SNAPSHOT_DATABASE_VERSION,
            );
          } catch {
            resolve(null);

            return;
          }

          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(BOOT_SNAPSHOT_STORE))
              request.result.createObjectStore(BOOT_SNAPSHOT_STORE, {
                keyPath: "origin",
              });
          };

          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        });

  return databasePromise;
}

function settleTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export const indexedDbBootSnapshotStore: BootSnapshotStore = {
  async read(origin) {
    const database = await openDatabase();

    if (database === null) return null;

    try {
      const request = database
        .transaction(BOOT_SNAPSHOT_STORE, "readonly")
        .objectStore(BOOT_SNAPSHOT_STORE)
        .get(origin);

      const value = await new Promise<unknown>((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });

      const parsed = bootSnapshotRecordSchema.safeParse(value);

      return parsed.success && parsed.data.origin === origin
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  },
  async write(record) {
    const database = await openDatabase();

    if (database === null) return;

    try {
      const transaction = database.transaction(
        BOOT_SNAPSHOT_STORE,
        "readwrite",
      );

      const store = transaction.objectStore(BOOT_SNAPSHOT_STORE);

      if (bootSnapshotSize(record) > BOOT_SNAPSHOT_MAX_CHARS)
        store.delete(record.origin);
      else store.put(record);
      await settleTransaction(transaction);
    } catch {
      return;
    }
  },
  async clear(origin) {
    const database = await openDatabase();

    if (database === null) return;

    try {
      const transaction = database.transaction(
        BOOT_SNAPSHOT_STORE,
        "readwrite",
      );

      transaction.objectStore(BOOT_SNAPSHOT_STORE).delete(origin);
      await settleTransaction(transaction);
    } catch {
      return;
    }
  },
};
