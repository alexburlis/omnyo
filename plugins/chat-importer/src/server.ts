import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { registerCli } from "./cli.js";
import {
  chatImportRpc,
  type ChatImporter,
  type HostsOutput,
  type ImportChatInput,
  type ImportChatOutput,
  type PreviewHost,
  type PreviewInput,
  type PreviewOutput,
} from "./contract.js";
import {
  chatImporterHostContract,
  type NativeProviderId,
} from "./host-contract.js";
import {
  buildPreview,
  checkTarget,
  claimIndex,
  hostLocalPaths,
  mainRepositoryPaths,
  planChatStatus,
  plannedProjects,
  PROJECTS_CHANGED_REASON,
  withRealMainRepository,
  type HostContext,
  type NativeSessionClaim,
  type ProjectRecord,
} from "./service.js";

export const HOST_CALL_TIMEOUT_MS = 120_000;

const CONTEXT_SCAN_DAYS = 1;

const serverConfigSchema = z.object({
  primaryHostId: z.string().min(1).nullable(),
});

export class ChatImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatImportError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ImportProgress {
  projectId: string | null;
  createdProject: boolean;
  omittedTurns: number;
  skippedLines: number;
}

function failed(message: string, progress: ImportProgress): ImportChatOutput {
  return { status: "failed", threadId: null, message, ...progress };
}

function historyNotice(
  omittedTurns: number,
  skippedLines: number,
): string | null {
  const parts: string[] = [];

  if (omittedTurns > 0) {
    parts.push(
      omittedTurns === 1
        ? "The oldest turn was too large to show. The agent still has the full chat."
        : `The ${omittedTurns} oldest turns were too large to show. The agent still has the full chat.`,
    );
  }

  if (skippedLines > 0) {
    parts.push(
      skippedLines === 1
        ? "1 line in the chat file couldn't be read and is left out of the history shown here."
        : `${skippedLines} lines in the chat file couldn't be read and are left out of the history shown here.`,
    );
  }

  return parts.length === 0 ? null : parts.join(" ");
}

interface HostState {
  context: HostContext;
  realPaths: Map<string, string | null>;
}

export function createChatImporter(api: PluginApi): ChatImporter {
  const host = api.hosts.experimental_client({
    contract: chatImporterHostContract,
  });

  const states = new Map<string, HostState>();

  async function primaryHostId(): Promise<string | null> {
    const config = serverConfigSchema.parse(await api.sdk.system.config());

    return config.primaryHostId;
  }

  async function hostList(): Promise<PreviewHost[]> {
    const list = await api.sdk.hosts.list({ type: "persistent" });

    return list.map((entry): PreviewHost => ({
      id: entry.id,
      name: entry.name,
      connected: entry.status === "connected",
    }));
  }

  async function hosts(): Promise<HostsOutput> {
    const [primary, list] = await Promise.all([primaryHostId(), hostList()]);

    return { primaryHostId: primary, hosts: list };
  }

  async function resolveHost(
    requested: string | undefined,
  ): Promise<{ host: PreviewHost; hosts: PreviewHost[] }> {
    const [hostId, hosts] = await Promise.all([
      requested ?? primaryHostId(),
      hostList(),
    ]);

    if (hostId === null) {
      throw new ChatImportError(
        "This Omnyo has no machine yet. Connect a machine to look for chats.",
      );
    }

    const selected = hosts.find((entry) => entry.id === hostId);

    if (selected === undefined) {
      throw new ChatImportError(
        `No machine with id ${hostId}. Run \`omnyo machine list\` to see your machines.`,
      );
    }

    if (!selected.connected) {
      throw new ChatImportError(
        `${selected.name} is offline. Connect it to look for its chats.`,
      );
    }

    return { host: selected, hosts };
  }

  async function loadClaims(
    hostId: string,
    providerId: NativeProviderId,
  ): Promise<NativeSessionClaim[]> {
    const response = await api.sdk.threads.experimental_nativeSessionClaims({
      hostId,
      providerId,
    });

    return response.claimed;
  }

  async function listProjects(): Promise<ProjectRecord[]> {
    const projects = await api.sdk.projects.list();

    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      sources: project.sources,
    }));
  }

  async function scan(
    hostId: string,
    days: number,
    nowMs: number,
    resolvePaths: readonly string[],
  ) {
    const output = await host.call(
      "scan",
      { days, nowMs, resolvePaths: [...resolvePaths] },
      { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS },
    );

    const realPaths = new Map(states.get(hostId)?.realPaths);

    for (const entry of output.resolvedPaths) {
      realPaths.set(entry.path, entry.realPath);
    }

    const state: HostState = {
      context: { homeDir: output.homeDir, roots: output.roots },
      realPaths,
    };

    states.set(hostId, state);

    return { output, state };
  }

  async function hostState(
    hostId: string,
    projectPaths: readonly string[],
  ): Promise<HostState> {
    const known = states.get(hostId);

    const unresolved = projectPaths.filter(
      (path) => known === undefined || !known.realPaths.has(path),
    );

    if (known !== undefined && unresolved.length === 0) return known;

    const { state } = await scan(
      hostId,
      CONTEXT_SCAN_DAYS,
      Date.now(),
      unresolved,
    );

    return state;
  }

  async function projectsOnHost(hostId: string) {
    const projects = await listProjects();
    const state = await hostState(hostId, hostLocalPaths(projects, hostId));

    return { projects, state };
  }

  async function preview(input: PreviewInput): Promise<PreviewOutput> {
    const nowMs = Date.now();
    const { host: selected, hosts } = await resolveHost(input.hostId);

    const scanned = listProjects().then(async (projects) => ({
      projects,
      scan: await scan(
        selected.id,
        input.days,
        nowMs,
        hostLocalPaths(projects, selected.id),
      ),
    }));

    const [{ projects, scan: result }, codexClaims, claudeClaims] =
      await Promise.all([
        scanned,
        loadClaims(selected.id, "codex"),
        loadClaims(selected.id, "claude-code"),
      ]);

    const state = await hostState(
      selected.id,
      mainRepositoryPaths(result.output.chats),
    );

    return buildPreview({
      hostId: selected.id,
      hosts,
      days: input.days,
      nowMs,
      scan: {
        ...result.output,
        resolvedPaths: [...state.realPaths].map(([path, realPath]) => ({
          path,
          realPath,
        })),
      },
      claims: claimIndex({ codex: codexClaims, "claude-code": claudeClaims }),
      projects,
    });
  }

  async function importChat(input: ImportChatInput): Promise<ImportChatOutput> {
    const progress: ImportProgress = {
      projectId: null,
      createdProject: false,
      omittedTurns: 0,
      skippedLines: 0,
    };

    try {
      const { host: selected } = await resolveHost(input.hostId);

      const [read, claims, { projects, state }] = await Promise.all([
        host.call(
          "readChat",
          {
            providerId: input.providerId,
            sourcePath: input.sourcePath,
            sourceProviderThreadId: input.sourceProviderThreadId,
          },
          { hostId: selected.id, timeoutMs: HOST_CALL_TIMEOUT_MS },
        ),
        loadClaims(selected.id, input.providerId),
        projectsOnHost(selected.id),
      ]);

      progress.omittedTurns = read.omittedTurns;
      progress.skippedLines = read.skippedLines;

      const plan = planChatStatus(
        read.summary,
        claimIndex({
          codex: input.providerId === "codex" ? claims : [],
          "claude-code": input.providerId === "claude-code" ? claims : [],
        }),
        state.context,
      );

      if (plan.status === "already-imported" || plan.status === "omnyo-chat") {
        return {
          status: "already-imported",
          threadId: plan.threadId,
          projectId: null,
          createdProject: false,
          message: plan.status === "omnyo-chat" ? plan.reason : null,
          omittedTurns: 0,
          skippedLines: 0,
        };
      }

      if (plan.status !== "ready") {
        return failed(plan.reason ?? "This chat can't be imported.", progress);
      }

      const located = await hostState(
        selected.id,
        mainRepositoryPaths([read.summary]),
      );

      const target = checkTarget(
        withRealMainRepository(read.summary, located.realPaths),
        input.project,
        plannedProjects(projects, selected.id, located.realPaths),
        located.context,
      );

      if (target.kind === "invalid") {
        return failed(PROJECTS_CHANGED_REASON, progress);
      }

      if (target.kind === "existing") {
        progress.projectId = target.projectId;
      } else {
        const created = await api.sdk.projects.create({
          name: target.name,
          source: {
            type: "local_path",
            hostId: selected.id,
            path: target.path,
          },
        });

        progress.projectId = created.id;
        progress.createdProject = true;
      }

      const result = await api.sdk.threads.experimental_importNative({
        projectId: progress.projectId,
        hostId: selected.id,
        providerId: input.providerId,
        sourceProviderThreadId: read.summary.sourceProviderThreadId,
        sourcePath: read.summary.sourcePath,
        cwd: read.summary.cwd,
        title: read.summary.title,
        createdAt: read.summary.createdAt,
        lastMessageAt: read.summary.lastMessageAt,
        turns: read.turns,
      });

      return {
        status: result.kind === "imported" ? "imported" : "already-imported",
        threadId: result.threadId,
        message:
          result.kind === "imported"
            ? historyNotice(read.omittedTurns, read.skippedLines)
            : null,
        ...progress,
      };
    } catch (error) {
      return failed(
        error instanceof ChatImportError
          ? error.message
          : `Couldn't import this chat: ${errorMessage(error)}`,
        progress,
      );
    }
  }

  return { hosts, preview, importChat };
}

export default function chatImporterPlugin(api: PluginApi): void {
  const importer = createChatImporter(api);
  api.rpc.register(chatImportRpc, {
    hosts: () => importer.hosts(),
    preview: (input) => importer.preview(input),
    importChat: (input) => importer.importChat(input),
  });
  registerCli(api, importer);
}
