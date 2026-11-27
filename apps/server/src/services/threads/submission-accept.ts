import { createHash } from "node:crypto";
import {
  findSubmissionReceipt,
  insertSubmissionReceipt,
  PrimaryWriteBusyError,
  readCoordinatorStoreId,
  runImmediateTransactionWithBusyWait,
  type DbTransaction,
  type SubmissionReceiptKey,
  type SubmissionReceiptRow,
} from "@omnyo/db";
import type { PromptInput } from "@omnyo/domain";
import {
  SUBMISSION_CONTRACT_VERSION,
  type SubmissionContract,
  type SubmissionReceipt,
  type SubmitRequest,
} from "@omnyo/server-contract";
import { ApiError } from "../../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import type { InboxActor } from "../inbox/actor.js";
import { collectAfterCommit } from "../lib/after-commit.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import {
  readAttachmentBytes,
  readAttachmentMetadata,
} from "../projects/attachments.js";
import {
  isServerMoveFrozen,
  serverMovingError,
} from "../server-move/freeze-state.js";
import { prepareQueuedMessageAcceptance } from "./queued-messages.js";
import { createThreadFromRequest } from "./thread-create.js";

const SUBMISSION_WRITE_BUSY_WAIT_MS = 125;

interface AcceptSubmissionArgs {
  actor: InboxActor;
  launchedByThreadId: string | null;
  request: SubmitRequest;
}

interface AcceptedSubmissionEffect {
  queuedMessageId: string;
  threadId: string;
}

interface CommittedSubmission {
  created: boolean;
  row: SubmissionReceiptRow;
}

function requireCoordinatorStoreId(deps: Pick<AppDeps, "db">): string {
  const storeId = readCoordinatorStoreId(deps.db);

  if (storeId === null) {
    throw new Error("The coordinator store has no identity");
  }

  return storeId;
}

export function readSubmissionContract(
  deps: Pick<AppDeps, "db">,
): SubmissionContract {
  return {
    version: SUBMISSION_CONTRACT_VERSION,
    storeId: requireCoordinatorStoreId(deps),
  };
}

function submissionActorKey(actor: InboxActor): string {
  switch (actor.kind) {
    case "owner":
      return "owner";
    case "thread":
      return `thread:${actor.threadId}`;
    case "automation":
      return `automation:${actor.automationId}`;
    case "plugin":
      return `plugin:${actor.pluginId}`;
  }
}

function submissionInput(request: SubmitRequest): PromptInput[] {
  return request.action.kind === "thread-message"
    ? request.action.message.input
    : request.action.thread.input;
}

function assertDeclaredAttachments(request: SubmitRequest): void {
  const referenced = new Set(
    submissionInput(request).flatMap((item) =>
      item.type === "localFile" || item.type === "localImage"
        ? [item.path]
        : [],
    ),
  );

  const declared = new Set<string>();

  for (const attachment of request.attachments) {
    if (declared.has(attachment.path) || !referenced.has(attachment.path)) {
      throw new ApiError(
        400,
        "invalid_request",
        "Each declared attachment must match exactly one attachment in the input",
      );
    }

    declared.add(attachment.path);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }

  return value;
}

function submissionIntentDigest(request: SubmitRequest): string {
  const declared = new Map(
    request.attachments.map((attachment) => [attachment.path, attachment]),
  );

  const input = submissionInput(request).map((item) => {
    if (item.type !== "localFile" && item.type !== "localImage") {
      return item;
    }

    const attachment = declared.get(item.path);

    if (attachment === undefined) {
      return item;
    }

    const { path: _path, ...rest } = item;

    return {
      ...rest,
      content: { sha256: attachment.sha256, sizeBytes: attachment.sizeBytes },
    };
  });

  const action =
    request.action.kind === "thread-message"
      ? {
          kind: request.action.kind,
          threadId: request.action.threadId,
          message: { ...request.action.message, input },
        }
      : {
          kind: request.action.kind,
          thread: { ...request.action.thread, input },
        };

  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ version: request.version, action })))
    .digest("hex");
}

async function verifyDeclaredAttachments(
  deps: Pick<AppDeps, "config">,
  args: { projectId: string; request: SubmitRequest },
): Promise<void> {
  const sourceProjectByPath = new Map(
    submissionInput(args.request).flatMap((item) =>
      item.type === "localFile" || item.type === "localImage"
        ? [[item.path, item.sourceProjectId ?? args.projectId] as const]
        : [],
    ),
  );

  for (const attachment of args.request.attachments) {
    const metadata = await readAttachmentMetadata(
      deps.config.dataDir,
      sourceProjectByPath.get(attachment.path) ?? args.projectId,
      attachment.path,
    );

    const bytes = await readAttachmentBytes(metadata);

    const sha256 = Buffer.from(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ).toString("hex");

    if (
      bytes.byteLength !== attachment.sizeBytes ||
      sha256 !== attachment.sha256
    ) {
      throw new ApiError(
        400,
        "attachment_content_mismatch",
        "An uploaded attachment does not match the content this submission declared",
      );
    }
  }
}

function assertSameIntent(row: SubmissionReceiptRow, digest: string): void {
  if (row.intentDigest !== digest) {
    throw new ApiError(
      409,
      "submission_conflict",
      "This submission ID was already accepted with different content",
    );
  }
}

function toSubmissionReceipt(
  row: SubmissionReceiptRow,
  args: { replayed: boolean; storeId: string },
): SubmissionReceipt {
  return {
    version: SUBMISSION_CONTRACT_VERSION,
    submissionId: row.submissionId,
    storeId: args.storeId,
    action: row.action,
    threadId: row.threadId,
    queuedMessageId: row.queuedMessageId,
    acceptedAt: row.acceptedAt,
    replayed: args.replayed,
  };
}

async function commitSubmission(
  deps: Pick<AppDeps, "db" | "logger">,
  args: {
    action: SubmissionReceiptRow["action"];
    create: (tx: DbTransaction) => AcceptedSubmissionEffect;
    digest: string;
    key: SubmissionReceiptKey;
  },
): Promise<CommittedSubmission> {
  let collected: ReturnType<typeof collectAfterCommit<CommittedSubmission>>;

  const assertWritable = () => {
    if (isServerMoveFrozen(deps.db)) throw serverMovingError();
  };

  try {
    collected = await runImmediateTransactionWithBusyWait(
      deps.db,
      SUBMISSION_WRITE_BUSY_WAIT_MS,
      (tx) =>
        collectAfterCommit((): CommittedSubmission => {
          assertWritable();

          const existing = findSubmissionReceipt(tx, args.key);

          if (existing !== null) {
            assertSameIntent(existing, args.digest);

            return { created: false, row: existing };
          }

          const accepted = args.create(tx);

          const row: SubmissionReceiptRow = {
            ...args.key,
            action: args.action,
            intentDigest: args.digest,
            threadId: accepted.threadId,
            queuedMessageId: accepted.queuedMessageId,
            acceptedAt: Date.now(),
          };

          insertSubmissionReceipt(tx, row);

          return { created: true, row };
        }),
      assertWritable,
    );
  } catch (error) {
    if (error instanceof PrimaryWriteBusyError) {
      deps.logger.warn(
        { submissionId: args.key.submissionId, waitMs: error.waitMs },
        "Refused a submission while the primary write lock was held",
      );

      throw new ApiError(
        503,
        "coordinator_busy",
        "The coordinator could not take its write lock in time; retry the submission",
        true,
      );
    }

    throw error;
  }

  for (const action of collected.actions) {
    try {
      action();
    } catch (error) {
      deps.logger.error(
        { err: error, submissionId: args.key.submissionId },
        "Submission step failed after its commit",
      );
    }
  }

  return collected.result;
}

export async function acceptSubmission(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptSubmissionArgs,
): Promise<SubmissionReceipt> {
  const { request } = args;
  const storeId = requireCoordinatorStoreId(deps);

  if (request.storeId !== storeId) {
    throw new ApiError(
      409,
      "store_mismatch",
      "This submission was staged for a different Omnyo store",
    );
  }

  assertDeclaredAttachments(request);

  const key: SubmissionReceiptKey = {
    actorKey: submissionActorKey(args.actor),
    submissionId: request.submissionId,
  };

  const digest = submissionIntentDigest(request);
  const existing = findSubmissionReceipt(deps.db, key);

  if (existing !== null) {
    assertSameIntent(existing, digest);

    return toSubmissionReceipt(existing, { replayed: true, storeId });
  }

  if (request.action.kind === "thread-message") {
    const thread = requirePublicThread(deps.db, request.action.threadId);

    await verifyDeclaredAttachments(deps, {
      projectId: thread.projectId,
      request,
    });

    const acceptance = await prepareQueuedMessageAcceptance(deps, {
      payload: request.action.message,
      thread,
    });

    const committed = await commitSubmission(deps, {
      action: "thread-message",
      create: (tx) => ({
        queuedMessageId: acceptance.insert(tx, { collapseDuplicates: false })
          .row.id,
        threadId: thread.id,
      }),
      digest,
      key,
    });

    if (committed.created) {
      acceptance.announce();
    }

    return toSubmissionReceipt(committed.row, {
      replayed: !committed.created,
      storeId,
    });
  }

  const threadRequest = request.action.thread;

  if (
    threadRequest.originKind === "fork" ||
    threadRequest.pluginSubmission !== undefined
  ) {
    throw new ApiError(
      400,
      "unsupported_submission",
      "Forks and plugin submissions are not accepted through submissions yet",
    );
  }

  await verifyDeclaredAttachments(deps, {
    projectId: threadRequest.projectId,
    request,
  });

  let committed: CommittedSubmission | null = null;

  await createThreadFromRequest(
    deps,
    {
      ...threadRequest,
      ...(args.launchedByThreadId === null
        ? {}
        : { launchedByThreadId: args.launchedByThreadId }),
    },
    {
      acceptQueuedFirstPrompt: async (create) => {
        const outcome = await commitSubmission(deps, {
          action: "new-thread",
          create,
          digest,
          key,
        });

        committed = outcome;

        return { created: outcome.created, threadId: outcome.row.threadId };
      },
    },
  );

  if (committed === null) {
    throw new Error("New chat creation ended without accepting its submission");
  }

  const outcome: CommittedSubmission = committed;

  return toSubmissionReceipt(outcome.row, {
    replayed: !outcome.created,
    storeId,
  });
}
