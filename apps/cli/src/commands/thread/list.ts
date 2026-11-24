import { Command } from "commander";
import {
  PERSONAL_PROJECT_ID,
  THREAD_WORK_LABELS,
  type ThreadListEntry,
  type Thread,
} from "@omnyo/domain";
import { action } from "../../action.js";
import { createCliOmnyoSdk } from "../../client.js";
import { resolveExplicitIdFlag } from "../../context-env.js";
import {
  columnWidths,
  printBorderlessTable,
  truncateCell,
} from "../../table.js";
import { collectOption, outputJson } from "../helpers.js";
import {
  resolveMachineHostId,
  resolveMachineTargetOption,
} from "../machine.js";

interface ThreadListCommandOptions {
  environment?: string;
  machine?: string;
  host?: string;
  project?: string;
  parentThread?: string;
  thread: string[];
  archived?: boolean;
  shelved?: boolean;
  section?: string;
  unsectioned?: boolean;
  group?: string;
  json?: boolean;
  includeHidden?: boolean;
}

export function registerListCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("list")
    .description("List threads")
    .option("--project <id>", "Filter by project ID (defaults to all projects)")
    .option("--environment <id>", "Filter by environment ID")
    .option(
      "--machine <id-or-name>",
      "Filter by machine ID or active machine name",
    )
    .option("--host <id-or-name>", "Alias for --machine")
    .option("--parent-thread <id>", "Filter by parent thread ID")
    .option(
      "--thread <id>",
      "Show only this thread ID, leaving out unknown or deleted IDs (repeatable, up to 200)",
      collectOption,
      [],
    )
    .option("--section <id>", "Filter by thread section ID")
    .option("--unsectioned", "Show only threads outside sections")
    .option("--group <id>", "Filter by chat group ID")
    .option("--archived", "Show only archived threads")
    .option("--shelved", "Show only shelved threads, in Shelf order")
    .option("--include-hidden", "Include hidden threads")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ThreadListCommandOptions) => {
        const sdk = createCliOmnyoSdk(getUrl());

        const projectId = resolveExplicitIdFlag({
          flagName: "--project flag",
          value: opts.project,
        });

        const parentThreadId = resolveExplicitIdFlag({
          flagName: "--parent-thread",
          value: opts.parentThread,
        });

        const threadIds = opts.thread.flatMap(
          (value) =>
            resolveExplicitIdFlag({ flagName: "--thread", value }) ?? [],
        );

        const environmentId = resolveExplicitIdFlag({
          flagName: "--environment",
          value: opts.environment,
        });

        const machineTarget = resolveMachineTargetOption(opts);

        const hostId =
          machineTarget === undefined
            ? undefined
            : machineTarget.trim().startsWith("host_")
              ? resolveExplicitIdFlag({
                  flagName: "--machine",
                  value: machineTarget,
                })
              : await resolveMachineHostId({
                  serverUrl: getUrl(),
                  target: machineTarget,
                });

        if (opts.section && opts.unsectioned) {
          throw new Error("Cannot combine --section with --unsectioned.");
        }

        if (opts.archived && opts.shelved) {
          throw new Error("Cannot combine --archived with --shelved.");
        }

        const sectionId = resolveExplicitIdFlag({
          flagName: "--section",
          value: opts.section,
        });

        const groupId = resolveExplicitIdFlag({
          flagName: "--group",
          value: opts.group,
        });

        const threads = await sdk.threads.list({
          ...(projectId ? { projectId } : {}),
          ...(environmentId ? { environmentId } : {}),
          ...(hostId ? { hostId } : {}),
          ...(parentThreadId ? { parentThreadId } : {}),
          threadIds: threadIds.length > 0 ? threadIds : undefined,
          ...(opts.archived ? { archived: true } : {}),
          ...(opts.shelved ? { shelved: true } : {}),
          ...(sectionId ? { sectionId } : {}),
          ...(opts.unsectioned ? { unsectioned: true } : {}),
          ...(groupId ? { groupId } : {}),
          ...(opts.includeHidden ? { includeHidden: true } : {}),
          experimental_includePluginHome: true,
        });

        if (outputJson(opts, threads)) return;

        if (threads.length === 0) {
          console.log("No threads found");

          return;
        }

        const projects = await sdk.projects.list({ includePersonal: false });

        const projectNames = new Map(
          projects.map((project) => [project.id, project.name]),
        );

        printThreadTable(threads, projectNames);
      }),
    );
}

const MAX_TITLE_WIDTH = 60;

function printThreadTable(
  threads: ThreadListEntry[],
  projectNames: ReadonlyMap<string, string>,
): void {
  const rows = threads.map((thread) => [
    thread.id,
    truncateCell(formatThreadListTitle(thread), MAX_TITLE_WIDTH),
    formatThreadListProject(thread, projectNames),
    formatThreadListStatus(thread),
  ]);

  printBorderlessTable(
    {
      head: ["ID", "Title", "Project", "Status"],
      colWidths: columnWidths(rows, [4, 5, 7, 12]),
    },
    rows,
  );
}

function formatThreadListTitle(thread: Thread): string {
  const title = thread.title?.trim();

  if (title) return title;
  const fallback = thread.titleFallback?.trim();

  if (fallback) return fallback;

  return "-";
}

function formatThreadListProject(
  thread: Thread,
  projectNames: ReadonlyMap<string, string>,
): string {
  if (thread.projectId === PERSONAL_PROJECT_ID) return "-";

  return projectNames.get(thread.projectId) ?? thread.projectId;
}

function formatThreadListStatus(thread: ThreadListEntry): string {
  const flags: string[] = [];

  if (thread.archivedAt !== null) {
    flags.push("archived");
  }

  if (thread.pinnedAt !== null) {
    flags.push("pinned");
  }

  if (thread.shelvedAt !== null) {
    flags.push("shelved");
  }

  if (thread.pluginHome) {
    flags.push(`home of ${thread.originPluginId ?? "a plugin"}`);
  }

  const status =
    thread.work === null
      ? "Open"
      : THREAD_WORK_LABELS[thread.work.primary.label];

  return flags.length === 0 ? status : `${status} (${flags.join(", ")})`;
}
