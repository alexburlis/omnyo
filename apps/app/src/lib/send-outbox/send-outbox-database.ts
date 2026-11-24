export const SEND_OUTBOX_DATABASE = "omnyo-send-outbox";

export const SEND_OUTBOX_DATABASE_VERSION = 1;

export const SEND_OUTBOX_ENTRIES_STORE = "entries";

export interface SendOutboxDatabaseProbe {
  countEntries(): Promise<number>;
  exists(): Promise<boolean>;
}

export const indexedDbSendOutboxProbe: SendOutboxDatabaseProbe = {
  async exists() {
    return (await indexedDB.databases()).some(
      (database) => database.name === SEND_OUTBOX_DATABASE,
    );
  },
  countEntries() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(
        SEND_OUTBOX_DATABASE,
        SEND_OUTBOX_DATABASE_VERSION,
      );

      request.onupgradeneeded = () => {
        request.transaction?.abort();
      };

      request.onerror = () =>
        reject(
          request.error ?? new Error("Waiting messages could not be counted"),
        );
      request.onblocked = () =>
        reject(new Error("Waiting messages are in use by another open tab"));

      request.onsuccess = () => {
        const database = request.result;

        const count = database
          .transaction(SEND_OUTBOX_ENTRIES_STORE, "readonly")
          .objectStore(SEND_OUTBOX_ENTRIES_STORE)
          .count();

        count.onsuccess = () => {
          database.close();
          resolve(count.result);
        };

        count.onerror = () => {
          database.close();
          reject(count.error ?? new Error("Waiting messages are unreadable"));
        };
      };
    });
  },
};

export async function assertSendOutboxEmptyForOriginTransferV1(
  probe: SendOutboxDatabaseProbe,
): Promise<void> {
  if (!(await probe.exists())) {
    return;
  }

  const waiting = await probe.countEntries();

  if (waiting > 0)
    throw new Error(
      `${waiting} ${waiting === 1 ? "message is" : "messages are"} still waiting to send at this address. Open Omnyo here until they are sent, or discard them, then change the address. They are preserved.`,
    );
}
