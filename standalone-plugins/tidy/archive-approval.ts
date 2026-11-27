import { z } from "zod";

export const ARCHIVE_APPROVAL_RENDERER_ID = "archive-approval";

export const MAX_APPROVAL_CHATS = 100;

export const chatIdSchema = z.string().regex(/^[\w-]{1,80}$/u);

export const approvalPayloadSchema = z.object({
  threadIds: z.array(chatIdSchema).min(1).max(MAX_APPROVAL_CHATS),
});

export const archiveResultSchema = z.object({
  archived: z.number().int().nonnegative(),
  failures: z.array(z.object({ threadId: z.string(), message: z.string() })),
});

export type ArchiveResult = z.infer<typeof archiveResultSchema>;

export function chatCount(count: number): string {
  return `${count} ${count === 1 ? "chat" : "chats"}`;
}

export function approvalTitle(count: number): string {
  return `Archive ${count} ready ${count === 1 ? "chat" : "chats"}`;
}

export function approvalReceiptTitle(result: ArchiveResult): string {
  const attempted = result.archived + result.failures.length;

  if (result.archived === 0)
    return result.failures.length === 0 ? "Already archived" : "No chats archived";

  return result.failures.length === 0
    ? `Archived ${chatCount(result.archived)}`
    : `Archived ${result.archived} of ${attempted} chats`;
}

export function legacyProposalText(count: number): string {
  return `Archive proposal for ${chatCount(count)}`;
}
