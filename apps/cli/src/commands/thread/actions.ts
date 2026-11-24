import { Command } from "commander";
import { randomUUID } from "node:crypto";
import {
  threadVisibilitySchema,
  type PermissionMode,
  type ReasoningLevel,
  type ServiceTier,
  type ThreadVisibility,
} from "@omnyo/domain";
import {
  submissionIdSchema,
  threadEnvironmentUnavailableApiErrorSchema,
  type SubmissionAttachment,
  type SubmissionReceipt,
} from "@omnyo/server-contract";
import { action, CliExitError } from "../../action.js";
import { createCliOmnyoSdk } from "../../client.js";
import { requireTextInput, TEXT_FILE_HELP_SUFFIX } from "../../text-input.js";
import {
  OmnyoHttpError,
  type ThreadRetryResult,
  type ThreadSendResult,
} from "@omnyo/sdk";
import type { QueuedMessageWaitingOn } from "@omnyo/domain";
import {
  collectOption,
  confirmDestructiveAction,
  outputJson,
  parseReasoningLevel,
  prependErrorContext,
  requireThreadIdOrSelf,
} from "../helpers.js";
import {
  resolveContextThreadId,
  resolveExplicitIdFlag,
} from "../../context-env.js";
import {
  parsePermissionMode,
  parseServiceTier,
  SERVICE_TIER_HELP,
  PERMISSION_MODE_HELP,
  PLAN_HELP,
  buildPromptInputs,
  uploadClientAttachmentInputs,
} from "./helpers.js";
import { SEND_AT_HELP, parseSendAt } from "./send-time.js";
import { resolveMachineId } from "../machine.js";

interface ThreadUpdateCommandOptions {
  serviceTier?: string;
  self?: boolean;
  json?: boolean;
  title?: string;
  titleIfUntitled?: boolean;
  parentThread?: string;
  clearParentThread?: boolean;
  section?: string;
  clearSection?: boolean;
  group?: string;
  clearGroup?: boolean;
  model?: string;
  reasoningLevel?: string;
  visibility?: string;
}

interface ThreadArchiveCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadUnarchiveCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadRestoreEnvironmentCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadStartOnCommandOptions {
  self?: boolean;
  machine?: string;
  json?: boolean;
}

interface ThreadPlacementCommandOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadDeleteCommandOptions {
  confirmChildThreads?: boolean;
  yes?: boolean;
  json?: boolean;
}

interface ThreadTellCommandOptions {
  source?: string;
  json?: boolean;
  messageFile?: string;
  model?: string;
  permissionMode?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  mode?: string;
  plan?: boolean;
  file?: string[];
  image?: string[];
  sendAt?: string;
  compactFirst?: boolean;
  sendNow?: boolean;
  submissionId?: string;
}

interface ThreadActionOptions {
  self?: boolean;
  json?: boolean;
}

interface ThreadContinueCommandOptions extends ThreadActionOptions {
  all?: boolean;
  status?: boolean;
  now?: boolean;
  model?: string;
}

interface ThreadRetryCommandOptions {
  self?: boolean;
  json?: boolean;
  turn?: string;
  sendAt?: string;
  reason?: string;
}

interface ThreadEditMessageCommandOptions {
  expectedRequestSequence?: string;
  json?: boolean;
  message?: string;
  messageFile?: string;
  self?: boolean;
}

type ThreadTellDeliveryMode = "auto" | "queue" | "steer";

interface PostThreadMessageArgs {
  getUrl: () => string;
  threadId: string;
  message: string;
  mode: ThreadTellDeliveryMode;
  model?: string;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  senderThreadId?: string;
  source?: string;
  plan?: boolean;
  files?: readonly string[];
  images?: readonly string[];
  sendAt?: number;
  compactFirst: boolean;
  sendNow: boolean;
}

type PostThreadMessageResult = ThreadSendResult & {
  mode: ThreadTellDeliveryMode;
};

interface ThreadUpdateBody {
  serviceTier?: ServiceTier;
  title?: string;
  experimental_titleIfUntitled?: true;
  sectionId?: string | null;
  groupId?: string | null;
  parentThreadId?: string | null;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  visibility?: ThreadVisibility;
}

export function registerActionsCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("update [id]")
    .description("Update a thread")
    .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option("--title <title>", "Set the thread title")
    .option(
      "--title-if-untitled",
      "Set --title only while the thread is untitled; cannot combine with other changes",
    )
    .option("--parent-thread <id>", "Set the parent thread id")
    .option("--clear-parent-thread", "Clear the parent thread id")
    .option("--section <id>", "Move the thread into a section")
    .option("--clear-section", "Remove the thread from its section")
    .option("--group <id>", "Move the chat into a group in its project")
    .option("--clear-group", "Remove the chat from its group")
    .option(
      "--model <model>",
      "Set the sticky model applied on the thread's next turn",
    )
    .option(
      "--reasoning-level <level>",
      "Set the sticky reasoning level applied on the thread's next turn: low, medium, high, xhigh, max (provider-dependent)",
    )
    .option(
      "--service-tier <tier>",
      "Change session speed immediately: default, fast, ultrafast (provider-dependent)",
    )
    .option("--visibility <visibility>", "Thread visibility: visible or hidden")
    .action(
      action(
        async (id: string | undefined, opts: ThreadUpdateCommandOptions) => {
          if (
            opts.titleIfUntitled &&
            (!opts.title ||
              opts.parentThread ||
              opts.clearParentThread ||
              opts.section ||
              opts.clearSection ||
              opts.group ||
              opts.clearGroup ||
              opts.model ||
              opts.reasoningLevel ||
              opts.serviceTier ||
              opts.visibility)
          ) {
            throw new Error(
              "--title-if-untitled requires --title without other changes.",
            );
          }

          if (opts.parentThread && opts.clearParentThread) {
            throw new Error(
              "Cannot combine --parent-thread with --clear-parent-thread.",
            );
          }

          if (opts.section && opts.clearSection) {
            throw new Error("Cannot combine --section with --clear-section.");
          }

          if (opts.group && opts.clearGroup) {
            throw new Error("Cannot combine --group with --clear-group.");
          }

          const serviceTier = parseServiceTier(opts.serviceTier);
          const reasoningLevel = parseReasoningLevel(opts.reasoningLevel);

          const visibility =
            opts.visibility === undefined
              ? undefined
              : threadVisibilitySchema.parse(opts.visibility);

          if (
            !opts.parentThread &&
            !opts.clearParentThread &&
            !opts.section &&
            !opts.clearSection &&
            !opts.group &&
            !opts.clearGroup &&
            !opts.title &&
            !opts.model &&
            !reasoningLevel &&
            !serviceTier &&
            !visibility
          ) {
            throw new Error(
              "No changes requested. Provide --title, --parent-thread, --clear-parent-thread, --section, --clear-section, --group, --clear-group, --model, --reasoning-level, --service-tier, or --visibility.",
            );
          }

          const threadId = requireThreadIdOrSelf(id, opts);

          const parentThreadId = resolveExplicitIdFlag({
            flagName: "--parent-thread",
            value: opts.parentThread,
          });

          const body: ThreadUpdateBody = {};

          if (opts.title) {
            body.title = opts.title;
          }

          if (opts.titleIfUntitled) {
            body.experimental_titleIfUntitled = true;
          }

          if (parentThreadId) {
            body.parentThreadId = parentThreadId;
          } else if (opts.clearParentThread) {
            body.parentThreadId = null;
          }

          if (opts.section) {
            body.sectionId = resolveExplicitIdFlag({
              flagName: "--section",
              value: opts.section,
            });
          } else if (opts.clearSection) {
            body.sectionId = null;
          }

          if (opts.group) {
            body.groupId = resolveExplicitIdFlag({
              flagName: "--group",
              value: opts.group,
            });
          } else if (opts.clearGroup) {
            body.groupId = null;
          }

          if (opts.model) {
            body.model = opts.model;
          }

          if (serviceTier !== undefined) body.serviceTier = serviceTier;

          if (reasoningLevel) {
            body.reasoningLevel = reasoningLevel;
          }

          if (visibility) {
            body.visibility = visibility;
          }

          const sdk = createCliOmnyoSdk(getUrl());
          const thread = await sdk.threads.update({ threadId, ...body });

          if (
            opts.titleIfUntitled &&
            typeof thread.experimental_titleApplied !== "boolean"
          ) {
            throw new Error(
              "The server did not confirm the title change. Check the chat title before retrying.",
            );
          }

          if (outputJson(opts, thread)) return;
          console.log(
            opts.titleIfUntitled
              ? thread.experimental_titleApplied
                ? `Thread ${thread.id} titled`
                : `Thread ${thread.id} title unchanged`
              : `Thread ${thread.id} updated`,
          );

          if (opts.title) {
            console.log(`Title: ${thread.title ?? "<untitled>"}`);
          }

          if (opts.parentThread || opts.clearParentThread) {
            console.log(
              thread.parentThreadId
                ? `Parent: ${thread.parentThreadId}`
                : "No parent thread",
            );
          }

          if (opts.section || opts.clearSection) {
            console.log(
              thread.sectionId ? `Section: ${thread.sectionId}` : "No section",
            );
          }

          if (opts.group || opts.clearGroup) {
            console.log(
              thread.groupId ? `Group: ${thread.groupId}` : "No group",
            );
          }

          if (opts.model) {
            console.log(`Model: ${opts.model}`);
          }

          if (reasoningLevel) {
            console.log(`Reasoning level: ${reasoningLevel}`);
          }

          if (visibility) {
            console.log(`Visibility: ${visibility}`);
          }
        },
      ),
    );

  parent
    .command("archive [id]")
    .description("Archive a thread")
    .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadArchiveCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliOmnyoSdk(getUrl());
          let archivedThreadIds: string[] = [threadId];

          try {
            const result = await sdk.threads.archive({ threadId });
            archivedThreadIds = result.archivedThreadIds;
          } catch (err: unknown) {
            throw prependErrorContext(
              `Failed to archive thread ${threadId}`,
              err,
            );
          }

          if (
            outputJson(opts, {
              ok: true,
              threadId,
              archivedThreadIds,
            })
          ) {
            return;
          }

          const cascadedCount = archivedThreadIds.filter(
            (archivedId) => archivedId !== threadId,
          ).length;

          if (cascadedCount === 0) {
            console.log(`Thread ${threadId} archived`);

            return;
          }

          console.log(
            `Thread ${threadId} archived (${cascadedCount} related thread${cascadedCount === 1 ? "" : "s"} also archived)`,
          );
        },
      ),
    );

  parent
    .command("unarchive [id]")
    .description("Unarchive a thread")
    .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadUnarchiveCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliOmnyoSdk(getUrl());
          await sdk.threads.unarchive({ threadId });

          if (outputJson(opts, { ok: true, threadId })) return;
          console.log(`Thread ${threadId} unarchived`);
        },
      ),
    );

  parent
    .command("restore-environment [id]")
    .description(
      "Restore the workspace of a thread whose environment was destroyed, when its environment provider supports restoring",
    )
    .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          id: string | undefined,
          opts: ThreadRestoreEnvironmentCommandOptions,
        ) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliOmnyoSdk(getUrl());
          let thread;

          try {
            thread = await sdk.threads.restoreEnvironment({ threadId });
          } catch (err: unknown) {
            throw prependErrorContext(
              `Failed to restore the workspace for thread ${threadId}`,
              err,
            );
          }

          if (outputJson(opts, thread)) return;
          console.log(
            `Thread ${threadId} is restoring its workspace (status: ${thread.status})`,
          );
        },
      ),
    );

  parent
    .command("start-on [id]")
    .description(
      "Start a waiting new thread on another machine, or list the machines it can start on",
    )
    .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
    .option(
      "--machine <id-or-name>",
      "Machine to start on; omit to list the machines and why each can or cannot take the thread",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadStartOnCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliOmnyoSdk(getUrl());

          const listing = await sdk.threads.experimental_listStartMachines({
            threadId,
          });

          if (opts.machine === undefined) {
            if (outputJson(opts, listing)) return;

            for (const machine of listing.machines) {
              console.log(
                `${machine.name} (${machine.hostId}): ${machine.eligible ? "can start here" : machine.reason}`,
              );
            }

            return;
          }

          if (listing.originHostId === null) {
            throw new CliExitError(
              `Thread ${threadId} is not a waiting new thread`,
              1,
              { code: "not_waiting", hint: null },
            );
          }

          const hosts = await sdk.hosts.list({ includeCreating: true });
          const hostId = resolveMachineId(hosts, opts.machine);

          const result = await sdk.threads.experimental_moveStart({
            threadId,
            hostId,
            expectedHostId: listing.originHostId,
          });

          if (result.kind === "refused") {
            if (outputJson(opts, result)) {
              process.exitCode = 1;

              return;
            }

            throw new CliExitError(result.message, 1, {
              code: result.code,
              hint: `Run \`omnyo thread start-on ${threadId}\` to see which machines can take it.`,
            });
          }

          if (outputJson(opts, result)) return;
          console.log(
            `Thread ${threadId} will start on ${hosts.find((host) => host.id === hostId)?.name ?? hostId}`,
          );
        },
      ),
    );

  for (const { name, description, done } of [
    { name: "pin", description: "Pin a thread", done: "pinned" },
    { name: "unpin", description: "Unpin a thread", done: "unpinned" },
    {
      name: "shelve",
      description: "Shelve a top-level thread and its child threads",
      done: "shelved",
    },
    {
      name: "unshelve",
      description: "Unshelve a thread and the rest of its family",
      done: "unshelved",
    },
  ] as const) {
    parent
      .command(`${name} [id]`)
      .description(description)
      .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(
          async (
            id: string | undefined,
            opts: ThreadPlacementCommandOptions,
          ) => {
            const threadId = requireThreadIdOrSelf(id, opts);
            const sdk = createCliOmnyoSdk(getUrl());
            const thread = await sdk.threads[name]({ threadId });

            if (outputJson(opts, thread)) return;
            console.log(`Thread ${thread.id} ${done}`);
          },
        ),
      );
  }

  parent
    .command("delete <id>")
    .description("Delete a thread permanently")
    .option("--yes", "Skip the confirmation prompt")
    .option(
      "--confirm-child-threads",
      "Confirm deleting a thread with child threads",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ThreadDeleteCommandOptions) => {
        const sdk = createCliOmnyoSdk(getUrl());

        try {
          const thread = await sdk.threads.get({ threadId: id });

          if (!opts.yes) {
            const confirmed = await confirmDestructiveAction(
              `Delete thread "${thread.title ?? thread.titleFallback ?? thread.id}" permanently? This cannot be undone.`,
            );

            if (!confirmed) {
              console.log(`Thread ${id} deletion cancelled`);

              return;
            }
          }

          await sdk.threads.delete({
            threadId: id,
            childThreadsConfirmed: opts.confirmChildThreads === true,
          });
        } catch (err: unknown) {
          throw prependErrorContext(`Failed to delete thread ${id}`, err);
        }

        if (outputJson(opts, { ok: true, threadId: id })) return;
        console.log(`Thread ${id} deleted`);
      }),
    );

  parent
    .command("edit-message [id]")
    .description("Replace an accepted user message and rerun from that point")
    .option("--message <text>", "Replacement message text")
    .option(
      "--message-file <path>",
      `Read the replacement message from a file; ${TEXT_FILE_HELP_SUFFIX}`,
    )
    .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
    .option(
      "--expected-request-sequence <sequence>",
      "Edit the message at this event sequence (default: the latest editable message)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          id: string | undefined,
          opts: ThreadEditMessageCommandOptions,
        ) => {
          const threadId = requireThreadIdOrSelf(id, opts);

          const message = await requireTextInput({
            file: opts.messageFile,
            fileLabel: "--message-file",
            inline: opts.message,
            inlineLabel: "--message <text>",
          });

          const sdk = createCliOmnyoSdk(getUrl());

          const expectedRequestSequence =
            opts.expectedRequestSequence === undefined
              ? undefined
              : Number(opts.expectedRequestSequence);

          if (
            expectedRequestSequence !== undefined &&
            (!Number.isInteger(expectedRequestSequence) ||
              expectedRequestSequence < 0)
          ) {
            throw new Error(
              "--expected-request-sequence must be a non-negative integer.",
            );
          }

          const senderThreadId = resolveSenderThreadId(threadId);

          const result = await sdk.threads.editMessage({
            threadId,
            operationId: randomUUID(),
            ...(expectedRequestSequence !== undefined
              ? { expectedRequestSequence }
              : {}),
            input: buildPromptInputs({ message }),
            ...(senderThreadId !== undefined ? { senderThreadId } : {}),
          });

          if (outputJson(opts, { threadId, ...result })) {
            return;
          }

          console.log(
            `Thread ${threadId} message replaced; workspace changes were kept`,
          );
        },
      ),
    );

  parent
    .command("tell <id> [message]")
    .aliases(["message", "send"])
    .description("Send a follow-up message to a thread")
    .option(
      "--source <name>",
      "Name the sending script; messages otherwise show CLI or the calling chat",
    )
    .option(
      "--message-file <path>",
      `Read the message from a file instead of [message]; ${TEXT_FILE_HELP_SUFFIX}`,
    )
    .option("--json", "Print machine-readable JSON output")
    .option("--model <model>", "Model ID for this message")
    .option("--service-tier <tier>", SERVICE_TIER_HELP)
    .option(
      "--reasoning-level <level>",
      "Reasoning level id the model lists: low, medium, high, xhigh, max, or a provider-specific id",
    )
    .option("--permission-mode <mode>", PERMISSION_MODE_HELP)
    .option(
      "--mode <mode>",
      "Message mode: steer (default), queue, or auto (steer a live turn, else start one)",
    )
    .option("--send-at <when>", SEND_AT_HELP)
    .option("--send-now", "Bypass plugin dispatch holds and send now")
    .option(
      "--compact-first",
      "Compact the idle thread's context first, then send this message when compaction finishes",
    )
    .option("--plan", PLAN_HELP)
    .option(
      "--file <path>",
      "Upload an absolute path or file: URL from this CLI machine or pass an uploaded attachment path (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--image <path>",
      "Upload an absolute path or file: URL from this CLI machine or pass an uploaded attachment path (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--submission-id <id>",
      "Retry-safe queued send: repeating the same ID (sub_ plus 32 hex digits) returns the original acceptance instead of a second message; requires --mode queue",
    )
    .action(
      action(
        async (
          id: string,
          inlineMessage: string | undefined,
          opts: ThreadTellCommandOptions,
        ) => {
          const message = await requireTextInput({
            file: opts.messageFile,
            fileLabel: "--message-file",
            inline: inlineMessage,
            inlineLabel: "<message>",
          });

          if (opts.submissionId !== undefined) {
            const receipt = await postThreadSubmission({
              getUrl,
              threadId: id,
              message,
              model: opts.model,
              permissionMode: parsePermissionMode(opts.permissionMode),
              reasoningLevel: parseReasoningLevel(opts.reasoningLevel),
              serviceTier: parseServiceTier(opts.serviceTier),
              senderThreadId: resolveSenderThreadId(id),
              source: opts.source,
              plan: opts.plan,
              files: opts.file,
              images: opts.image,
              submissionId: requireSubmissionId(opts),
            });

            if (outputJson(opts, receipt)) return;
            console.log(
              receipt.replayed
                ? `Thread ${id} had already accepted submission ${receipt.submissionId}`
                : `Thread ${id} accepted submission ${receipt.submissionId}`,
            );

            return;
          }

          const response = await postThreadMessage({
            getUrl,
            threadId: id,
            message,
            mode: resolveThreadMessageMode(opts.mode),
            model: opts.model,
            permissionMode: parsePermissionMode(opts.permissionMode),
            reasoningLevel: parseReasoningLevel(opts.reasoningLevel),
            serviceTier: parseServiceTier(opts.serviceTier),
            senderThreadId: resolveSenderThreadId(id),
            source: opts.source,
            plan: opts.plan,
            files: opts.file,
            images: opts.image,
            ...(opts.sendAt === undefined
              ? {}
              : { sendAt: parseSendAt(opts.sendAt) }),
            compactFirst: opts.compactFirst === true,
            sendNow: opts.sendNow === true,
          });

          if (outputJson(opts, { threadId: id, ...response })) return;
          console.log(
            opts.compactFirst === true
              ? `Thread ${id} compacting; the message sends when compaction finishes`
              : describeThreadTellOutcome(id, response),
          );
        },
      ),
    );

  parent
    .command("continue [id]")
    .description("Continue an errored chat, preserving scheduled recovery")
    .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
    .option("--all", "Continue all eligible visible errored chats")
    .option("--now", "Attempt the scheduled recovery now")
    .option(
      "--model <model>",
      "Continue with another model from the same provider",
    )
    .option(
      "--status",
      "Inspect continuation eligibility without starting work",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadContinueCommandOptions) => {
          if (opts.all && (id !== undefined || opts.self))
            throw new Error("Use either a thread or --all.");

          if (opts.all && (opts.now || opts.model))
            throw new Error("Use --now and --model with one chat.");
          const sdk = createCliOmnyoSdk(getUrl());

          if (opts.all) {
            const result = opts.status
              ? await sdk.threads.experimental_continuations()
              : await sdk.threads.experimental_continueAll();

            if (outputJson(opts, result)) return;

            if ("results" in result)
              for (const entry of result.results)
                console.log(
                  `${entry.threadId}: ${entry.message ?? entry.outcome}`,
                );
            else
              for (const entry of result.threads)
                console.log(
                  `${entry.threadId}: ${entry.message ?? (entry.pending ? "recovery pending" : entry.action)}`,
                );

            return;
          }

          const threadId = requireThreadIdOrSelf(id, opts);

          const result = opts.status
            ? await sdk.threads.experimental_continuationState({ threadId })
            : await sdk.threads.experimental_continue({
                threadId,
                now: opts.now,
                model: opts.model,
              });

          if (outputJson(opts, result)) return;
          console.log(
            `${threadId}: ${result.message ?? ("outcome" in result ? result.outcome : result.pending ? "recovery pending" : result.action)}`,
          );
        },
      ),
    );

  parent
    .command("retry [id]")
    .description("Retry the failed turn on a thread")
    .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
    .option(
      "--turn <requestId>",
      "Retry this turn request id specifically; fails when it is not the thread's failed turn",
    )
    .option("--send-at <when>", SEND_AT_HELP)
    .option(
      "--reason <text>",
      "Why it is being retried, shown on the queued row",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadRetryCommandOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliOmnyoSdk(getUrl());

          const response = await sdk.threads.retry({
            threadId,
            ...(opts.turn === undefined ? {} : { turnRequestId: opts.turn }),
            ...(opts.sendAt === undefined
              ? {}
              : { sendAt: parseSendAt(opts.sendAt) }),
            ...(opts.reason === undefined ? {} : { reason: opts.reason }),
          });

          if (outputJson(opts, { threadId, ...response })) return;
          console.log(describeThreadRetryOutcome(threadId, response));
        },
      ),
    );

  for (const { name, description, method, done } of [
    {
      name: "stop",
      description: "Stop work and release the loaded agent runtime",
      method: "stop",
      done: "stopped",
    },
    {
      name: "compact",
      description: "Request compaction of an idle or errored thread's context",
      method: "compact",
      done: "context compaction requested",
    },
    {
      name: "clear",
      description: "Clear model context for an idle or failed thread",
      method: "clearContext",
      done: "context cleared",
    },
    {
      name: "cancel-plan",
      description: "Ask the provider to exit the active Plan mode",
      method: "cancelPlan",
      done: "exited Plan mode",
    },
    {
      name: "clear-goal",
      description: "Ask the provider to clear the active Goal",
      method: "clearGoal",
      done: "cleared its Goal",
    },
  ] as const) {
    parent
      .command(`${name} [id]`)
      .description(description)
      .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (id: string | undefined, opts: ThreadActionOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliOmnyoSdk(getUrl());
          await sdk.threads[method]({ threadId });

          if (outputJson(opts, { ok: true, threadId })) return;
          console.log(`Thread ${threadId} ${done}`);
        }),
      );
  }
}

async function postThreadMessage(
  args: PostThreadMessageArgs,
): Promise<PostThreadMessageResult> {
  const sdk = createCliOmnyoSdk(args.getUrl());

  const input = await uploadClientAttachmentInputs({
    input: buildPromptInputs({
      message: args.message,
      plan: args.plan,
      files: args.files,
      images: args.images,
    }),
    resolveProjectId: async () =>
      (await sdk.threads.get({ threadId: args.threadId })).projectId,
    sdk,
  });

  let response: ThreadSendResult;

  try {
    response = await sdk.threads.send({
      threadId: args.threadId,
      input,
      mode:
        args.mode === "steer"
          ? "steer-if-active"
          : args.mode === "auto"
            ? "auto"
            : "queue-if-active",
      ...(args.model ? { model: args.model } : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
      ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
      ...(args.senderThreadId ? { senderThreadId: args.senderThreadId } : {}),
      ...(args.source === undefined
        ? {}
        : { messageSource: { kind: "script" as const, label: args.source } }),
      ...(args.sendAt === undefined ? {} : { sendAt: args.sendAt }),
      ...(args.compactFirst ? { compactFirst: true } : {}),
      ...(args.sendNow ? { sendNow: true } : {}),
    });
  } catch (error: unknown) {
    throw await withRestoreEnvironmentHint(sdk, args.threadId, error);
  }

  return { ...response, mode: args.mode };
}

function requireSubmissionId(opts: ThreadTellCommandOptions): string {
  const parsed = submissionIdSchema.safeParse(opts.submissionId);

  if (!parsed.success) {
    throw new Error(
      "--submission-id must be sub_ followed by 32 lowercase hex digits",
    );
  }

  if (
    resolveThreadMessageMode(opts.mode) !== "queue" ||
    opts.sendAt !== undefined ||
    opts.compactFirst === true ||
    opts.sendNow === true
  ) {
    throw new Error(
      "--submission-id requires --mode queue and cannot be combined with --send-at, --compact-first or --send-now",
    );
  }

  return parsed.data;
}

async function postThreadSubmission(
  args: Omit<
    PostThreadMessageArgs,
    "compactFirst" | "mode" | "sendAt" | "sendNow"
  > & { submissionId: string },
): Promise<SubmissionReceipt> {
  const sdk = createCliOmnyoSdk(args.getUrl());
  const attachments: SubmissionAttachment[] = [];

  const input = await uploadClientAttachmentInputs({
    input: buildPromptInputs({
      message: args.message,
      plan: args.plan,
      files: args.files,
      images: args.images,
    }),
    onUploaded: (attachment) => attachments.push(attachment),
    resolveProjectId: async () =>
      (await sdk.threads.get({ threadId: args.threadId })).projectId,
    sdk,
  });

  try {
    return await sdk.threads.submissions.send({
      submissionId: args.submissionId,
      threadId: args.threadId,
      input,
      ...(args.model ? { model: args.model } : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
      ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
      ...(args.senderThreadId ? { senderThreadId: args.senderThreadId } : {}),
      messageSource: { kind: "script", label: args.source ?? "CLI" },
      attachments,
    });
  } catch (error: unknown) {
    throw await withRestoreEnvironmentHint(sdk, args.threadId, error);
  }
}

async function withRestoreEnvironmentHint(
  sdk: ReturnType<typeof createCliOmnyoSdk>,
  threadId: string,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof OmnyoHttpError)) return error;

  const parsed = threadEnvironmentUnavailableApiErrorSchema.safeParse(
    error.body,
  );

  if (!parsed.success || parsed.data.details.reason !== "destroyed") {
    return error;
  }

  const { canRestoreEnvironment } = await sdk.threads.get({ threadId });

  return new CliExitError(error.message, 1, {
    code: parsed.data.code,
    hint: canRestoreEnvironment
      ? `Its workspace was removed. Restore it with \`omnyo thread restore-environment ${threadId}\`, then send again.`
      : "Its workspace was removed and its environment provider cannot restore it. Start a new thread to continue.",
  });
}

function describeThreadTellOutcome(
  threadId: string,
  response: PostThreadMessageResult,
): string {
  if (response.delivery === "queued") {
    return `Thread ${threadId} message queued (${describeQueueWait(response.queuedMessage)}); it dispatches when that clears`;
  }

  if (response.delivery === "stored") {
    return response.late
      ? `Thread ${threadId} stored a late result; its wait had already ended`
      : `Thread ${threadId} stored the result for its wait`;
  }

  if (response.delivery === "waiting")
    return `Thread ${threadId} checks back at that time (wait ${response.waitId}); in that turn, run \`omnyo wait rearm ${response.waitId}\` if nothing changed`;

  return response.mode === "steer"
    ? `Thread ${threadId} steered`
    : `Thread ${threadId} updated`;
}

function describeThreadRetryOutcome(
  threadId: string,
  response: ThreadRetryResult,
): string {
  const turn = `turn ${response.turnRequestId} (attempt ${response.attempt})`;

  return response.delivery === "queued"
    ? `Thread ${threadId} retry of ${turn} queued (${describeQueueWait(response)}); it dispatches when that clears`
    : `Thread ${threadId} retrying ${turn}`;
}

export function describeQueueWait(row: {
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}): string {
  const waitingOn = row.waitingOn ?? { kind: "thread-busy" as const };

  switch (waitingOn.kind) {
    case "time":
      return row.sendAt === null
        ? "scheduled"
        : `scheduled for ${new Date(row.sendAt).toLocaleString()}`;
    case "thread-busy":
      return "waiting for the current turn to finish";
    case "stopping":
      return "sending once the thread finishes stopping";
    case "turn-starting":
      return "waiting for the current turn to start";
    case "provisioning":
      return "waiting for the workspace";
    case "host-offline":
      return `waiting for ${waitingOn.hostName} to reconnect`;
    case "host-away":
      return `waiting while ${waitingOn.hostName} is Away`;
    case "interaction":
      return "waiting for a pending interaction";
    case "server-update":
      return "waiting for the Omnyo server update";
    case "plugin":
      return `${waitingOn.pluginId}: ${waitingOn.reason}`;
    case "superseded":
      return "not sent: a newer message was sent after it";
  }
}

function resolveSenderThreadId(targetThreadId: string): string | undefined {
  const senderThreadId = resolveContextThreadId();

  if (!senderThreadId || senderThreadId === targetThreadId) {
    return undefined;
  }

  return senderThreadId;
}

function resolveThreadMessageMode(
  value: string | undefined,
): ThreadTellDeliveryMode {
  if (value === undefined) return "steer";
  const normalized = value.trim().toLowerCase();

  if (normalized === "steer") return "steer";

  if (normalized === "steer-if-active") return "steer";

  if (normalized === "queue") return "queue";

  if (normalized === "queue-if-active") return "queue";

  if (normalized === "auto") return "auto";
  throw new Error(
    `Invalid message mode '${value}'. Expected 'queue', 'steer', or 'auto'.`,
  );
}
