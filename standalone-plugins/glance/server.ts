import {
  cliCommand,
  defineCli,
  PluginCliError,
  type PluginApi,
  type PluginCliContext,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import { cardSchema, rpcContract, toolNames, type CardView } from "./contract.ts";
import { GlanceService } from "./lib/service.ts";
import { DevServersService } from "./lib/dev-servers.ts";

export { rpcContract } from "./contract.ts";

function threadId(chat: string | undefined, context: PluginCliContext): string {
  const id = !chat || chat === "." ? context.threadId : chat;

  if (!id)
    throw new PluginCliError("Name a chat outside a Omnyo thread", { code: "chat_required" });

  return id;
}

function describeCard(view: CardView | null): string {
  if (!view) return "No Glance card for this chat.";

  const lines = [];

  if (view.card.goal) lines.push(`Goal: ${view.card.goal}`);
  lines.push(`Now: ${view.card.status} · ${view.card.headline}`);

  if (view.card.blocker) lines.push(`Blocked: ${view.card.blocker}`);

  if (view.card.next) lines.push(`Next: ${view.card.next}`);
  lines.push(`Revision ${view.revision}${view.staleSince === null ? "" : " · stale"}`);

  if (view.card.sidebarSummary) lines.push(`Sidebar: ${view.card.sidebarSummary}`);

  for (const proof of view.proofs)
    lines.push(
      proof.linked
        ? `Proof ${proof.index + 1}: event ${proof.eventSeq}, ${proof.status}, exit ${proof.exitCode ?? "unknown"}`
        : `Proof ${proof.index + 1}: Not linked`,
    );

  return lines.join("\n");
}

const instructions = `Use glance_set at the end of each substantive turn to update this chat's live card. If the tool is unavailable, use omnyo glance set --card-stdin with one line of JSON in a quoted heredoc (16 KiB maximum). The card answers three questions at a glance, one short row each, and nothing more. Goal: what the owner originally asked this chat to do, a plain phrase of at most 80 characters; set it on the first card; later cards that omit goal keep it, so send a new goal only when the owner changes the request. Now (headline): where that main request stands and why it matters, one plain sentence of at most 90 characters, for example "New card is live; old chats keep working". Next: who acts and what they do, at most 80 characters, for example "The owner picks the release scope" or "The agent runs the device check"; omit next once the chat is done; the card then shows archive readiness when a readiness plugin such as Tidy is installed. Write words a busy owner understands at a glance: no process narration, check counts, timestamps, paths, commands, versions or IDs in goal, headline, sidebarSummary or next unless they are the outcome; never join unrelated outcomes with "·" or "and"; leave side requests out; omit introductory prose and repeated chat titles. The title-bar summary shows goal as Started and headline as Toward while working, then sidebarSummary in green as the Result when done, or the blocker in red when blocked; a chat that ends without the requested outcome is blocked, not done. Everything else sits under a closed Details toggle: at most three facts that do not repeat the rows, linked deliverables, and proof. The conversation owns the full recap; do not copy it into the card. Use status working, needs-you, blocked or done and phase investigate, build, test, ship or done. Glance is status-only: create every decision through Omnyo native questions (AskUserQuestion or omnyo question command), never in the card; needs-you means a native question awaits an answer and next names who answers it. blocked requires a blocker naming what cannot proceed and who or what unblocks it; only blocked has a blocker. done means the whole requested outcome is delivered and verified. Only the user can accept a narrower finish line; partial attempts, refusals, stopped runs and delegated handoffs do not complete a larger request. A done card does not set archive readiness. Add sidebarSummary, the single outcome of the main request, result first, at most 55 characters (64 maximum), for example "iPhone checkout fixed; no lost orders". Proof kind is reproduced, inspected or hypothesis; reproduced requires the exact command that ran in this chat, and eventSeq can select one. A link proves execution, not claim truth: check the actual status and exit code. Never invent evidence or include secrets or private raw history. Full schema and examples: glance skill.

For every dev server the user will open, read omnyo guide previews, then use omnyo preview register with this chat, the exact verified argv, working directory and fixed loopback URL, followed by omnyo preview restart. Then run omnyo glance servers --remember <preview-id> to attach the returned binding to this chat, including a saved recipe reused from another chat. This makes the server appear in the Dev servers shelf with Open and Restart controls. When the server needs credentials, launch it through the project's existing script or launcher that loads them. Never store secrets in recipe arguments or infer a launch command from an old URL. Return a named Markdown preview link after readiness is verified.`;

export default function plugin(api: PluginApi): void {
  const service = new GlanceService(api);
  const servers = new DevServersService(api);
  const reportedFailures = new Set<string>();

  api.rpc.register(rpcContract, {
    "servers.read": (input) => servers.read(input.threadId),
    "servers.remember": (input) => servers.remember(input),
    "servers.restart": (input) => servers.restart(input),
    "card.read": (input) => service.read(input.threadId),
    "card.get": (input) => service.get(input.threadId),
    "card.diff": (input) => service.diff(input.threadId),
    "card.markSeen": (input) =>
      service.markSeen(input.threadId, input.revision, input.conversationSeq),
    "cards.index": (input) => {
      const diagnostic = input?.diagnostic;

      if (diagnostic && !reportedFailures.has(diagnostic.id)) {
        api.log.warn(JSON.stringify({ event: "refresh-failure", ...diagnostic }));
        reportedFailures.add(diagnostic.id);

        if (reportedFailures.size > 100) {
          const oldest = reportedFailures.values().next().value;

          if (oldest !== undefined) reportedFailures.delete(oldest);
        }
      }

      return service.index();
    },
  });
  api.agents.registerTool({
    name: toolNames.set,
    description:
      "Update this chat's live card: Goal (the original request), Now (where it stands) and Next (who acts), with facts, deliverables and proof under Details. Decisions belong to Omnyo’s native composer form.",
    parameters: cardSchema,
    presentation: {
      label: { pending: "Updating the chat card", completed: "Updated the chat card" },
      icon: { glyph: "Target" },
    },
    async execute(card, context) {
      return JSON.stringify(await service.save(context.threadId, card, "tool", context.signal));
    },
  });
  api.agents.registerTool({
    name: toolNames.show,
    description: "Read this chat's current live card, revision and stale state.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      return JSON.stringify(await service.get(context.threadId));
    },
  });
  api.agents.contributeInstructions(() => instructions);
  api.events.on("thread.idle", ({ thread }) => service.idle(thread.id));
  api.events.on("thread.deleted", ({ thread }) => service.remove(thread.id));

  const json = { json: { type: "boolean", description: "Print structured JSON" } } as const;
  const chat = [{ name: "chat", description: "Chat ID, or . for the invoking chat" }] as const;

  const definition = defineCli({
    name: "glance",
    summary: "Read and update live chat state cards",
    commands: {
      show: cliCommand({
        summary: "Read a chat's current card and linked proof",
        positionals: chat,
        options: json,
        async run(input, context) {
          const result = await service.get(threadId(input.positionals.chat, context));

          return {
            exitCode: 0,
            stdout: input.options.json ? JSON.stringify(result) : describeCard(result.view),
          };
        },
      }),
      set: cliCommand({
        summary: "Replace a chat card using JSON, preferably --card-stdin",
        options: {
          ...json,
          chat: { type: "string", description: "Target chat ID; defaults to the invoking chat" },
          card: {
            type: "string",
            required: true,
            stdin: true,
            description: "Card JSON, or --card-stdin for piped JSON",
          },
        },
        async run(input, context) {
          const card = cardSchema.parse(JSON.parse(input.options.card));

          const result = await service.save(
            threadId(input.options.chat, context),
            card,
            "cli",
            context.signal,
          );

          return {
            exitCode: 0,
            stdout: input.options.json ? JSON.stringify(result) : describeCard(result.view),
          };
        },
      }),
      diff: cliCommand({
        summary: "Read changes since the last displayed card",
        positionals: chat,
        options: json,
        async run(input, context) {
          const result = await service.diff(threadId(input.positionals.chat, context));

          const lines = result.changes.map(
            (change) => `${change.label}: ${change.before ?? "—"} → ${change.after ?? "—"}`,
          );

          lines.push(
            `${result.newReplies} new replies${result.moreActivity ? " · More activity available" : ""}`,
          );

          return {
            exitCode: 0,
            stdout: input.options.json ? JSON.stringify(result) : lines.join("\n"),
          };
        },
      }),
      servers: cliCommand({
        summary: "Read this chat's active and recent dev servers",
        positionals: chat,
        options: {
          ...json,
          remember: {
            type: "string",
            description: "Remember a saved preview from this chat's workspace",
          },
        },
        async run(input, context) {
          const chatId = threadId(input.positionals.chat, context);

          const result = input.options.remember
            ? await servers.remember({ threadId: chatId, previewId: input.options.remember })
            : await servers.read(chatId);

          const rows = [...result.active, ...(result.recent ? [result.recent] : [])];

          return {
            exitCode: 0,
            stdout: input.options.json
              ? JSON.stringify(result)
              : rows
                  .map(
                    (row) =>
                      `${row.status.state} · ${row.preview.url} (${row.preview.id}, ${row.preview.hostName})`,
                  )
                  .join("\n") || "No saved dev servers for this chat.",
          };
        },
      }),
      list: cliCommand({
        summary: "List all stored chat cards by recent update",
        options: json,
        run(input) {
          const result = service.index();

          const lines = result.cards.map(
            (card) =>
              `${card.status} · ${card.headline} (${card.threadId}, revision ${card.revision})`,
          );

          return {
            exitCode: 0,
            stdout: input.options.json
              ? JSON.stringify(result)
              : lines.join("\n") || "No Glance cards.",
          };
        },
      }),
    },
  });

  api.cli.register(definition);
}
