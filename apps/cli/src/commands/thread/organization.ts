import { Command } from "commander";
import { updateThreadTabsRequestSchema } from "@omnyo/server-contract";
import {
  queuedMessageWaitHolderSchema,
  suggestThreadGroupName,
  type PromptInput,
  type QueuedMessageWaitHolder,
} from "@omnyo/domain";
import type { ThreadQueuedMessagesResult } from "@omnyo/sdk";
import {
  columnWidths,
  printBorderlessTable,
  truncateCell,
} from "../../table.js";
import { describeQueueWait } from "./actions.js";
import { formatQueueSendCountdown } from "./send-time.js";
import { action } from "../../action.js";
import { createCliOmnyoSdk } from "../../client.js";
import { requireTextInput, TEXT_FILE_HELP_SUFFIX } from "../../text-input.js";
import {
  collectOption,
  confirmDestructiveAction,
  outputJson,
  requireThreadIdOrSelf,
} from "../helpers.js";
import { buildPromptInputs, uploadClientAttachmentInputs } from "./helpers.js";

interface JsonOptions {
  json?: boolean;
}

interface SelfOptions extends JsonOptions {
  self?: boolean;
}

interface SectionDeleteOptions extends JsonOptions {
  yes?: boolean;
}

interface GroupListOptions extends JsonOptions {
  project?: string;
}

interface GroupCreateOptions extends JsonOptions {
  name?: string;
}

interface SearchOptions extends JsonOptions {
  limit?: string;
}

interface HistoryOptions extends JsonOptions {
  limit?: string;
}

interface QueueListOptions extends JsonOptions {
  waitHolder?: string;
}

interface QueueCreateOptions extends JsonOptions {
  file?: string[];
  image?: string[];
  messageFile?: string;
  model?: string;
}

interface QueueUpdateOptions extends JsonOptions {
  file?: string[];
  image?: string[];
  messageFile?: string;
  model?: string;
  reasoningLevel?: string;
}

interface QueueSendOptions extends JsonOptions {
  mode?: "auto" | "steer";
}

interface QueueReorderOptions extends JsonOptions {
  after?: string;
  before?: string;
  groupBoundary?: string;
}

interface QueueGroupOptions extends JsonOptions {
  prefix: string;
}

interface ReorderNeighborOptions extends JsonOptions {
  after?: string;
  before?: string;
}

const THREAD_SEARCH_LIMIT_PER_GROUP_MAX = 50;

function parsePositiveInteger(
  value: string | undefined,
  flag: string,
  maximum?: number,
): string | undefined {
  if (value === undefined) return undefined;

  if (!/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  if (maximum !== undefined && Number(value) > maximum) {
    throw new Error(`${flag} must be at most ${maximum}.`);
  }

  return value;
}

function printHumanJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const MAX_QUEUE_TEXT_WIDTH = 40;

function printQueueTable(rows: ThreadQueuedMessagesResult): void {
  const now = Date.now();

  const table = rows.map((row) => [
    row.id,
    row.threadId,
    row.initiator === "user"
      ? ""
      : row.initiator === "system"
        ? "System"
        : (row.senderThreadId ?? "Agent"),
    truncateCell(queuedMessagePreview(row.content), MAX_QUEUE_TEXT_WIDTH),
    truncateCell(
      row.failureReason === null
        ? describeQueueWait(row)
        : `Failed: ${row.failureReason}`,
      MAX_QUEUE_TEXT_WIDTH,
    ),
    formatQueueSendCountdown(row.sendAt, now),
  ]);

  printBorderlessTable(
    {
      head: ["ID", "Thread", "Sender", "Message", "Waiting on", "Send at"],
      colWidths: columnWidths(table, [2, 6, 6, 7, 10, 7]),
    },
    table,
  );

  for (const row of rows) {
    if (row.failureReason === null) continue;
    console.log(`Failed ${row.id}: ${row.failureReason}`);
    console.log(`Retry: omnyo thread queue send ${row.threadId} ${row.id}`);
  }
}

function queuedMessagePreview(content: PromptInput[]): string {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");

  return text.trim() === "" ? "(no text)" : text;
}

function parseWaitHolder(value: string): QueuedMessageWaitHolder {
  const parsed = queuedMessageWaitHolderSchema.safeParse(value.trim());

  if (parsed.success) return parsed.data;
  throw new Error(
    `Invalid --wait-holder value '${value}'. Expected 'plugin:<plugin-id>'.`,
  );
}

export function registerOrganizationCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const section = parent
    .command("section")
    .description("Manage thread sections");

  section
    .command("list")
    .description("List thread sections")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const sections =
          await createCliOmnyoSdk(getUrl()).threadSections.list();

        if (outputJson(opts, sections)) return;

        if (sections.length === 0) {
          console.log("No thread sections found");

          return;
        }

        for (const item of sections) console.log(`${item.id}\t${item.name}`);
      }),
    );

  section
    .command("create <name>")
    .description("Create a thread section")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (name: string, opts: JsonOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).threadSections.create({
          name,
        });

        if (outputJson(opts, result)) return;
        console.log(`Thread section ${result.id} created: ${result.name}`);
      }),
    );

  section
    .command("rename <id> <name>")
    .description("Rename a thread section")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, name: string, opts: JsonOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).threadSections.update({
          id,
          name,
        });

        if (outputJson(opts, result)) return;
        console.log(`Thread section ${result.id} renamed: ${result.name}`);
      }),
    );

  section
    .command("delete <id>")
    .description("Delete a thread section and remove its thread assignments")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: SectionDeleteOptions) => {
        if (
          !opts.yes &&
          !(await confirmDestructiveAction(`Delete thread section ${id}?`))
        )
          return;

        const result = await createCliOmnyoSdk(getUrl()).threadSections.delete({
          id,
        });

        if (outputJson(opts, result)) return;
        console.log(
          `Thread section ${result.id} deleted; ${result.updatedThreadCount} thread(s) unsectioned`,
        );
      }),
    );

  const group = parent
    .command("group")
    .description(
      "Manage chat groups: named folders that hold chats from one project",
    );

  group
    .command("list")
    .description("List chat groups")
    .option("--project <id>", "Only groups in this project")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: GroupListOptions) => {
        const groups = await createCliOmnyoSdk(getUrl()).threadGroups.list(
          opts.project ? { projectId: opts.project } : {},
        );

        if (outputJson(opts, groups)) return;

        if (groups.length === 0) {
          console.log("No chat groups found");

          return;
        }

        for (const item of groups) {
          console.log(`${item.id}\t${item.projectId}\t${item.name}`);
        }
      }),
    );

  group
    .command("create <threadIds...>")
    .description(
      "Group chats from one project; the name defaults to words their titles share",
    )
    .option("--name <name>", "Group name")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadIds: string[], opts: GroupCreateOptions) => {
        const sdk = createCliOmnyoSdk(getUrl());

        const titles = async () => {
          const threads = new Map(
            (await sdk.threads.list({ threadIds, includeHidden: true })).map(
              (thread) => [thread.id, thread.title ?? thread.titleFallback],
            ),
          );

          return threadIds.map((threadId) => threads.get(threadId) ?? "");
        };

        const result = await sdk.threadGroups.create({
          name: opts.name ?? suggestThreadGroupName(await titles()),
          threadIds,
        });

        if (outputJson(opts, result)) return;
        console.log(
          `Chat group ${result.group.id} created: ${result.group.name} (${result.threadIds.length} chat(s))`,
        );
      }),
    );

  group
    .command("rename <id> <name>")
    .description("Rename a chat group")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, name: string, opts: JsonOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).threadGroups.update({
          id,
          name,
        });

        if (outputJson(opts, result)) return;
        console.log(`Chat group ${result.id} renamed: ${result.name}`);
      }),
    );

  group
    .command("delete <id>")
    .description("Ungroup: delete a chat group; its chats stay where they are")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: JsonOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).threadGroups.delete({
          id,
        });

        if (outputJson(opts, result)) return;
        console.log(
          `Chat group ${result.id} deleted; ${result.updatedThreadCount} chat(s) ungrouped`,
        );
      }),
    );

  parent
    .command("search <query>")
    .description("Search threads and messages")
    .option(
      "--limit <count>",
      `Maximum results per group (1-${THREAD_SEARCH_LIMIT_PER_GROUP_MAX})`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (query: string, opts: SearchOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).threads.search({
          query,
          limitPerGroup: parsePositiveInteger(
            opts.limit,
            "--limit",
            THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
          ),
        });

        if (outputJson(opts, result)) return;
        printHumanJson(result);
      }),
    );

  parent
    .command("history <id>")
    .description("List a thread's prompt history")
    .option("--limit <count>", "Maximum history entries")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: HistoryOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).threads.promptHistory({
          threadId: id,
          limit: parsePositiveInteger(opts.limit, "--limit"),
        });

        if (outputJson(opts, result)) return;
        printHumanJson(result);
      }),
    );

  for (const [name, markRead] of [
    ["read", true],
    ["unread", false],
  ] as const) {
    parent
      .command(`${name} [id]`)
      .description(`Mark a thread ${name}`)
      .option("--self", "Target the current thread (from OMNYO_THREAD_ID)")
      .option("--json", "Print machine-readable JSON output")
      .action(
        action(async (id: string | undefined, opts: SelfOptions) => {
          const threadId = requireThreadIdOrSelf(id, opts);
          const sdk = createCliOmnyoSdk(getUrl());

          const result = markRead
            ? await sdk.threads.markRead({ threadId })
            : await sdk.threads.markUnread({ threadId });

          if (outputJson(opts, result)) return;
          console.log(`Thread ${threadId} marked ${name}`);
        }),
      );
  }

  parent
    .command("reorder-pinned <id>")
    .description("Move a pinned thread between adjacent pinned threads")
    .option("--after <id>", "Previous pinned thread, or omit for the start")
    .option("--before <id>", "Next pinned thread, or omit for the end")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ReorderNeighborOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).threads.reorderPinned({
          threadId: id,
          previousThreadId: opts.after ?? null,
          nextThreadId: opts.before ?? null,
        });

        if (outputJson(opts, result)) return;
        console.log(`Pinned thread ${id} reordered`);
      }),
    );

  parent
    .command("reorder-shelved <id>")
    .description("Move a chat on the Shelf between adjacent Shelf chats")
    .option("--after <id>", "Previous Shelf chat, or omit for the top")
    .option("--before <id>", "Next Shelf chat, or omit for the bottom")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ReorderNeighborOptions) => {
        const result = await createCliOmnyoSdk(
          getUrl(),
        ).threads.experimental_reorderShelved({
          threadId: id,
          previousThreadId: opts.after ?? null,
          nextThreadId: opts.before ?? null,
        });

        if (outputJson(opts, result)) return;
        console.log(`Shelf chat ${id} reordered`);
      }),
    );

  const queue = parent
    .command("queue")
    .description("Manage queued thread messages");

  queue
    .command("list [threadId]")
    .description("List queued messages; omit the thread to list every one")
    .option(
      "--wait-holder <holder>",
      "Filter to rows one plugin is holding: plugin:<plugin-id>",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string | undefined, opts: QueueListOptions) => {
        const sdk = createCliOmnyoSdk(getUrl());

        const result =
          threadId === undefined
            ? await sdk.threads.queue.list({
                ...(opts.waitHolder
                  ? { waitHolder: parseWaitHolder(opts.waitHolder) }
                  : {}),
              })
            : await sdk.threads.queuedMessages.list({ threadId });

        if (outputJson(opts, result)) return;

        if (result.length === 0) {
          console.log("No queued messages found");

          return;
        }

        printQueueTable(result);
      }),
    );
  queue
    .command("create <threadId> [message]")
    .description("Create a queued message with text and attachments")
    .option("--model <model>", "Model override for the queued message")
    .option(
      "--message-file <path>",
      `Read the message from a file instead of [message]; ${TEXT_FILE_HELP_SUFFIX}`,
    )
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
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          inlineMessage: string | undefined,
          opts: QueueCreateOptions,
        ) => {
          const message = await requireTextInput({
            file: opts.messageFile,
            fileLabel: "--message-file",
            inline: inlineMessage,
            inlineLabel: "<message>",
          });

          const sdk = createCliOmnyoSdk(getUrl());

          const input = await uploadClientAttachmentInputs({
            input: buildPromptInputs({
              message,
              files: opts.file,
              images: opts.image,
            }),
            resolveProjectId: async () =>
              (await sdk.threads.get({ threadId })).projectId,
            sdk,
          });

          const result = await sdk.threads.queuedMessages.create({
            threadId,
            input,
            ...(opts.model ? { model: opts.model } : {}),
          });

          if (outputJson(opts, result)) return;
          console.log(
            `Queued message ${result.id} created for thread ${threadId}`,
          );
        },
      ),
    );
  queue
    .command("update <threadId> <messageId> [message]")
    .description("Update a queued message in place")
    .option("--model <model>", "Change the queued message's model")
    .option(
      "--reasoning-level <level>",
      "Change the queued message's reasoning level (provider-dependent)",
    )
    .option(
      "--message-file <path>",
      `Read the message from a file instead of [message]; ${TEXT_FILE_HELP_SUFFIX}`,
    )
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
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          messageId: string,
          inlineMessage: string | undefined,
          opts: QueueUpdateOptions,
        ) => {
          const message = await requireTextInput({
            file: opts.messageFile,
            fileLabel: "--message-file",
            inline: inlineMessage,
            inlineLabel: "<message>",
          });

          const sdk = createCliOmnyoSdk(getUrl());
          const queuedMessages = sdk.threads.queuedMessages;

          const existing = (await queuedMessages.list({ threadId })).find(
            (queuedMessage) => queuedMessage.id === messageId,
          );

          if (!existing) {
            throw new Error(
              `Queued message ${messageId} not found on thread ${threadId}.`,
            );
          }

          const input = await uploadClientAttachmentInputs({
            input: buildPromptInputs({
              message,
              files: opts.file,
              images: opts.image,
            }),
            resolveProjectId: async () =>
              (await sdk.threads.get({ threadId })).projectId,
            sdk,
          });

          const result = await queuedMessages.update({
            threadId,
            queuedMessageId: messageId,
            expectedUpdatedAt: existing.updatedAt,
            input,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.reasoningLevel
              ? { reasoningLevel: opts.reasoningLevel }
              : {}),
          });

          if (outputJson(opts, result)) return;
          console.log(`Queued message ${messageId} updated`);
        },
      ),
    );
  queue
    .command("send <threadId> <messageId>")
    .description("Send and remove a queued message")
    .option("--mode <mode>", "Delivery mode: auto or steer", "auto")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (threadId: string, messageId: string, opts: QueueSendOptions) => {
          if (opts.mode !== "auto" && opts.mode !== "steer")
            throw new Error("--mode must be auto or steer.");

          const result = await createCliOmnyoSdk(
            getUrl(),
          ).threads.queuedMessages.send({
            threadId,
            queuedMessageId: messageId,
            mode: opts.mode,
          });

          if (outputJson(opts, result)) return;

          if (result.delivery === "queued") {
            console.log(
              `Queued message ${messageId} is still queued (${describeQueueWait(result.queuedMessage)})`,
            );

            return;
          }

          console.log(
            result.delivery === "already-sent"
              ? `Queued message ${messageId} was already sent`
              : `Queued message ${messageId} sent`,
          );
        },
      ),
    );
  queue
    .command("delete <threadId> <messageId>")
    .description("Delete a queued message")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string, messageId: string, opts: JsonOptions) => {
        const result = await createCliOmnyoSdk(
          getUrl(),
        ).threads.queuedMessages.delete({
          threadId,
          queuedMessageId: messageId,
        });

        if (outputJson(opts, result)) return;
        console.log(`Queued message ${messageId} deleted`);
      }),
    );
  queue
    .command("restore <threadId> <messageId>")
    .description("Put back a recently deleted queued message")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string, messageId: string, opts: JsonOptions) => {
        const result = await createCliOmnyoSdk(
          getUrl(),
        ).threads.queuedMessages.experimental_restore({
          threadId,
          queuedMessageId: messageId,
        });

        if (outputJson(opts, result)) return;
        console.log(`Queued message ${messageId} restored`);
      }),
    );
  queue
    .command("reorder <threadId> <messageId>")
    .description("Move a queued message between adjacent messages")
    .option("--after <id>", "Previous queued message, or omit for the start")
    .option("--before <id>", "Next queued message, or omit for the end")
    .option("--group-boundary <id>", "Current group-boundary message id")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          messageId: string,
          opts: QueueReorderOptions,
        ) => {
          const result = await createCliOmnyoSdk(
            getUrl(),
          ).threads.queuedMessages.reorder({
            threadId,
            queuedMessageId: messageId,
            previousQueuedMessageId: opts.after ?? null,
            nextQueuedMessageId: opts.before ?? null,
            ...(opts.groupBoundary
              ? { groupBoundaryQueuedMessageId: opts.groupBoundary }
              : {}),
          });

          if (outputJson(opts, result)) return;
          console.log(`Queued message ${messageId} reordered`);
        },
      ),
    );
  queue
    .command("group <threadId> <boundaryMessageId>")
    .description("Set the grouped queued-message prefix")
    .requiredOption(
      "--prefix <ids>",
      "Comma-separated expected grouped-prefix ids",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          boundaryMessageId: string,
          opts: QueueGroupOptions,
        ) => {
          const prefix = opts.prefix
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);

          if (prefix.length === 0)
            throw new Error("--prefix must contain at least one message id.");

          const result = await createCliOmnyoSdk(
            getUrl(),
          ).threads.queuedMessages.setGroupBoundary({
            threadId,
            groupBoundaryQueuedMessageId: boundaryMessageId,
            expectedGroupedPrefixQueuedMessageIds: prefix,
          });

          if (outputJson(opts, result)) return;
          console.log(
            `Queued message group boundary set to ${boundaryMessageId}`,
          );
        },
      ),
    );

  const tabs = parent
    .command("tabs")
    .description("Inspect and update persisted thread panel tabs");

  tabs
    .command("show <threadId>")
    .description("Show persisted panel tabs")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (threadId: string, opts: JsonOptions) => {
        const result = await createCliOmnyoSdk(getUrl()).threads.tabs.get({
          threadId,
        });

        if (outputJson(opts, result)) return;
        printHumanJson(result);
      }),
    );
  tabs
    .command("set <threadId>")
    .description("Replace persisted panel tabs with revision checking")
    .requiredOption("--expected-revision <number>", "Current tab revision")
    .requiredOption("--tabs-json <json>", "JSON array of tab descriptors")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          threadId: string,
          opts: JsonOptions & {
            expectedRevision: string;
            tabsJson: string;
          },
        ) => {
          const request = updateThreadTabsRequestSchema.parse({
            expectedRevision: Number(opts.expectedRevision),
            tabs: JSON.parse(opts.tabsJson),
          });

          const result = await createCliOmnyoSdk(getUrl()).threads.tabs.update({
            threadId,
            ...request,
          });

          if (outputJson(opts, result)) return;
          console.log(
            `Thread ${threadId} tabs updated to revision ${result.revision}`,
          );
        },
      ),
    );
}
