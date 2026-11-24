import { type OriginLocalWindowV1 } from "@omnyo/desktop-contract/internal/origin-adoption-v1";

export {
  originLocalWindowSchemaV1,
  type OriginLocalWindowV1,
} from "@omnyo/desktop-contract/internal/origin-adoption-v1";

import { z } from "zod";
import {
  originStorageTicketSchemaV1,
  snapshotOriginStorageV1,
  type OriginStorageTicketV1,
} from "./origin-storage-transfer-v1.js";

export const ORIGIN_WINDOW_STATE_DATABASE_V1 = "omnyo-origin-adoption-v1";

export const ORIGIN_WINDOW_STATE_DATABASE_VERSION_V1 = 1;

const storeName = "staged-windows";

const entriesSchema = z
  .array(z.tuple([z.string(), z.string()]))
  .max(65536)
  .superRefine((entries, context) => {
    if (
      new Set(entries.map(([key]) => key)).size !== entries.length ||
      entries.some(([key]) => key.startsWith("omnyo.origin-transfer.v1:")) ||
      entries.reduce(
        (size, [key, value]) => size + (key.length + value.length) * 2,
        0,
      ) >
        16 * 1024 * 1024
    )
      context.addIssue({
        code: "custom",
        message: "Staged window state contains invalid or excessive entries",
      });
  });

const stagedSchema = z
  .object({
    version: z.literal(1),
    side: z.enum(["source", "target"]).default("source"),
    adoptionId: z.string().min(1).max(200),
    selectedIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .min(1)
      .max(32),
    transferId: z.string().regex(/^[a-f0-9]{64}$/u),
    windowKey: z.string().min(1).max(200),
    nonceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    fromOrigin: z.string(),
    toOrigin: z.string(),
    localSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    session: entriesSchema,
  })
  .strict();

export async function digestOriginWindowStateV1(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function openOwner() {
  if (typeof indexedDB === "undefined")
    throw new Error("Durable browser window staging is unavailable");

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      ORIGIN_WINDOW_STATE_DATABASE_V1,
      ORIGIN_WINDOW_STATE_DATABASE_VERSION_V1,
    );

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName))
        request.result.createObjectStore(storeName);
    };

    request.onblocked = () =>
      reject(new Error("Browser window staging is held by another owner"));
    request.onerror = () =>
      reject(
        request.error ?? new Error("Browser window staging could not open"),
      );
    request.onsuccess = () => resolve(request.result);
  });
}

const recordKey = (ticket: OriginStorageTicketV1, windowKey: string) =>
  `${ticket.id}:${z.string().min(1).max(200).parse(windowKey)}`;

type WindowStateArgs = {
  ticket: OriginStorageTicketV1;
  windowKey: string;
  currentOrigin: string;
  local: Storage;
  session: Storage;
};

export function originTargetStorageEntriesV1(storage: Storage) {
  const entries: [string, string][] = [];

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);

    if (key === null || key.startsWith("omnyo.origin-transfer.v1:")) continue;
    const value = storage.getItem(key);

    if (value === null)
      throw new Error("Saved browser state changed during window staging");
    entries.push([key, value]);
  }

  return entriesSchema.parse(
    entries.sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    ),
  );
}

export async function initializeOriginWindowStateV1() {
  const database = await openOwner();
  database.close();
}

export function stageOriginWindowStateV1(args: WindowStateArgs) {
  return stageWindowState(args, "source");
}

export function stageOriginTargetWindowStateV1(args: WindowStateArgs) {
  return stageWindowState(args, "target");
}

async function stageWindowState(
  args: WindowStateArgs,
  side: "source" | "target",
) {
  const ticket = originStorageTicketSchemaV1.parse(args.ticket);

  if (
    args.currentOrigin !==
    (side === "source" ? ticket.fromOrigin : ticket.toOrigin)
  )
    throw new Error(
      "Window staging must use its exact selected browser origin",
    );

  const payload =
    side === "source"
      ? snapshotOriginStorageV1(
          ticket,
          args.currentOrigin,
          args.local,
          args.session,
        )
      : {
          local: originTargetStorageEntriesV1(args.local),
          session: originTargetStorageEntriesV1(args.session),
        };

  const record = stagedSchema.parse({
    version: 1,
    side,
    adoptionId: ticket.adoptionId,
    selectedIds: ticket.selectedIds,
    transferId: ticket.id,
    windowKey: args.windowKey,
    nonceSha256: await digestOriginWindowStateV1(ticket.nonce),
    fromOrigin: ticket.fromOrigin,
    toOrigin: ticket.toOrigin,
    localSha256: await digestOriginWindowStateV1(JSON.stringify(payload.local)),
    session: payload.session,
  });

  const database = await openOwner();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const key = recordKey(ticket, args.windowKey);
      const request = store.get(key);
      let conflict = false;
      request.onsuccess = () => {
        const previous: unknown = request.result;

        try {
          if (
            previous !== undefined &&
            JSON.stringify(stagedSchema.parse(previous)) !==
              JSON.stringify(record)
          ) {
            conflict = true;
            transaction.abort();

            return;
          }

          if (previous === undefined) store.add(record, key);
        } catch {
          conflict = true;
          transaction.abort();
        }
      };

      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          conflict
            ? new Error("Staged window identity collides with different work")
            : (transaction.error ??
                new Error("Browser window staging did not commit")),
        );
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Browser window staging failed"));
    });

    return {
      version: 1 as const,
      transferId: ticket.id,
      windowKey: record.windowKey,
      staged: true as const,
      sha256: await digestOriginWindowStateV1(JSON.stringify(record)),
    };
  } finally {
    database.close();
  }
}

export function restoreOriginWindowStateV1(args: WindowStateArgs) {
  return restoreWindowState(args, "source", null);
}

export function restoreOriginTargetWindowStateV1(
  args: WindowStateArgs & { expectedSha256: string },
) {
  return restoreWindowState(
    args,
    "target",
    z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(args.expectedSha256),
  );
}

async function restoreWindowState(
  args: WindowStateArgs,
  side: "source" | "target",
  expectedSha256: string | null,
) {
  const ticket = originStorageTicketSchemaV1.parse(args.ticket);

  if (
    args.currentOrigin !==
    (side === "source" ? ticket.fromOrigin : ticket.toOrigin)
  )
    throw new Error(
      "Window restore must use the exact original browser origin",
    );
  const database = await openOwner();
  let raw: unknown;

  try {
    raw = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");

      const request = transaction
        .objectStore(storeName)
        .get(recordKey(ticket, args.windowKey));

      let value: unknown;
      request.onsuccess = () => {
        value = request.result;
      };

      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("Staged browser window read did not complete"),
        );
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error("Staged browser window read failed"),
        );
    });
  } finally {
    database.close();
  }

  const record = stagedSchema.parse(raw);

  const local =
    side === "source"
      ? snapshotOriginStorageV1(
          ticket,
          args.currentOrigin,
          args.local,
          args.session,
        ).local
      : originTargetStorageEntriesV1(args.local);

  if (
    record.side !== side ||
    (expectedSha256 !== null &&
      (await digestOriginWindowStateV1(JSON.stringify(record))) !==
        expectedSha256) ||
    record.adoptionId !== ticket.adoptionId ||
    JSON.stringify(record.selectedIds) !== JSON.stringify(ticket.selectedIds) ||
    record.transferId !== ticket.id ||
    record.windowKey !== args.windowKey ||
    record.nonceSha256 !== (await digestOriginWindowStateV1(ticket.nonce)) ||
    record.fromOrigin !== ticket.fromOrigin ||
    record.toOrigin !== ticket.toOrigin ||
    record.localSha256 !==
      (await digestOriginWindowStateV1(JSON.stringify(local)))
  )
    throw new Error(
      "Staged browser window belongs to another profile, origin or transfer",
    );

  for (const [key, value] of record.session) {
    const previous = args.session.getItem(key);

    if (previous !== null && previous !== value)
      throw new Error(
        "New browser window collides with preserved session work",
      );
  }

  const receiptKey = `omnyo.origin-transfer.v1:window:${ticket.id}`;
  args.session.setItem(
    receiptKey,
    JSON.stringify({ version: 1, phase: "copying", windowKey: args.windowKey }),
  );

  for (const [key, value] of record.session) {
    const previous = args.session.getItem(key);

    if (previous !== null && previous !== value)
      throw new Error("Browser session changed during restore");

    if (previous === null) args.session.setItem(key, value);
  }

  for (const [key, value] of record.session)
    if (args.session.getItem(key) !== value)
      throw new Error("Browser window state did not verify");
  args.session.setItem(
    receiptKey,
    JSON.stringify({
      version: 1,
      phase: "restored",
      windowKey: args.windowKey,
    }),
  );

  return { restored: true as const, windowKey: args.windowKey };
}

export const originFirstEntryMutationSchemaV1 = z
  .object({
    key: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
  })
  .strict();

export const originFirstEntryPayloadSchemaV1 = z
  .object({
    version: z.literal(1),
    adoptionId: z.string().min(1).max(200),
    globalSelectedIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .min(1)
      .max(32),
    localSelectionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    localBeforeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    localAfterSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    unchangedLocalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    mutations: z.array(originFirstEntryMutationSchemaV1).max(65536),
    controllerHashes: z
      .array(
        z
          .object({
            key: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .max(65),
    windows: z
      .array(
        z
          .object({
            transferId: z.string().regex(/^[a-f0-9]{64}$/u),
            windowKey: z.string().min(1).max(200),
            targetStageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            nonceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            originPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            composerTabId: z.string().min(1).max(200).nullable(),
            sessionBeforeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            sessionAfterSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            mutations: z.array(originFirstEntryMutationSchemaV1).max(65536),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    recoveredSubmissions: z.number().int().nonnegative(),
    movedDrafts: z.number().int().nonnegative(),
  })
  .strict();

export const originFirstEntryRecordSchemaV1 = z
  .object({
    version: z.literal(1),
    payload: originFirstEntryPayloadSchemaV1,
    recipeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    localApplied: z.boolean(),
    controllerRetirementStarted: z.boolean(),
    readyWindowIds: z.array(z.string()).max(32),
    preparedWindowIds: z.array(z.string()).max(32),
    retiredWindowIds: z.array(z.string()).max(32),
  })
  .strict();

export type OriginFirstEntryRecordV1 = z.infer<
  typeof originFirstEntryRecordSchemaV1
>;

async function readOwnerRecord(key: string): Promise<unknown> {
  const database = await openOwner();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      let value: unknown;
      request.onsuccess = () => {
        value = request.result;
      };

      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("Browser recovery read did not commit"),
        );
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Browser recovery read failed"));
    });
  } finally {
    database.close();
  }
}

async function writeOwnerRecord(
  key: string,
  value: OriginFirstEntryRecordV1,
  expected: OriginFirstEntryRecordV1 | null,
) {
  const database = await openOwner();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      let refused = false;
      request.onsuccess = () => {
        if (
          JSON.stringify(request.result ?? null) !== JSON.stringify(expected)
        ) {
          refused = true;
          transaction.abort();

          return;
        }

        store.put(value, key);
      };

      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          refused
            ? new Error("Browser recovery owner changed concurrently")
            : (transaction.error ??
                new Error("Browser recovery receipt did not commit")),
        );
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error("Browser recovery receipt failed"),
        );
    });
  } finally {
    database.close();
  }
}

export async function readExactOriginTargetWindowStateV1(
  window: OriginLocalWindowV1,
) {
  const ticket = window.ticket;

  const record = stagedSchema.parse(
    await readOwnerRecord(recordKey(ticket, window.windowKey)),
  );

  if (
    record.side !== "target" ||
    record.transferId !== ticket.id ||
    record.windowKey !== window.windowKey ||
    record.adoptionId !== ticket.adoptionId ||
    record.fromOrigin !== ticket.fromOrigin ||
    record.toOrigin !== ticket.toOrigin ||
    record.nonceSha256 !== (await digestOriginWindowStateV1(ticket.nonce)) ||
    JSON.stringify(record.selectedIds) !== JSON.stringify(ticket.selectedIds) ||
    (await digestOriginWindowStateV1(JSON.stringify(record))) !==
      window.targetStageSha256
  )
    throw new Error("Sealed target window changed before first entry");

  return record;
}

const firstEntryStorageSelectionSchema = z
  .object({
    adoptionId: z.string().min(1).max(200),
    localSelectionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

function firstEntryStorageKey(
  input: z.infer<typeof firstEntryStorageSelectionSchema>,
) {
  const selection = firstEntryStorageSelectionSchema.parse(input);

  return `first-entry:${encodeURIComponent(selection.adoptionId)}:${selection.localSelectionSha256}`;
}

export async function readOriginFirstEntryRecordV1(
  input: z.infer<typeof firstEntryStorageSelectionSchema>,
) {
  const value = await readOwnerRecord(firstEntryStorageKey(input));

  if (value === undefined) return undefined;
  const record = originFirstEntryRecordSchemaV1.parse(value);

  if (
    record.payload.adoptionId !== input.adoptionId ||
    record.payload.localSelectionSha256 !== input.localSelectionSha256
  )
    throw new Error(
      "Browser first-entry receipt belongs to a different native selection",
    );

  return record;
}

export async function writeOriginFirstEntryRecordV1(
  input: z.infer<typeof firstEntryStorageSelectionSchema>,
  value: OriginFirstEntryRecordV1,
  previous: OriginFirstEntryRecordV1 | null,
) {
  const record = originFirstEntryRecordSchemaV1.parse(value);

  const expected =
    previous === null ? null : originFirstEntryRecordSchemaV1.parse(previous);

  for (const candidate of [record, expected])
    if (
      candidate !== null &&
      (candidate.payload.adoptionId !== input.adoptionId ||
        candidate.payload.localSelectionSha256 !== input.localSelectionSha256)
    )
      throw new Error(
        "Browser first-entry write belongs to a different native selection",
      );
  await writeOwnerRecord(firstEntryStorageKey(input), record, expected);
}
