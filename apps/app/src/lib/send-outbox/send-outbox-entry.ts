import {
  createQueuedMessageRequestSchema,
  createThreadRequestSchema,
  submissionIdSchema,
} from "@omnyo/server-contract";
import { z } from "zod";

export const SEND_OUTBOX_ATTACHMENT_TOKEN_PREFIX = "omnyo-outbox-attachment:";

export const outboxAttachmentSchema = z.object({
  token: z.string().startsWith(SEND_OUTBOX_ATTACHMENT_TOKEN_PREFIX),
  blob: z.instanceof(Blob),
  name: z.string().min(1),
  mimeType: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sizeBytes: z.number().int().nonnegative(),
  uploadedPath: z.string().min(1).nullable(),
});

export type OutboxAttachment = z.infer<typeof outboxAttachmentSchema>;

export const outboxActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread-message"),
    projectId: z.string().min(1),
    target: z.union([
      z.object({ threadId: z.string().min(1) }),
      z.object({ pendingChatId: z.string().min(1) }),
    ]),
    message: createQueuedMessageRequestSchema,
  }),
  z.object({
    kind: z.literal("new-thread"),
    pendingChatId: z.string().min(1),
    thread: createThreadRequestSchema,
  }),
]);

export type OutboxAction = z.infer<typeof outboxActionSchema>;

export const outboxEntryStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting") }),
  z.object({
    kind: z.literal("paused"),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
]);

export type OutboxEntryState = z.infer<typeof outboxEntryStateSchema>;

export const outboxEntrySchema = z.object({
  schema: z.literal(1),
  submissionId: submissionIdSchema,
  storeId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  action: outboxActionSchema,
  attachments: z.array(outboxAttachmentSchema),
  state: outboxEntryStateSchema,
});

export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

export type NewOutboxEntry = Omit<OutboxEntry, "schema" | "sequence" | "state">;

export function createSubmissionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return `sub_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createOutboxAttachmentToken(): string {
  return `${SEND_OUTBOX_ATTACHMENT_TOKEN_PREFIX}${crypto.randomUUID()}`;
}

export async function createOutboxAttachment(args: {
  blob: Blob;
  mimeType?: string;
  name: string;
  uploadedPath: string | null;
}): Promise<OutboxAttachment> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await args.blob.arrayBuffer(),
  );

  return {
    token: createOutboxAttachmentToken(),
    blob: args.blob,
    name: args.name,
    ...(args.mimeType === undefined ? {} : { mimeType: args.mimeType }),
    sha256: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    sizeBytes: args.blob.size,
    uploadedPath: args.uploadedPath,
  };
}

export function outboxConversationKey(action: OutboxAction): string {
  if (action.kind === "new-thread") {
    return action.pendingChatId;
  }

  return "threadId" in action.target
    ? action.target.threadId
    : action.target.pendingChatId;
}
