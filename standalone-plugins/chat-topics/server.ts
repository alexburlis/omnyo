import type { PluginApi, PluginCliResult } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./lib/contract.ts";
import { storedLayoutTraceSchema } from "./lib/diagnostics-contract.ts";
import { nameInputSchema } from "./lib/naming.ts";
import { CHANGED_CHANNEL, type ChangedPayload } from "./lib/records.ts";
import { createFirstTurnLedger } from "./lib/first-turn.ts";
import {
  DEFAULT_TAGS,
  NO_TAG,
  accepts,
  addTag,
  effectiveTagId,
  findTag,
  metadataTagSchema,
  moveTag,
  removeTag,
  tagInstruction,
  tagListSchema,
  isIconName,
  tagPatchSchema,
  unknownTagMessage,
  updateTag,
  type Tag,
  type TagRecord,
  type TagSource,
} from "./lib/tags.ts";

const toolName = "chat_topics_set_name";

const TAGS_KEY = "tags";

const namingInstruction = `Early in this first response, call chat_topics_set_name once. The title names this chat's specific subject in 2–5 words, at most 48 characters, so a busy owner recognizes it in a list. Name the subject, not the request: no filler such as "Help with", no trailing punctuation, never a truncated copy of the prompt. Good: "Cybersecurity audit coverage", "Sidebar inline rename". Bad: "Do we have good coverage for", "Help with GitHub CLI".`;

const continueInstruction = `Then continue your normal answer. Do not put naming JSON in the answer, start another chat, or make another model request for naming. The tool preserves existing titles and manual renames.`;

const conditionalResultSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  experimental_titleApplied: z.boolean(),
});

type Thread = Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>;

type ConditionalTitleRequest = Parameters<PluginApi["sdk"]["threads"]["update"]>[0] & {
  experimental_titleIfUntitled: true;
  signal: AbortSignal;
};

interface TagList {
  tags: Tag[];
}

interface TagWrite {
  applied: boolean;
  record: TagRecord | null;
}

function liveNewThread(thread: Thread, activatedAt: number): boolean {
  return (
    thread.visibility === "visible" &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.createdAt >= activatedAt &&
    thread.title === null
  );
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  return index < 0 ? undefined : argv[index + 1];
}

function tagName(tag: Tag): string {
  return isIconName(tag.icon) ? tag.label : `${tag.icon} ${tag.label}`;
}

function tagLine(tag: Tag, index: number): string {
  const meaning = tag.description === "" ? "" : ` (${tag.description})`;
  const icon = isIconName(tag.icon) ? ` · icon ${tag.icon}` : "";

  return `${index + 1}. ${tagName(tag)} [${tag.id}]${meaning}${icon}`;
}

export default async function plugin(api: PluginApi): Promise<void> {
  const lifetime = new AbortController();
  const metadataMutations = new Map<string, Promise<void>>();
  const titleWrites = new Set<ReturnType<PluginApi["sdk"]["threads"]["update"]>>();
  const firstTurns = createFirstTurnLedger(api);

  api.onDispose(async () => {
    lifetime.abort();
    await Promise.allSettled([...titleWrites, ...metadataMutations.values()]);
  });

  function mutateMetadata<T>(
    key: string,
    work: () => Promise<T>,
    signal = lifetime.signal,
  ): Promise<T> {
    const mutation = (metadataMutations.get(key) ?? Promise.resolve()).then(async () => {
      signal.throwIfAborted();

      return work();
    });

    const settled = mutation.then(
      () => {},
      () => {},
    );

    metadataMutations.set(key, settled);
    void settled.then(() => {
      if (metadataMutations.get(key) === settled) metadataMutations.delete(key);
    });

    return mutation;
  }

  const storedActivation = await api.storage.kv.get("activatedAt");

  const activatedAt =
    storedActivation === null || storedActivation === undefined
      ? Date.now()
      : z.number().finite().nonnegative().parse(storedActivation);

  if (storedActivation === null || storedActivation === undefined)
    await api.storage.kv.set("activatedAt", activatedAt);

  const storedTags = await api.storage.kv.get(TAGS_KEY);

  let tags: readonly Tag[] =
    storedTags === null || storedTags === undefined
      ? DEFAULT_TAGS
      : tagListSchema.parse(storedTags);

  function publish(payload: ChangedPayload) {
    api.realtime.publish(CHANGED_CHANNEL, payload);
  }

  function writeTag(
    threadId: string,
    tagId: string | null,
    source: TagSource,
    signal = lifetime.signal,
  ): Promise<TagWrite> {
    return mutateMetadata(
      `tag:${threadId}`,
      async () => {
        const current = metadataTagSchema.parse(
          await api.sdk.threads.getPluginMetadata({ threadId, signal }),
        );

        signal.throwIfAborted();

        if (!accepts(source, tagId, current, tags)) return { applied: false, record: current };

        const record: TagRecord = { v: 1, tagId, source, updatedAt: Date.now() };
        await api.sdk.threads.updatePluginMetadata({ threadId, set: { tag: record }, signal });
        signal.throwIfAborted();
        publish({ kind: "threads", threadIds: [threadId] });

        return { applied: true, record };
      },
      signal,
    );
  }

  async function setTag(threadId: string, tagId: string | null): Promise<TagRecord> {
    lifetime.signal.throwIfAborted();

    if (tagId !== null && findTag(tags, tagId) === null)
      throw new Error(unknownTagMessage(tagId, tags));
    const thread = await api.sdk.threads.get({ threadId, signal: lifetime.signal });
    lifetime.signal.throwIfAborted();

    if (thread.deletedAt !== null || thread.visibility === "hidden")
      throw new Error("Choose a visible chat.");

    const written = await writeTag(threadId, tagId, "user");

    if (written.record === null) throw new Error("The tag was not saved.");

    return written.record;
  }

  async function suggestTag(threadId: string, tagId: string | null) {
    if (tagId !== null && findTag(tags, tagId) === null) return { applied: false };

    return { applied: (await writeTag(threadId, tagId, "prediction")).applied };
  }

  function changeTags(change: (current: readonly Tag[]) => readonly Tag[]) {
    return mutateMetadata("tags", async () => {
      const next = change(tags);
      await api.storage.kv.set(TAGS_KEY, [...next]);
      tags = next;
      publish({ kind: "tags", tags: [...next] });

      return { tags: [...next] };
    });
  }

  api.experimental_hooks.on("message.dispatch", (context) => {
    const thread = context.thread;

    if (
      lifetime.signal.aborted ||
      !liveNewThread(thread, activatedAt) ||
      context.attempt !== "start-turn"
    )
      return { action: "proceed" };

    if (thread.status === "error" && context.senderThreadId === null) {
      const marker = firstTurns.read(thread.id);

      if (marker?.createdAt === thread.createdAt) return { action: "proceed" };
    }

    if (
      thread.status === "pending" &&
      context.initiator === "user" &&
      context.senderThreadId === null
    )
      firstTurns.grant(thread.id, thread.createdAt);
    else firstTurns.retire(thread.id);

    return { action: "proceed" };
  });

  api.events.on("thread.idle", ({ thread }) => {
    if (!lifetime.signal.aborted && thread.createdAt >= activatedAt) firstTurns.retire(thread.id);
  });

  api.events.on("thread.deleted", ({ thread }) => {
    if (!lifetime.signal.aborted) firstTurns.retire(thread.id);
  });

  api.agents.configure((context) => {
    if (context.thread.title !== null || firstTurns.read(context.thread.id) === null)
      return { tools: [], skills: [] };

    return {
      tools: [toolName],
      skills: [],
      instructions: `${namingInstruction}${tagInstruction(tags)} ${continueInstruction}`,
    };
  });

  api.agents.registerTool({
    name: toolName,
    description:
      'Name this new chat with its specific 2–5 word subject, such as "Sidebar inline rename", not a truncated copy of the prompt, plus an optional tag id from your instructions. Never replaces an existing title.',
    parameters: nameInputSchema,
    presentation: {
      label: { pending: "Naming chat", completed: "Checked chat title" },
      suppress: true,
    },
    async execute(input, context) {
      const signal = AbortSignal.any([context.signal, lifetime.signal]);

      try {
        signal.throwIfAborted();
        const thread = await api.sdk.threads.get({ threadId: context.threadId, signal });
        signal.throwIfAborted();
        const marker = firstTurns.read(context.threadId);

        if (!liveNewThread(thread, activatedAt) || marker?.createdAt !== thread.createdAt)
          return JSON.stringify({ applied: false, title: thread.title, reason: "not_eligible" });

        const request: ConditionalTitleRequest = {
          threadId: context.threadId,
          title: input.title,
          experimental_titleIfUntitled: true,
          signal,
        };

        signal.throwIfAborted();
        const writing = api.sdk.threads.update(request);
        titleWrites.add(writing);
        let result: z.output<typeof conditionalResultSchema>;

        try {
          result = conditionalResultSchema.parse(await writing);
        } finally {
          titleWrites.delete(writing);
        }

        signal.throwIfAborted();

        if (result.id !== context.threadId)
          throw new Error("The title response belongs to another chat.");

        if (!result.experimental_titleApplied)
          return JSON.stringify({ applied: false, title: result.title, reason: "title_exists" });

        signal.throwIfAborted();
        const tagId = input.tag ?? "";

        if (tagId === "" || tagId === NO_TAG)
          return JSON.stringify({ applied: true, title: result.title });

        if (findTag(tags, tagId) === null)
          return JSON.stringify({
            applied: true,
            title: result.title,
            tag: null,
            reason: "unknown_tag",
          });

        const written = await writeTag(context.threadId, tagId, "first-turn", signal);
        signal.throwIfAborted();

        return JSON.stringify({
          applied: true,
          title: result.title,
          tag: effectiveTagId(written.record, tags),
        });
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    },
  });

  async function status() {
    const threads = (await api.sdk.threads.list({ archived: false })).filter(
      (thread) => thread.visibility === "visible" && thread.deletedAt === null,
    );

    let withTag = 0;

    for (let start = 0; start < threads.length; start += 100) {
      const records = await api.sdk.threads.experimental_listPluginMetadata({
        threadIds: threads.slice(start, start + 100).map((thread) => thread.id),
      });

      for (const entry of records.threads)
        if (effectiveTagId(metadataTagSchema.parse(entry.metadata), tags) !== null) withTag += 1;
    }

    return { activatedAt, liveChats: threads.length, withTag };
  }

  const diagnosticsKey = "layout-diagnostics:v1";
  const diagnosticCursorSchema = z.number().int().min(0).max(7);

  async function diagnosticCursor() {
    const saved = await api.storage.kv.get(diagnosticsKey);

    return saved == null ? 0 : diagnosticCursorSchema.parse(saved);
  }

  async function diagnostics() {
    const cursor = await diagnosticCursor();

    const saved = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        api.storage.kv.get(`${diagnosticsKey}:${(cursor + index) % 8}`),
      ),
    );

    return {
      traces: saved.flatMap((value) =>
        value == null ? [] : [storedLayoutTraceSchema.parse(value)],
      ),
    };
  }

  api.rpc.register(rpcContract, {
    "diagnostics.list": diagnostics,
    "diagnostics.record": ({ trace }) =>
      mutateMetadata("diagnostics", async () => {
        const cursor = await diagnosticCursor();
        await api.storage.kv.set(`${diagnosticsKey}:${cursor}`, { receivedAt: Date.now(), trace });
        await api.storage.kv.set(diagnosticsKey, (cursor + 1) % 8);

        return { stored: true as const };
      }),
    status,
    "tags.list": () => ({ tags: [...tags] }),
    "tag.set": ({ threadId, tagId }) => setTag(threadId, tagId),
    "tag.suggest": ({ threadId, tagId }) => suggestTag(threadId, tagId),
    "tags.add": (tag) => changeTags((current) => addTag(current, tag)),
    "tags.update": ({ id, patch }) => changeTags((current) => updateTag(current, id, patch)),
    "tags.remove": ({ id }) => changeTags((current) => removeTag(current, id)),
    "tags.move": ({ id, index }) => changeTags((current) => moveTag(current, id, index)),
  });

  async function runTags(argv: readonly string[]): Promise<PluginCliResult> {
    const json = argv.includes("--json");
    const action = argv[1];
    const id = argv[2]?.startsWith("--") ? undefined : argv[2];
    let result: TagList;

    if (action === "list" || action === undefined) result = { tags: [...tags] };
    else if (id === undefined)
      return { exitCode: 1, stderr: `Use omnyo chat-topics tags ${action} ID.` };
    else if (action === "add")
      result = await changeTags((current) =>
        addTag(
          current,
          rpcContract["tags.add"].input.parse({
            id,
            label: flag(argv, "--label"),
            icon: flag(argv, "--icon"),
            description: flag(argv, "--description"),
          }),
        ),
      );
    else if (action === "update") {
      const patch = tagPatchSchema.parse({
        label: flag(argv, "--label"),
        icon: flag(argv, "--icon"),
        description: flag(argv, "--description"),
      });

      if (Object.values(patch).every((value) => value === undefined))
        return { exitCode: 1, stderr: "Pass --label, --icon or --description." };
      result = await changeTags((current) => updateTag(current, id, patch));
    } else if (action === "remove") result = await changeTags((current) => removeTag(current, id));
    else if (action === "move") {
      const position = z.coerce.number().int().positive().parse(flag(argv, "--to"));
      result = await changeTags((current) => moveTag(current, id, position - 1));
    } else
      return {
        exitCode: 1,
        stderr: "Use omnyo chat-topics tags list, add, update, remove or move.",
      };

    return {
      exitCode: 0,
      stdout: json
        ? JSON.stringify(result)
        : result.tags.length === 0
          ? "No tags."
          : result.tags.map(tagLine).join("\n"),
    };
  }

  async function runTag(argv: readonly string[], contextThreadId: string | undefined) {
    const threadId = argv[1]?.startsWith("--") ? contextThreadId : argv[1];
    const value = flag(argv, "--tag")?.trim().toLowerCase();

    if (!threadId || value === undefined || value === "")
      return { exitCode: 1, stderr: "Use omnyo chat-topics tag THREAD_ID --tag ID|none." };

    const record = await setTag(threadId, value === NO_TAG ? null : value);
    const tag = findTag(tags, record.tagId);

    return {
      exitCode: 0,
      stdout: argv.includes("--json")
        ? JSON.stringify(record)
        : tag === null
          ? "Tag cleared."
          : `Tag: ${tagName(tag)}`,
    };
  }

  api.cli.register({
    name: "chat-topics",
    summary: "Inspect first-turn titles, sidebar diagnostics and chat tags",
    commands: [
      {
        name: "diagnostics",
        summary: "Read the eight latest sidebar layout captures",
        usage: "omnyo chat-topics diagnostics [--json]",
      },
      { name: "status", summary: "Show tag coverage", usage: "omnyo chat-topics status [--json]" },
      {
        name: "tag",
        summary: "Change a chat's tag without changing its title",
        usage: "omnyo chat-topics tag THREAD_ID --tag ID|none [--json]",
      },
      {
        name: "tags",
        summary:
          "List, add, update, remove or reorder tags. Removing a tag leaves its chats untagged.",
        usage:
          'omnyo chat-topics tags list | add ID --label LABEL --icon ICON [--description "MEANING"] | update ID [--label LABEL] [--icon ICON] [--description "MEANING"] | remove ID | move ID --to POSITION [--json]',
      },
    ],
    async run(argv, context) {
      try {
        if (argv[0] === "diagnostics") {
          return { exitCode: 0, stdout: JSON.stringify(await diagnostics(), null, 2) };
        }

        if (argv[0] === "status") {
          const result = await status();

          return {
            exitCode: 0,
            stdout: argv.includes("--json")
              ? JSON.stringify(result)
              : `${result.withTag}/${result.liveChats} live chats have a tag. Titles come from each chat's first response.`,
          };
        }

        if (argv[0] === "tag") return await runTag(argv, context.threadId);

        if (argv[0] === "tags") return await runTags(argv);

        return { exitCode: 1, stderr: "Use omnyo chat-topics status, diagnostics, tag or tags." };
      } catch (error) {
        if (error instanceof z.ZodError) return { exitCode: 1, stderr: z.prettifyError(error) };

        throw error;
      }
    },
  });
}
