import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";
import {
  chatImporterHostContract,
  readChatOutputSchema,
  type NativeChatSummary,
  type NativeProviderId,
  type ReadChatInput,
  type ReadChatOutput,
  type ScanDropReason,
  type ScanInput,
  type ScanOutput,
} from "./host-contract.js";
import {
  claudeProjectsDir,
  listClaudeSessions,
  readClaudeTranscript,
  summarizeClaudeSession,
} from "./native/claude.js";
import {
  codexSessionsDir,
  isCodexRolloutName,
  listCodexRollouts,
  readCodexTitleIndex,
  readCodexTranscript,
  summarizeCodexRollout,
} from "./native/codex.js";
import {
  finalizeTurns,
  fitTurnsToBudget,
  type NativeChatCore,
  type NativeSummaryResult,
} from "./native/normalize.js";
import {
  isDirectory,
  isPathInside,
  resolveNativeRoots,
  type NativeHostEnvironment,
  type NativeRoots,
} from "./native/paths.js";
import { describeCwd } from "./native/project-root.js";

const DAY_MS = 86_400_000;

const SCAN_CONCURRENCY = 8;

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  limit: number,
  task: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = Array.from({ length: inputs.length });
  let next = 0;

  async function worker(): Promise<void> {
    while (next < inputs.length) {
      const index = next;

      next += 1;
      results[index] = await task(inputs[index] as Input);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, () => worker()),
  );

  return results;
}

async function recentStats(filePath: string, cutoffMs: number) {
  try {
    const stats = await fs.stat(filePath);

    return stats.isFile() && stats.mtimeMs >= cutoffMs ? stats : null;
  } catch {
    return null;
  }
}

async function completeSummary(
  chat: NativeChatCore,
): Promise<NativeChatSummary> {
  const description = await describeCwd(chat.cwd);

  return { ...chat, ...description };
}

class DropCounter {
  private readonly counts = new Map<
    NativeProviderId,
    Map<ScanDropReason, number>
  >();

  add(providerId: NativeProviderId, reason: ScanDropReason): void {
    const reasons = this.counts.get(providerId) ?? new Map();

    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    this.counts.set(providerId, reasons);
  }

  list(): ScanOutput["dropped"] {
    return [...this.counts.entries()]
      .flatMap(([providerId, reasons]) =>
        [...reasons.entries()].map(([reason, count]) => ({
          providerId,
          reason,
          count,
        })),
      )
      .sort(
        (left, right) =>
          left.providerId.localeCompare(right.providerId) ||
          left.reason.localeCompare(right.reason),
      );
  }
}

async function settle(
  providerId: NativeProviderId,
  summarize: () => Promise<NativeSummaryResult>,
  drops: DropCounter,
  signal: AbortSignal | undefined,
): Promise<NativeChatSummary | null> {
  let result: NativeSummaryResult;

  try {
    result = await summarize();
  } catch {
    signal?.throwIfAborted();
    result = { kind: "dropped", reason: "unreadable" };
  }

  if (result.kind === "dropped") {
    drops.add(providerId, result.reason);

    return null;
  }

  return completeSummary(result.chat);
}

async function scanCodex(
  roots: NativeRoots,
  cutoffMs: number,
  drops: DropCounter,
  signal?: AbortSignal,
): Promise<NativeChatSummary[]> {
  const rollouts = await listCodexRollouts(
    codexSessionsDir(roots.codexHome),
    signal,
  );

  const titles = await readCodexTitleIndex(roots.codexHome, signal);

  const summaries = await mapWithConcurrency(
    rollouts,
    SCAN_CONCURRENCY,
    async (filePath) => {
      const stats = await recentStats(filePath, cutoffMs);

      if (stats === null) return null;

      return settle(
        "codex",
        () =>
          summarizeCodexRollout(filePath, stats, { cutoffMs, titles, signal }),
        drops,
        signal,
      );
    },
  );

  return summaries.filter((chat) => chat !== null);
}

async function scanClaude(
  environment: NativeHostEnvironment,
  roots: NativeRoots,
  cutoffMs: number,
  drops: DropCounter,
  signal?: AbortSignal,
): Promise<NativeChatSummary[]> {
  const sessions = await listClaudeSessions(
    claudeProjectsDir(roots.claudeConfigDir),
    signal,
  );

  const summaries = await mapWithConcurrency(
    sessions,
    SCAN_CONCURRENCY,
    async (session) => {
      const stats = await recentStats(session.filePath, cutoffMs);

      if (stats === null) return null;

      return settle(
        "claude-code",
        () =>
          summarizeClaudeSession(session, stats, {
            cutoffMs,
            platform: environment.platform,
            signal,
          }),
        drops,
        signal,
      );
    },
  );

  return summaries.filter((chat) => chat !== null);
}

export async function scanNativeChats(
  environment: NativeHostEnvironment,
  input: ScanInput,
  signal?: AbortSignal,
): Promise<ScanOutput> {
  const roots = resolveNativeRoots(environment);
  const cutoffMs = input.nowMs - input.days * DAY_MS;
  const drops = new DropCounter();

  const [codexExists, claudeExists] = await Promise.all([
    isDirectory(roots.codexHome),
    isDirectory(roots.claudeConfigDir),
  ]);

  const [codexChats, claudeChats, resolvedPaths] = await Promise.all([
    codexExists ? scanCodex(roots, cutoffMs, drops, signal) : [],
    claudeExists ? scanClaude(environment, roots, cutoffMs, drops, signal) : [],
    resolveRequestedPaths(input.resolvePaths),
  ]);

  const chats = [...codexChats, ...claudeChats].sort(
    (left, right) =>
      right.lastMessageAt - left.lastMessageAt ||
      left.sourcePath.localeCompare(right.sourcePath),
  );

  return {
    roots: {
      codex: codexExists ? roots.codexHome : null,
      claude: claudeExists ? roots.claudeConfigDir : null,
    },
    homeDir: roots.homeDir,
    chats,
    dropped: drops.list(),
    resolvedPaths,
  };
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

function resolveRequestedPaths(
  paths: readonly string[],
): Promise<ScanOutput["resolvedPaths"]> {
  return mapWithConcurrency(paths, SCAN_CONCURRENCY, async (requested) => ({
    path: requested,
    realPath: path.isAbsolute(requested)
      ? await realpathOrNull(requested)
      : null,
  }));
}

async function assertNativeSource(
  roots: NativeRoots,
  input: ReadChatInput,
): Promise<string> {
  const storeRoot =
    input.providerId === "codex"
      ? codexSessionsDir(roots.codexHome)
      : claudeProjectsDir(roots.claudeConfigDir);

  const [realRoot, realSource] = await Promise.all([
    realpathOrNull(storeRoot),
    realpathOrNull(input.sourcePath),
  ]);

  if (
    realRoot === null ||
    realSource === null ||
    !path.isAbsolute(input.sourcePath) ||
    !isPathInside(realRoot, realSource)
  )
    throw new Error("The chat file is not inside this agent's chat store.");
  const name = path.basename(realSource);
  const relativeSegments = path.relative(realRoot, realSource).split(path.sep);

  const validName =
    input.providerId === "codex"
      ? isCodexRolloutName(name)
      : relativeSegments.length === 2 &&
        name === `${input.sourceProviderThreadId}.jsonl`;

  if (!validName) throw new Error("The chat file is not a chat transcript.");
  const stats = await fs.lstat(realSource);

  if (!stats.isFile()) throw new Error("The chat file is not a regular file.");

  return realSource;
}

function identityRefusal(): Error {
  return new Error(
    "The chat file does not belong to the requested chat. Scan again and retry.",
  );
}

export async function readNativeChat(
  environment: NativeHostEnvironment,
  input: ReadChatInput,
  signal?: AbortSignal,
): Promise<ReadChatOutput> {
  const roots = resolveNativeRoots(environment);
  const realSource = await assertNativeSource(roots, input);
  const stats = await fs.stat(realSource);
  let summaryResult: NativeSummaryResult;

  if (input.providerId === "codex") {
    const titles = await readCodexTitleIndex(roots.codexHome, signal);

    summaryResult = await summarizeCodexRollout(realSource, stats, {
      cutoffMs: 0,
      titles,
      signal,
    });
  } else {
    summaryResult = await summarizeClaudeSession(
      {
        filePath: realSource,
        projectDirName: path.basename(path.dirname(realSource)),
        sessionId: input.sourceProviderThreadId,
      },
      stats,
      { cutoffMs: 0, platform: environment.platform, signal },
    );
  }

  if (summaryResult.kind === "dropped")
    throw new Error(`This chat cannot be imported (${summaryResult.reason}).`);

  if (
    summaryResult.chat.sourceProviderThreadId !== input.sourceProviderThreadId
  )
    throw identityRefusal();

  const transcript =
    input.providerId === "codex"
      ? await readCodexTranscript(
          realSource,
          input.sourceProviderThreadId,
          summaryResult.chat.cwd,
          signal,
        )
      : await readClaudeTranscript(
          realSource,
          input.sourceProviderThreadId,
          signal,
        );

  if (!transcript.identityMatches) throw identityRefusal();

  const summary = await completeSummary({
    ...summaryResult.chat,
    sourcePath: input.sourcePath,
  });

  const turns = finalizeTurns(transcript.turns);

  const envelope = {
    summary,
    turns: [],
    totalTurns: turns.length,
    omittedTurns: turns.length,
    skippedLines: transcript.skippedLines,
  };

  const fitted = fitTurnsToBudget(turns, envelope);

  return readChatOutputSchema.parse({
    summary,
    turns: fitted.turns,
    totalTurns: fitted.totalTurns,
    omittedTurns: fitted.omittedTurns,
    skippedLines: transcript.skippedLines,
  });
}

export function createChatImporterHostEntry(
  environment: NativeHostEnvironment,
) {
  return experimental_defineHostEntry({
    contract: chatImporterHostContract,
    handlers: {
      scan: (input, context) =>
        scanNativeChats(environment, input, context.signal),
      readChat: (input, context) =>
        readNativeChat(environment, input, context.signal),
    },
  });
}

export default createChatImporterHostEntry({
  homeDir: os.homedir(),
  env: process.env,
  platform: process.platform,
});
