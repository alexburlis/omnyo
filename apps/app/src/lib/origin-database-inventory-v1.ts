import {
  ORIGIN_WINDOW_STATE_DATABASE_V1,
  ORIGIN_WINDOW_STATE_DATABASE_VERSION_V1,
} from "./origin-window-state-v1";
import { z } from "zod";
import {
  BOOT_SNAPSHOT_DATABASE,
  BOOT_SNAPSHOT_DATABASE_VERSION,
} from "./boot-snapshot-store";
import {
  SEND_OUTBOX_DATABASE,
  SEND_OUTBOX_DATABASE_VERSION,
} from "./send-outbox/send-outbox-database";
import {
  THREAD_OPEN_SNAPSHOT_DATABASE,
  THREAD_OPEN_SNAPSHOT_DATABASE_VERSION,
  LEGACY_THREAD_OPEN_SNAPSHOT_DATABASE_V1,
} from "../hooks/cache-owners/thread-open-snapshot-storage-contract";

const metadataSchema = z
  .array(
    z.object({ name: z.string().min(1), version: z.number().int().positive() }),
  )
  .max(64);

export const originDatabaseInventorySchemaV1 = z
  .object({
    version: z.literal(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    databases: z
      .array(
        z
          .object({
            owner: z.enum([
              "thread-cache-v1",
              "legacy-thread-cache-v1",
              "window-staging-v1",
              "boot-snapshot-v1",
              "send-outbox-v1",
            ]),
            version: z.literal(1),
            nameSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

export type OriginDatabaseInventoryV1 = z.infer<
  typeof originDatabaseInventorySchemaV1
>;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function bindOriginDatabaseInventoryV1(
  value: unknown,
): Promise<OriginDatabaseInventoryV1> {
  const parsed = metadataSchema.safeParse(value);

  if (!parsed.success)
    throw new Error(
      "Saved browser database metadata changed; the original app data is preserved.",
    );

  const ordered = [...parsed.data].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  if (new Set(ordered.map((entry) => entry.name)).size !== ordered.length)
    throw new Error(
      "Saved browser database inventory is ambiguous; the original app data is preserved.",
    );

  const databases = await Promise.all(
    ordered.map(
      async (
        entry,
      ): Promise<OriginDatabaseInventoryV1["databases"][number]> => {
        const nameSha256 = await digest(entry.name);

        const owner =
          entry.name === THREAD_OPEN_SNAPSHOT_DATABASE
            ? "thread-cache-v1"
            : entry.name === LEGACY_THREAD_OPEN_SNAPSHOT_DATABASE_V1
              ? "legacy-thread-cache-v1"
              : entry.name === ORIGIN_WINDOW_STATE_DATABASE_V1
                ? "window-staging-v1"
                : entry.name === BOOT_SNAPSHOT_DATABASE
                  ? "boot-snapshot-v1"
                  : entry.name === SEND_OUTBOX_DATABASE
                    ? "send-outbox-v1"
                    : null;

        if (
          owner === null ||
          entry.version !==
            (owner === "window-staging-v1"
              ? ORIGIN_WINDOW_STATE_DATABASE_VERSION_V1
              : owner === "boot-snapshot-v1"
                ? BOOT_SNAPSHOT_DATABASE_VERSION
                : owner === "send-outbox-v1"
                  ? SEND_OUTBOX_DATABASE_VERSION
                  : THREAD_OPEN_SNAPSHOT_DATABASE_VERSION)
        )
          throw new Error(
            `Saved browser database ${nameSha256.slice(0, 12)} requires its owner before this address can change. The original data is preserved.`,
          );

        return { owner, version: 1, nameSha256 };
      },
    ),
  );

  return originDatabaseInventorySchemaV1.parse({
    version: 1,
    databases,
    sha256: await digest(JSON.stringify(databases)),
  });
}

export async function readOriginDatabaseInventoryV1(): Promise<OriginDatabaseInventoryV1> {
  if (
    typeof indexedDB === "undefined" ||
    typeof indexedDB.databases !== "function"
  )
    throw new Error(
      "This browser cannot inspect saved app databases for the address change. Keep the original app data.",
    );

  return bindOriginDatabaseInventoryV1(await indexedDB.databases());
}

const inventoryReceiptSchema = z
  .object({
    version: z.literal(1),
    adoptionId: z.string().min(1).max(200),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    source: originDatabaseInventorySchemaV1,
    target: originDatabaseInventorySchemaV1,
  })
  .strict();

export function recordOriginDatabaseInventoryV1(args: {
  storage: Storage;
  identity: { adoptionId: string; id: string };
  source: OriginDatabaseInventoryV1;
  target: OriginDatabaseInventoryV1;
}): void {
  const key = `omnyo.origin-transfer.v1:database-inventory:${args.identity.id}`;
  const raw = args.storage.getItem(key);

  if (raw !== null) {
    const previous = inventoryReceiptSchema.parse(JSON.parse(raw));

    if (
      previous.adoptionId !== args.identity.adoptionId ||
      previous.id !== args.identity.id
    )
      throw new Error(
        "Saved database inventory belongs to a different address change; it is preserved.",
      );

    return;
  }

  const receipt = inventoryReceiptSchema.parse({
    version: 1,
    ...args.identity,
    source: args.source,
    target: args.target,
  });

  args.storage.setItem(key, JSON.stringify(receipt));

  if (args.storage.getItem(key) !== JSON.stringify(receipt))
    throw new Error(
      "Saved database inventory could not be verified before address-change admission.",
    );
}
