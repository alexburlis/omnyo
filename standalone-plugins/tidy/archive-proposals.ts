import { createHash } from "node:crypto";
import type { PluginApi, PluginInteractionCancelReason } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  ARCHIVE_APPROVAL_RENDERER_ID,
  approvalReceiptTitle,
  approvalTitle,
  archiveResultSchema,
  type ArchiveResult,
} from "./archive-approval.ts";

export const PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const KEY_PREFIX = "archive-proposal:";

const proposalSchema = z.object({
  sourceThreadId: z.string(),
  chats: z.array(z.object({ threadId: z.string(), title: z.string() })).min(1),
  createdAt: z.number(),
});

export type ArchiveProposal = z.infer<typeof proposalSchema>;

type ProposalUi = Pick<PluginApi["ui"], "requestInput">;

type ProposalKv = PluginApi["storage"]["kv"];

type ProposalLog = Pick<PluginApi["log"], "warn">;

const SETTLED_REASONS: ReadonlySet<PluginInteractionCancelReason> = new Set([
  "user",
  "request-aborted",
  "timeout",
  "thread-deleted",
]);

export function proposalKey(sourceThreadId: string, threadIds: readonly string[]): string {
  const digest = createHash("sha256")
    .update([...new Set(threadIds)].sort().join("|"))
    .digest("hex")
    .slice(0, 24);

  return `${KEY_PREFIX}${sourceThreadId}:${digest}`;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createArchiveProposals(
  ui: ProposalUi,
  kv: ProposalKv,
  log: ProposalLog,
  now: () => number = Date.now,
) {
  const records = new Map<string, ArchiveProposal>();
  const open = new Map<string, AbortController>();
  const approving = new Set<string>();
  const failed = new Set<string>();
  let disposed = false;

  const loaded = (async () => {
    for (const key of await kv.list(KEY_PREFIX)) {
      const record = proposalSchema.safeParse(await kv.get(key));

      if (record.success) records.set(key, record.data);
      else await kv.delete(key);
    }
  })();

  loaded.catch((cause) =>
    log.warn(`Tidy couldn't read open archive approvals: ${errorText(cause)}`),
  );

  async function forget(key: string, record: ArchiveProposal): Promise<void> {
    if (records.get(key) !== record) return;
    records.delete(key);
    approving.delete(key);
    failed.delete(key);
    await kv.delete(key);
  }

  function describe(record: ArchiveProposal, result: ArchiveResult | null) {
    if (result === null) return { title: "Archive reviewed" };
    const titles = new Map(record.chats.map(({ threadId, title }) => [threadId, title]));

    const detail = result.failures
      .map(({ threadId, message }) => `- ${titles.get(threadId) ?? threadId}: ${message}`)
      .join("\n");

    return detail === ""
      ? { title: approvalReceiptTitle(result) }
      : { title: approvalReceiptTitle(result), detail };
  }

  async function ask(key: string, record: ArchiveProposal): Promise<void> {
    if (open.has(key)) return;
    const remaining = record.createdAt + PROPOSAL_LIFETIME_MS - now();

    if (remaining <= 0) {
      await forget(key, record);

      return;
    }

    const controller = new AbortController();
    open.set(key, controller);
    const title = approvalTitle(record.chats.length);
    let reason: PluginInteractionCancelReason | null = null;

    try {
      const result = await ui.requestInput(
        {
          threadId: record.sourceThreadId,
          rendererId: ARCHIVE_APPROVAL_RENDERER_ID,
          title,
          payload: { threadIds: record.chats.map(({ threadId }) => threadId) },
          timeoutMs: remaining,
          presentation: {
            label: { pending: title, completed: "Archive reviewed" },
            icon: { glyph: "Archive" },
          },
          describeSubmission: (value) => {
            const parsed = archiveResultSchema.safeParse(value);

            return describe(record, parsed.success ? parsed.data : null);
          },
        },
        { signal: controller.signal },
      );

      if (result.outcome === "cancelled") reason = result.reason;
    } catch (cause) {
      failed.add(key);
      log.warn(
        `Tidy couldn't pin the archive approval in chat ${record.sourceThreadId}: ${errorText(cause)}`,
      );

      return;
    } finally {
      if (open.get(key) === controller) open.delete(key);
    }

    if (reason === null || SETTLED_REASONS.has(reason)) await forget(key, record);
    else if (reason === "thread-stopped" && !disposed && records.get(key) === record)
      await ask(key, record);
  }

  function launch(key: string, record: ArchiveProposal): void {
    void ask(key, record).catch((cause) =>
      log.warn(`Tidy archive approval failed: ${errorText(cause)}`),
    );
  }

  async function withdraw(key: string): Promise<void> {
    const controller = open.get(key);

    if (controller !== undefined) {
      controller.abort();

      return;
    }

    const record = records.get(key);

    if (record !== undefined) await forget(key, record);
  }

  return {
    async propose(
      sourceThreadId: string,
      chats: ArchiveProposal["chats"],
    ): Promise<"pinned" | "already-pinned"> {
      await loaded;

      const key = proposalKey(
        sourceThreadId,
        chats.map(({ threadId }) => threadId),
      );

      for (const [other, record] of records)
        if (other !== key && record.sourceThreadId === sourceThreadId) await withdraw(other);

      if (open.has(key)) return "already-pinned";
      const record = records.get(key) ?? { sourceThreadId, chats, createdAt: now() };

      records.set(key, record);
      failed.delete(key);
      launch(key, record);
      await kv.set(key, record);

      return "pinned";
    },

    async reconcile(readyIds: ReadonlySet<string>): Promise<void> {
      await loaded;

      for (const [key, record] of records) {
        if (disposed) return;

        if (record.createdAt + PROPOSAL_LIFETIME_MS <= now()) await withdraw(key);
        else if (
          !approving.has(key) &&
          !record.chats.some(({ threadId }) => readyIds.has(threadId))
        )
          await withdraw(key);
        else if (!open.has(key) && !failed.has(key)) launch(key, record);
      }
    },

    async withdrawSource(threadId: string): Promise<void> {
      await loaded;

      for (const [key, record] of records)
        if (record.sourceThreadId === threadId) await withdraw(key);
    },

    approving(sourceThreadId: string): void {
      for (const [key, record] of records)
        if (record.sourceThreadId === sourceThreadId) approving.add(key);
    },

    dispose(): void {
      disposed = true;
    },
  };
}
