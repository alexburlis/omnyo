import {
  cliCommand,
  defineCli,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  type PluginApi,
  type PluginCliResult,
} from "@omnyo/plugin-sdk";
import {
  DEFAULT_DAYS,
  MAX_DAYS,
  type ChatImporter,
  type ImportChatOutput,
  type PreviewChat,
  type PreviewOutput,
} from "./contract.js";
import { nativeProviderIdSchema } from "./host-contract.js";
import {
  chatKey,
  countChats,
  DROP_REASON_LABELS,
  formatRelativeTime,
  projectLabel,
  PROVIDER_LABELS,
  selectionPlan,
} from "./service.js";

const OUTPUT_BUDGET_BYTES = PLUGIN_CLI_OUTPUT_MAX_BYTES - 16 * 1024;

const DAYS_OPTION = {
  type: "integer",
  min: 1,
  max: MAX_DAYS,
  default: DEFAULT_DAYS,
  description: "Include chats with a message in the last N days (1-365)",
} as const;

const HOST_OPTION = {
  type: "string",
  description: "Machine id to scan; defaults to the server machine",
} as const;

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const STATUS_LABELS: Record<PreviewChat["status"], string> = {
  ready: "ready",
  "already-imported": "imported",
  "omnyo-chat": "omnyo",
  "folder-missing": "missing",
  "not-a-project-folder": "no-project",
  "cwd-mismatch": "moved",
};

export interface ChatImportRunResult extends ImportChatOutput {
  key: string;
  title: string | null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function countLine(preview: PreviewOutput): string {
  const host = preview.hosts.find((entry) => entry.id === preview.hostId);
  const counts = preview.counts;

  const parts = [
    `${counts.found} ${counts.found === 1 ? "chat" : "chats"} with messages in the last ${preview.days} ${preview.days === 1 ? "day" : "days"}${host === undefined ? "" : ` on ${host.name}`}`,
    `${PROVIDER_LABELS["claude-code"]} ${counts.byProvider["claude-code"].found}`,
    `${PROVIDER_LABELS.codex} ${counts.byProvider.codex.found}`,
  ];

  return parts.join(" · ");
}

function chatRow(chat: PreviewChat, nowMs: number): string {
  const detail =
    chat.project === null ? (chat.reason ?? "") : projectLabel(chat.project);

  return [
    STATUS_LABELS[chat.status],
    chat.key,
    formatRelativeTime(chat.lastMessageAt, nowMs),
    detail,
    chat.title,
  ].join("\t");
}

export function formatScan(preview: PreviewOutput): string {
  const counts = preview.counts;

  const header = [
    countLine(preview),
    `${counts.ready} ready · ${counts.alreadyImported} already imported · ${counts.unavailable} unavailable`,
  ];

  if (preview.newProjects.length > 0) {
    header.push(
      `New projects: ${preview.newProjects.map((project) => `${project.name} (${project.path})`).join(", ")}`,
    );
  }

  if (preview.dropped.length > 0) {
    header.push(
      `Skipped: ${preview.dropped
        .map(
          (drop) =>
            `${PROVIDER_LABELS[drop.providerId]} ${drop.count} ${DROP_REASON_LABELS[drop.reason]}`,
        )
        .join(", ")}`,
    );
  }

  const lines = [...header, ""];
  let used = byteLength(lines.join("\n"));

  for (const [index, chat] of preview.chats.entries()) {
    const row = chatRow(chat, preview.nowMs);
    used += byteLength(row) + 1;

    if (used > OUTPUT_BUDGET_BYTES) {
      lines.push(
        `… ${preview.chats.length - index} more chats. Use --json or a smaller --days.`,
      );
      break;
    }

    lines.push(row);
  }

  return `${lines.join("\n")}\n`;
}

export function scanJson(preview: PreviewOutput): string {
  const full = JSON.stringify(preview);

  if (byteLength(full) <= OUTPUT_BUDGET_BYTES) return `${full}\n`;

  const compact = JSON.stringify({
    ...preview,
    chats: preview.chats.map(({ firstPrompt: _firstPrompt, ...chat }) => chat),
  });

  if (byteLength(compact) <= OUTPUT_BUDGET_BYTES) return `${compact}\n`;

  throw new PluginCliError(
    `${preview.chats.length} chats are too many to print as JSON`,
    { code: "output_too_large", hint: "Use a smaller --days." },
  );
}

function parseChatKeys(values: readonly string[]): string[] {
  return values.map((value) => {
    const separator = value.indexOf(":");

    const provider = nativeProviderIdSchema.safeParse(
      separator > 0 ? value.slice(0, separator) : "",
    );

    const id = separator > 0 ? value.slice(separator + 1) : "";

    if (!provider.success || id.length === 0) {
      throw new PluginCliError(`Invalid --chat value "${value}"`, {
        code: "invalid_chat",
        hint: "Use PROVIDER:ID, for example claude-code:1f0c… or codex:019a…, as printed by `omnyo chat-import scan`.",
      });
    }

    return chatKey(provider.data, id);
  });
}

export function selectedPreview(
  preview: PreviewOutput,
  keys: readonly string[],
): PreviewOutput {
  if (keys.length === 0) return preview;

  const requested = new Set(parseChatKeys(keys));
  const plan = selectionPlan(preview, (chat) => requested.has(chat.key));

  const chats = preview.chats
    .filter((chat) => requested.has(chat.key))
    .map((chat) => ({
      ...chat,
      project: plan.targets.get(chat.key) ?? chat.project,
    }));

  return {
    ...preview,
    chats,
    counts: countChats(chats),
    newProjects: plan.newProjects.map(({ name, path }) => ({ name, path })),
  };
}

export function runCounts(results: readonly ChatImportRunResult[]) {
  return {
    imported: results.filter((result) => result.status === "imported").length,
    alreadyImported: results.filter(
      (result) => result.status === "already-imported",
    ).length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}

function resultRow(result: ChatImportRunResult): string {
  const detail =
    result.status === "failed"
      ? (result.message ?? "")
      : result.threadId === null
        ? (result.message ?? "")
        : `thread ${result.threadId}${result.message === null ? "" : ` · ${result.message}`}`;

  return [result.status, result.key, result.title ?? "", detail].join("\t");
}

function unavailableResult(chat: PreviewChat): ImportChatOutput {
  const claimed =
    chat.status === "already-imported" || chat.status === "omnyo-chat";

  return {
    status: claimed ? "already-imported" : "failed",
    threadId: claimed ? chat.threadId : null,
    projectId: null,
    createdProject: false,
    message:
      chat.status === "already-imported"
        ? null
        : (chat.reason ?? "This chat can't be imported."),
    omittedTurns: 0,
    skippedLines: 0,
  };
}

export async function runImport(
  importer: ChatImporter,
  args: { days: number; hostId: string | undefined; chats: readonly string[] },
): Promise<ChatImportRunResult[]> {
  const requested = new Set(parseChatKeys(args.chats));

  const preview = await importer.preview({
    days: args.days,
    hostId: args.hostId,
  });

  const listed = new Set(preview.chats.map((chat) => chat.key));

  const plan = selectionPlan(
    preview,
    (chat) => requested.size === 0 || requested.has(chat.key),
  );

  const targets: Array<PreviewChat | string> =
    requested.size === 0
      ? preview.chats.filter((chat) => chat.status === "ready")
      : [
          ...preview.chats.filter((chat) => requested.has(chat.key)),
          ...[...requested].filter((key) => !listed.has(key)),
        ];

  const results: ChatImportRunResult[] = [];

  for (const target of targets) {
    if (typeof target === "string") {
      results.push({
        key: target,
        title: null,
        status: "failed",
        threadId: null,
        projectId: null,
        createdProject: false,
        message: `No chat with this id has messages in the last ${preview.days} ${preview.days === 1 ? "day" : "days"}.`,
        omittedTurns: 0,
        skippedLines: 0,
      });
      continue;
    }

    const project = plan.targets.get(target.key);

    const result =
      project === undefined
        ? unavailableResult(target)
        : await importer.importChat({
            hostId: preview.hostId,
            providerId: target.providerId,
            sourceProviderThreadId: target.sourceProviderThreadId,
            sourcePath: target.sourcePath,
            project,
          });

    results.push({ key: target.key, title: target.title, ...result });
  }

  return results;
}

export function formatRun(results: readonly ChatImportRunResult[]): string {
  const counts = runCounts(results);

  const summary = `${counts.imported} imported · ${counts.alreadyImported} already imported · ${counts.failed} failed`;

  if (results.length === 0) return `No chats ready to import.\n${summary}\n`;

  const lines: string[] = [];
  let used = byteLength(summary) + 1;

  for (const [index, result] of results.entries()) {
    const row = resultRow(result);
    used += byteLength(row) + 1;

    if (used > OUTPUT_BUDGET_BYTES) {
      lines.push(
        `… ${results.length - index} more results. Use --json for the failures.`,
      );
      break;
    }

    lines.push(row);
  }

  return `${[...lines, summary].join("\n")}\n`;
}

export function runJson(results: readonly ChatImportRunResult[]): string {
  const counts = runCounts(results);
  const full = JSON.stringify({ results, counts });

  if (byteLength(full) <= OUTPUT_BUDGET_BYTES) return `${full}\n`;

  const compact = results.map((result) =>
    result.status === "failed"
      ? { ...result, title: null }
      : { ...result, title: null, message: null },
  );

  const compactJson = JSON.stringify({ results: compact, counts });

  if (byteLength(compactJson) <= OUTPUT_BUDGET_BYTES) return `${compactJson}\n`;

  const ordered = [
    ...compact.filter((result) => result.status === "failed"),
    ...compact.filter((result) => result.status !== "failed"),
  ];

  const kept: typeof compact = [];
  let used = byteLength(JSON.stringify({ results: [], counts })) + 64;

  for (const result of ordered) {
    used += byteLength(JSON.stringify(result)) + 1;

    if (used > OUTPUT_BUDGET_BYTES) break;
    kept.push(result);
  }

  return `${JSON.stringify({
    results: kept,
    counts,
    omittedResults: ordered.length - kept.length,
  })}\n`;
}

export function registerCli(api: PluginApi, importer: ChatImporter): void {
  api.cli.register(
    defineCli({
      name: "chat-import",
      summary: "Import recent Codex CLI and Claude Code chats into Omnyo",
      description:
        "Finds Codex CLI and Claude Code chats on a machine and imports them as Omnyo chats that continue where you left off. Native chat files are only read, never changed.",
      root: cliCommand({
        summary: "Show chat-import commands",
        run: (input) => ({ exitCode: 0, stdout: input.help }),
      }),
      commands: {
        scan: cliCommand({
          summary: "Count and list chats with messages in the last N days",
          options: {
            days: DAYS_OPTION,
            host: HOST_OPTION,
            chat: {
              type: "string",
              repeatable: true,
              placeholder: "PROVIDER:ID",
              description:
                "Show only this chat, planned as `run --chat` would import the named chats (repeatable)",
            },
            json: JSON_OPTION,
          },
          async run(input): Promise<PluginCliResult> {
            const preview = selectedPreview(
              await importer.preview({
                days: input.options.days,
                hostId: input.options.host,
              }),
              input.options.chat,
            );

            return {
              exitCode: 0,
              stdout: input.options.json
                ? scanJson(preview)
                : formatScan(preview),
            };
          },
        }),
        run: cliCommand({
          summary:
            "Import every ready chat, or only the chats named with --chat, one at a time",
          options: {
            days: DAYS_OPTION,
            host: HOST_OPTION,
            chat: {
              type: "string",
              repeatable: true,
              placeholder: "PROVIDER:ID",
              description:
                "Import only this chat, as printed by scan (repeatable)",
            },
            json: JSON_OPTION,
          },
          async run(input): Promise<PluginCliResult> {
            const results = await runImport(importer, {
              days: input.options.days,
              hostId: input.options.host,
              chats: input.options.chat,
            });

            return {
              exitCode: runCounts(results).failed > 0 ? 1 : 0,
              stdout: input.options.json
                ? runJson(results)
                : formatRun(results),
            };
          },
        }),
      },
    }),
  );
}
