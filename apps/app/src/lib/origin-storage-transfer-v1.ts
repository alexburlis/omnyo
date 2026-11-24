import { z } from "zod";

import {
  originStorageTicketSchemaV1,
  type OriginStorageTicketV1,
} from "@omnyo/desktop-contract/internal/origin-adoption-v1";

export {
  originStorageTicketSchemaV1,
  type OriginStorageTicketV1,
} from "@omnyo/desktop-contract/internal/origin-adoption-v1";

const entriesSchema = z
  .array(z.tuple([z.string(), z.string()]))
  .max(65536)
  .superRefine((entries, context) => {
    if (
      new Set(entries.map(([key]) => key)).size !== entries.length ||
      entries.some(([key]) => key.startsWith("omnyo.origin-transfer.v1:"))
    )
      context.addIssue({
        code: "custom",
        message: "Storage transfer contains duplicate or control keys",
      });
  });

const payloadSchema = z
  .object({
    version: z.literal(1),
    ticket: originStorageTicketSchemaV1,
    local: entriesSchema,
    session: entriesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      [...value.local, ...value.session].reduce(
        (size, [key, data]) => size + (key.length + data.length) * 2,
        0,
      ) >
      16 * 1024 * 1024
    )
      context.addIssue({
        code: "custom",
        message: "Storage transfer exceeds its bounded payload",
      });
  });

export type OriginStoragePayloadV1 = z.infer<typeof payloadSchema>;

const receiptSchema = z
  .object({
    version: z.literal(1),
    ticket: originStorageTicketSchemaV1,
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    phase: z.enum(["copying", "verified", "accepted"]),
    adoptionAccepted: z.boolean(),
  })
  .strict();

export const ORIGIN_STORAGE_ADMISSION_LOCK_V1 =
  "omnyo-browser-origin-admission-v1";

export const ORIGIN_STORAGE_SOURCE_FENCE_V1 = "omnyo.origin-transfer.v1:source";

export const ORIGIN_STORAGE_ADOPTION_V1 = "omnyo.origin-transfer.v1:adoption";

const adoptionSchema = z
  .object({
    version: z.literal(1),
    adoptionId: z.string().min(1).max(200),
    selectedIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .min(1)
      .max(32),
    fromOrigin: originStorageTicketSchemaV1.shape.fromOrigin,
    toOrigin: originStorageTicketSchemaV1.shape.toOrigin,
    phase: z.enum(["copying", "accepted"]),
  })
  .strict();

function adoption(ticket: OriginStorageTicketV1, local: Storage) {
  const raw = local.getItem(ORIGIN_STORAGE_ADOPTION_V1);

  if (raw === null) return null;
  const previous = adoptionSchema.parse(JSON.parse(raw));

  if (
    previous.adoptionId !== ticket.adoptionId ||
    JSON.stringify(previous.selectedIds) !==
      JSON.stringify(ticket.selectedIds) ||
    previous.fromOrigin !== ticket.fromOrigin ||
    previous.toOrigin !== ticket.toOrigin
  )
    throw new Error(
      "Destination browser adoption belongs to different selected work",
    );

  return previous;
}

export function admitOriginAdoptionV1(
  ticket: OriginStorageTicketV1,
  local: Storage,
  session: Storage,
  authorization: { adoptionAccepted: true; phase: "admitted" },
) {
  const parsed = originStorageTicketSchemaV1.parse(ticket);

  if (
    authorization.adoptionAccepted !== true ||
    authorization.phase !== "admitted"
  )
    throw new Error(
      "Every selected window must be admitted before ordinary writes",
    );
  const previous = adoption(parsed, local);

  const receipt = receiptSchema.parse(
    JSON.parse(
      session.getItem(`omnyo.origin-transfer.v1:${parsed.id}`) ?? "null",
    ),
  );

  if (
    previous === null ||
    receipt.phase !== "accepted" ||
    !ticketMatches(parsed, receipt.ticket)
  )
    throw new Error("Browser window admission has not committed");
  session.setItem(
    `omnyo.origin-transfer.v1:${parsed.id}`,
    JSON.stringify({ ...receipt, adoptionAccepted: true }),
  );
  local.setItem(
    ORIGIN_STORAGE_ADOPTION_V1,
    JSON.stringify({ ...previous, phase: "accepted" }),
  );

  if (adoption(parsed, local)?.phase !== "accepted")
    throw new Error("Global browser writer admission did not commit");
}

function entries(storage: Storage): Array<[string, string]> {
  const keys: string[] = [];

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);

    if (key !== null && !key.startsWith("omnyo.origin-transfer.v1:"))
      keys.push(key);
  }

  return keys.sort().map((key) => {
    const value = storage.getItem(key);

    if (value === null) throw new Error("Browser state changed during export");

    return [key, value];
  });
}

function ticketMatches(
  left: OriginStorageTicketV1,
  right: OriginStorageTicketV1,
) {
  return (
    left.adoptionId === right.adoptionId &&
    JSON.stringify(left.selectedIds) === JSON.stringify(right.selectedIds) &&
    left.id === right.id &&
    left.nonce === right.nonce &&
    left.fromOrigin === right.fromOrigin &&
    left.toOrigin === right.toOrigin
  );
}

export function snapshotOriginStorageV1(
  ticket: OriginStorageTicketV1,
  currentOrigin: string,
  local: Storage,
  session: Storage,
): OriginStoragePayloadV1 {
  const parsed = originStorageTicketSchemaV1.parse(ticket);

  if (currentOrigin !== parsed.fromOrigin)
    throw new Error("Storage export origin does not match its admitted owner");

  return payloadSchema.parse({
    version: 1,
    ticket: parsed,
    local: entries(local),
    session: entries(session),
  });
}

export function assertOriginStorageSourceUnchangedV1(
  payload: OriginStoragePayloadV1,
  local: Storage,
  session: Storage,
) {
  if (
    JSON.stringify([entries(local), entries(session)]) !==
    JSON.stringify([payload.local, payload.session])
  )
    throw new Error(
      "Source browser state changed; both origins were preserved",
    );
}

async function payloadDigest(payload: OriginStoragePayloadV1) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function importOriginStorageV1(args: {
  ticket: OriginStorageTicketV1;
  currentOrigin: string;
  eventOrigin: string;
  eventSource: MessageEventSource | null;
  expectedSource: MessageEventSource;
  payload: unknown;
  local: Storage;
  session: Storage;
}) {
  const ticket = originStorageTicketSchemaV1.parse(args.ticket);
  const payload = payloadSchema.parse(args.payload);

  if (
    args.currentOrigin !== ticket.toOrigin ||
    args.eventOrigin !== ticket.fromOrigin ||
    args.eventSource !== args.expectedSource ||
    !ticketMatches(ticket, payload.ticket)
  )
    throw new Error(
      "Storage transfer origin, sender or nonce is not authorized",
    );
  const digest = await payloadDigest(payload);
  const receiptKey = `omnyo.origin-transfer.v1:${ticket.id}`;
  const raw = args.session.getItem(receiptKey);
  const prior = raw === null ? null : receiptSchema.parse(JSON.parse(raw));

  if (
    prior !== null &&
    (!ticketMatches(prior.ticket, ticket) || prior.digest !== digest)
  )
    throw new Error("Browser transfer receipt belongs to different work");

  if (prior?.phase === "accepted")
    return { digest, phase: "accepted" as const };

  const stores = [
    [args.local, payload.local],
    [args.session, payload.session],
  ] as const;

  for (const [storage, values] of stores)
    for (const [key, value] of values) {
      const target = storage.getItem(key);

      if (target !== null && target !== value)
        throw new Error(
          "Destination browser state collides; both origins were preserved",
        );
    }

  const owner = adoption(ticket, args.local);

  if (owner?.phase === "accepted")
    throw new Error(
      "A fresh window cannot overwrite an already admitted adoption",
    );

  if (owner === null)
    args.local.setItem(
      ORIGIN_STORAGE_ADOPTION_V1,
      JSON.stringify({
        version: 1,
        adoptionId: ticket.adoptionId,
        selectedIds: ticket.selectedIds,
        fromOrigin: ticket.fromOrigin,
        toOrigin: ticket.toOrigin,
        phase: "copying",
      }),
    );

  args.session.setItem(
    receiptKey,
    JSON.stringify({
      version: 1,
      ticket,
      digest,
      phase: "copying",
      adoptionAccepted: false,
    }),
  );

  for (const [storage, values] of stores)
    for (const [key, value] of values) {
      const current = storage.getItem(key);

      if (current !== null && current !== value)
        throw new Error("Destination browser state changed during transfer");

      if (current === null) storage.setItem(key, value);

      if (storage.getItem(key) !== value)
        throw new Error("Copied browser state could not be verified");
    }

  args.session.setItem(
    receiptKey,
    JSON.stringify({
      version: 1,
      ticket,
      digest,
      phase: "verified",
      adoptionAccepted: false,
    }),
  );

  return { digest, phase: "verified" as const };
}

export function admitOriginStorageV1(
  ticket: OriginStorageTicketV1,
  digest: string,
  session: Storage,
) {
  const key = `omnyo.origin-transfer.v1:${ticket.id}`;

  const receipt = receiptSchema.parse(
    JSON.parse(session.getItem(key) ?? "null"),
  );

  if (
    !ticketMatches(ticket, receipt.ticket) ||
    receipt.digest !== digest ||
    receipt.phase === "copying"
  )
    throw new Error(
      "Browser transfer is not verified for first-write admission",
    );
  session.setItem(key, JSON.stringify({ ...receipt, phase: "accepted" }));

  if (
    receiptSchema.parse(JSON.parse(session.getItem(key) ?? "null")).phase !==
    "accepted"
  )
    throw new Error("Browser first-write admission could not be verified");
}

export async function withOriginStorageLeaseV1<T>(
  work: () => Promise<T>,
): Promise<T> {
  if (typeof navigator.locks?.request !== "function")
    throw new Error("Browser storage ownership cannot be verified");

  return navigator.locks.request(
    ORIGIN_STORAGE_ADMISSION_LOCK_V1,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (lock === null)
        throw new Error("An active browser writer prevents origin transfer");

      return work();
    },
  );
}

export function fenceOriginStorageSourceV1(
  ticket: OriginStorageTicketV1,
  currentOrigin: string,
  local: Storage,
) {
  const parsed = originStorageTicketSchemaV1.parse(ticket);

  if (currentOrigin !== parsed.fromOrigin)
    throw new Error("Browser source fence origin differs");

  const value = JSON.stringify({
    version: 1,
    adoptionId: parsed.adoptionId,
    selectedIds: parsed.selectedIds,
    fromOrigin: parsed.fromOrigin,
    toOrigin: parsed.toOrigin,
  });

  const prior = local.getItem(ORIGIN_STORAGE_SOURCE_FENCE_V1);

  if (prior !== null && prior !== value)
    throw new Error("Browser source fence belongs to a different transfer");

  if (prior === null) local.setItem(ORIGIN_STORAGE_SOURCE_FENCE_V1, value);

  if (local.getItem(ORIGIN_STORAGE_SOURCE_FENCE_V1) !== value)
    throw new Error("Browser source fence could not be verified");
}

export function assertOriginAdoptionAcceptedV1(
  value: OriginStorageTicketV1,
  local: Storage,
): void {
  const ticket = originStorageTicketSchemaV1.parse(value);
  const current = adoption(ticket, local);

  if (
    current === null ||
    current.phase !== "accepted" ||
    current.adoptionId !== ticket.adoptionId ||
    JSON.stringify(current.selectedIds) !== JSON.stringify(ticket.selectedIds)
  )
    throw new Error(
      "Every selected browser window must finish before native session restoration",
    );
}
