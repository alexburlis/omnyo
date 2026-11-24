import {
  cliCommand,
  defineCli,
  PluginCliError,
  type PluginApi,
} from "@omnyo/plugin-sdk";
import type { PluginEnvironmentProviderRemoveResult } from "@omnyo/plugin-sdk/environment-provider";
import { z } from "zod";
import {
  branchSelectionSchema,
  MAX_CHUNK_BYTES,
  temporaryCopyHostContract,
  type CopyRefPayload,
} from "./contract.js";
import { TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

const SNAPSHOT_TIMEOUT_MS = 10 * 60 * 1000;

const CHUNK_TIMEOUT_MS = 2 * 60 * 1000;

const REMOVE_TIMEOUT_MS = 15 * 60 * 1000;

const COPY_KEY_PREFIX = "copy:";

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

export const temporaryCopyInputsSchema = z
  .object({
    sourceHostId: z.string().min(1),
    sourcePath: z.string().min(1),
    worktree: z
      .object({ branch: branchSelectionSchema.default({ kind: "default" }) })
      .strict()
      .default({ branch: { kind: "default" } }),
  })
  .strict();

const copyRecordSchema = z.object({
  threadId: z.string().min(1),
  sourceHostId: z.string().min(1),
  sourcePath: z.string().min(1),
  targetHostId: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  baseCommit: z.string().min(1),
  removalConfirmedAt: z.number().int().nonnegative().optional(),
  originCheckout: z.string().min(1).optional(),
  originBase: z.string().min(1).optional(),
});

type CopyRecord = z.infer<typeof copyRecordSchema>;

interface CopyBackResult {
  refs: CopyRefPayload[];
  sideRefs: CopyRefPayload[];
  branchUpdated: boolean;
  unsaved: string | null;
}

interface PullResult {
  pulled: boolean;
  tip: string | null;
  fastForwarded: boolean;
  changes: string[];
}

const NOTHING_PULLED: PullResult = {
  pulled: false,
  tip: null,
  fastForwarded: false,
  changes: [],
};

interface EarlierStep {
  pull: PullResult | null;
  error: string | null;
  kept: string | null;
}

const BUSY_STEP_STATUSES = new Set(["starting", "running", "disconnected"]);

const RUN_POLL_MS = 2000;

const RUN_LIMIT_MS = 60 * 60 * 1000;

const OUTPUT_TAIL_BYTES = 200 * 1024;

const SAFE_ARGUMENT = /^[A-Za-z0-9_\-./:=@%+,]+$/u;

function shellCommand(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0] ?? "";

  return parts
    .map((part) =>
      SAFE_ARGUMENT.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

function describePull(result: PullResult, originName: string): string | null {
  const lines: string[] = [];

  if (result.pulled) {
    lines.push(
      result.fastForwarded
        ? `Brought back the commits it made; this copy is now at ${(result.tip ?? "").slice(0, 12)}.`
        : `${sentenceStart(originName)} has commits this copy could not fast-forward to; they are at refs/omnyo/from-origin in the copy.`,
    );
  }

  if (result.changes.length > 0) {
    lines.push(
      `Uncommitted changes it left on ${originName}, not copied back: ${result.changes.join(", ")}.`,
    );
  }

  return lines.length === 0 ? null : lines.join("\n");
}

function describeEarlier(
  earlier: EarlierStep,
  originName: string,
): string | null {
  const lines: string[] = [];

  if (earlier.error !== null) {
    lines.push(
      `Could not bring back the commits the earlier step made: ${earlier.error}`,
    );
  }

  if (earlier.pull?.pulled === true) {
    lines.push(
      earlier.pull.fastForwarded
        ? `Brought back the commits the earlier step made; this copy is now at ${(earlier.pull.tip ?? "").slice(0, 12)}.`
        : `${sentenceStart(originName)} has commits from the earlier step that this copy could not fast-forward to; they are at refs/omnyo/from-origin in the copy.`,
    );
  }

  const discarded = earlier.pull?.changes ?? [];

  if (discarded.length > 0) {
    lines.push(
      `The earlier step's uncommitted changes on ${originName} were discarded: ${discarded.join(", ")}.`,
    );
  }

  if (earlier.kept !== null) {
    lines.push(
      `Kept commits an earlier step made on ${originName} at ${earlier.kept} before resetting its checkout.`,
    );
  }

  return lines.length === 0 ? null : `Before running: ${lines.join(" ")}`;
}

function withPeriod(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

function originCommand(threadId: string, command: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(threadId)) {
    throw new PluginCliError(`Thread ${threadId} is not a valid thread id`, {
      code: "invalid_thread",
    });
  }

  const canonicalSetup = ".omnyo-env-setup.sh";
  const legacySetupV1 = ".bb-env-setup.sh";
  const setup = `if [ -e ${canonicalSetup} ] || [ -L ${canonicalSetup} ]; then if [ -e ${legacySetupV1} ] || [ -L ${legacySetupV1} ]; then printf '%s\\n' 'Both setup hook files are present; keep one before running the command.' >&2; exit 1; fi; env bash ${canonicalSetup} || exit "$?"; elif [ -e ${legacySetupV1} ] || [ -L ${legacySetupV1} ]; then env bash ${legacySetupV1} || exit "$?"; fi`;

  return `export OMNYO_THREAD_ID=${threadId}; ${setup}; ${command}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyKey(threadId: string): string {
  return `${COPY_KEY_PREFIX}${threadId}`;
}

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function copyInstructions(target: string, origin: string): string {
  return [
    `This chat runs in a temporary copy on ${target}; its original checkout is on ${origin}.`,
    `${sentenceStart(target)} may lack tools ${origin} has, such as Xcode, simulators or release access, and the copy has no git remote.`,
    `Commit here as usual; commits return to ${origin} after each turn.`,
    `To run anything that needs ${origin}, such as an Xcode build, a simulator, \`git push\` or a release, run \`omnyo temporary-copy run "$OMNYO_THREAD_ID" -- <command>\`.`,
    `It sends your commits and uncommitted changes, runs the command on ${origin} in a checkout of this chat's branch, prints the output and brings back commits the command made.`,
    `For a job longer than about ten minutes add \`--detach\`, follow it with \`omnyo terminal output <terminal-id>\`, then run \`omnyo temporary-copy pull "$OMNYO_THREAD_ID"\`.`,
  ].join(" ");
}

export default async function temporaryCopyPlugin(
  api: PluginApi,
): Promise<void> {
  const host = api.hosts.experimental_client({
    contract: temporaryCopyHostContract,
  });

  const chains = new Map<string, Promise<void>>();
  const records = new Map<string, CopyRecord>();
  const hostNames = new Map<string, string>();

  async function refreshHostNames(): Promise<void> {
    try {
      for (const available of await api.sdk.hosts.list()) {
        hostNames.set(available.id, available.name);
      }
    } catch (error) {
      api.log.warn(`Could not read machine names: ${errorMessage(error)}`);
    }
  }

  async function saveRecord(record: CopyRecord): Promise<void> {
    await api.storage.kv.set(copyKey(record.threadId), record);
    records.set(record.threadId, record);
  }

  async function dropRecord(threadId: string): Promise<void> {
    await api.storage.kv.delete(copyKey(threadId));
    records.delete(threadId);
  }

  function serialized<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const previous = chains.get(threadId) ?? Promise.resolve();
    const next = previous.then(run, run);

    chains.set(
      threadId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );

    return next;
  }

  async function relay(args: {
    fromHostId: string;
    toHostId: string;
    snapshotId: string;
    size: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const signal = args.signal === undefined ? {} : { signal: args.signal };

    for (let offset = 0; offset < args.size; offset += MAX_CHUNK_BYTES) {
      const length = Math.min(MAX_CHUNK_BYTES, args.size - offset);

      for (let attempt = 1; ; attempt += 1) {
        try {
          const chunk = await host.call(
            "readRelay",
            { snapshotId: args.snapshotId, offset, length },
            { hostId: args.fromHostId, timeoutMs: CHUNK_TIMEOUT_MS, ...signal },
          );

          await host.call(
            "appendRelay",
            { snapshotId: args.snapshotId, offset, ...chunk },
            { hostId: args.toHostId, timeoutMs: CHUNK_TIMEOUT_MS, ...signal },
          );

          break;
        } catch (error) {
          if (attempt >= 2 || args.signal?.aborted === true) throw error;
          api.log.warn(
            `Retrying chunk ${offset} of ${args.snapshotId}: ${errorMessage(error)}`,
          );
        }
      }
    }
  }

  async function deleteRelays(
    hostIds: readonly string[],
    snapshotId: string,
  ): Promise<void> {
    await Promise.all(
      [...new Set(hostIds)].map(async (hostId) => {
        try {
          await host.call("deleteRelay", { snapshotId }, { hostId });
        } catch (error) {
          api.log.warn(
            `Could not delete relay file ${snapshotId} on ${hostId}; the host sweep removes it within a day: ${errorMessage(error)}`,
          );
        }
      }),
    );
  }

  async function copyBackNow(
    record: CopyRecord,
    options: { recordUnsaved: boolean },
  ): Promise<CopyBackResult> {
    const snapshotId = `sync-${record.threadId}-${Date.now()}`;

    try {
      const { shas: haves } = await host.call(
        "listSideRefs",
        { sourcePath: record.sourcePath, threadId: record.threadId },
        { hostId: record.sourceHostId, timeoutMs: SNAPSHOT_TIMEOUT_MS },
      );

      const prepared = await host.call(
        "prepareCopyBack",
        {
          snapshotId,
          path: record.path,
          baseCommit: record.baseCommit,
          baseRef: record.baseRef,
          haves,
          recordUnsaved: options.recordUnsaved,
        },
        { hostId: record.targetHostId, timeoutMs: SNAPSHOT_TIMEOUT_MS },
      );

      await relay({
        fromHostId: record.targetHostId,
        toHostId: record.sourceHostId,
        snapshotId,
        size: prepared.size,
      });

      const applied = await host.call(
        "applyCopyBack",
        {
          snapshotId,
          sourcePath: record.sourcePath,
          threadId: record.threadId,
          branch: record.branch,
          baseCommit: record.baseCommit,
          refs: prepared.refs,
          size: prepared.size,
          sha256: prepared.sha256,
        },
        { hostId: record.sourceHostId, timeoutMs: SNAPSHOT_TIMEOUT_MS },
      );

      return { refs: prepared.refs, unsaved: prepared.unsaved, ...applied };
    } finally {
      await deleteRelays(
        [record.targetHostId, record.sourceHostId],
        snapshotId,
      );
    }
  }

  function copyBack(
    record: CopyRecord,
    options: { recordUnsaved: boolean },
  ): Promise<CopyBackResult> {
    return serialized(record.threadId, () => copyBackNow(record, options));
  }

  async function pullNow(record: CopyRecord): Promise<PullResult> {
    if (
      record.originCheckout === undefined ||
      record.originBase === undefined
    ) {
      return NOTHING_PULLED;
    }

    const checkout = await host.call(
      "readOriginCheckout",
      {
        sourcePath: record.sourcePath,
        threadId: record.threadId,
        base: record.originBase,
      },
      { hostId: record.sourceHostId, timeoutMs: SNAPSHOT_TIMEOUT_MS },
    );

    if (checkout === null) return NOTHING_PULLED;

    const { head: tip, changes } = checkout;

    if (!checkout.newCommits) {
      return { pulled: false, tip, fastForwarded: false, changes };
    }

    const snapshotId = `pull-${record.threadId}-${Date.now()}`;

    try {
      const packed = await host.call(
        "writeOriginPack",
        {
          snapshotId,
          sourcePath: record.sourcePath,
          tip,
          base: record.originBase,
        },
        { hostId: record.sourceHostId, timeoutMs: SNAPSHOT_TIMEOUT_MS },
      );

      await relay({
        fromHostId: record.sourceHostId,
        toHostId: record.targetHostId,
        snapshotId,
        size: packed.size,
      });

      const { fastForwarded } = await host.call(
        "applyOriginPack",
        {
          snapshotId,
          path: record.path,
          tip,
          expectedHead: record.originBase,
          size: packed.size,
          sha256: packed.sha256,
        },
        { hostId: record.targetHostId, timeoutMs: SNAPSHOT_TIMEOUT_MS },
      );

      if (fastForwarded) await saveRecord({ ...record, originBase: tip });

      return { pulled: true, tip, fastForwarded, changes };
    } catch (error) {
      const kept =
        checkout.keptAt === null
          ? ""
          : ` They are kept at ${checkout.keptAt} in ${record.sourcePath} on ${machineName(record.sourceHostId)}.`;

      throw new Error(`${withPeriod(errorMessage(error))}${kept}`, {
        cause: error,
      });
    } finally {
      await deleteRelays(
        [record.sourceHostId, record.targetHostId],
        snapshotId,
      );
    }
  }

  async function stepTerminals(record: CopyRecord, path: string) {
    const { sessions } = await api.sdk.terminals.list({
      scope: { kind: "host_path", hostId: record.sourceHostId, cwd: path },
    });

    return sessions;
  }

  async function closeTerminals(
    sessions: ReadonlyArray<{ id: string }>,
  ): Promise<void> {
    await Promise.all(
      sessions.map((session) =>
        api.sdk.terminals.close({ terminalId: session.id, mode: "force" }),
      ),
    );
  }

  function refuseBusyStep(
    record: CopyRecord,
    sessions: ReadonlyArray<{ id: string; status: string }>,
  ): void {
    const busy = sessions.find((session) =>
      BUSY_STEP_STATUSES.has(session.status),
    );

    if (busy === undefined) return;

    const origin = machineName(record.sourceHostId);
    const follow = `follow it with \`omnyo terminal output ${busy.id}\`, then run \`omnyo temporary-copy pull ${record.threadId}\`.`;

    throw new PluginCliError(
      busy.status === "disconnected"
        ? `A step on ${origin} lost its connection as terminal ${busy.id} and may still be running. Wait for ${origin} to reconnect, then ${follow}`
        : `A step is still running on ${origin} as terminal ${busy.id}. ${sentenceStart(follow)}`,
      { code: "step_running" },
    );
  }

  function refuseDuringRemoval(record: CopyRecord): void {
    if (record.removalConfirmedAt !== undefined) {
      throw new PluginCliError(
        `Thread ${record.threadId}'s temporary copy is being removed`,
        { code: "removing" },
      );
    }
  }

  async function removeOriginCheckout(
    record: CopyRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const origin = machineName(record.sourceHostId);

    if (record.originCheckout !== undefined) {
      const sessions = await stepTerminals(record, record.originCheckout);

      const reconnecting = sessions.find(
        (session) => session.status === "disconnected",
      );

      if (reconnecting !== undefined) {
        throw new Error(
          `a step on ${origin} lost its connection as terminal ${reconnecting.id}, so its checkout stays until the step can be stopped`,
        );
      }

      await closeTerminals(sessions);
    }

    const { kept } = await host.call(
      "removeOriginCheckout",
      { sourcePath: record.sourcePath, threadId: record.threadId },
      { hostId: record.sourceHostId, signal, timeoutMs: REMOVE_TIMEOUT_MS },
    );

    if (kept !== null) {
      api.log.info(
        `Kept commits a step made on ${origin} for ${record.threadId} at ${kept} in ${record.sourcePath}; they never came back to the copy.`,
      );
    }
  }

  function machineName(hostId: string): string {
    return hostNames.get(hostId) ?? "the original machine";
  }

  async function requireRecord(threadId: string): Promise<CopyRecord> {
    const record = await readRecord(threadId);

    if (record === null) {
      throw new PluginCliError(
        `Thread ${threadId} is not running in a temporary copy`,
        { code: "not_a_copy" },
      );
    }

    return record;
  }

  async function prepareRun(current: CopyRecord): Promise<{
    record: CopyRecord;
    path: string;
    earlier: EarlierStep | null;
  }> {
    let record = current;
    let pull: PullResult | null = null;
    let error: string | null = null;

    if (record.originCheckout !== undefined) {
      const sessions = await stepTerminals(record, record.originCheckout);
      refuseBusyStep(record, sessions);
      await closeTerminals(sessions);

      try {
        pull = await pullNow(record);
      } catch (caught) {
        error = errorMessage(caught);
      }

      record = (await readRecord(record.threadId)) ?? record;
    }

    const synced = await copyBackNow(record, { recordUnsaved: true });
    const head = synced.refs.find((ref) => ref.name === "HEAD")?.sha;

    if (head === undefined) {
      throw new PluginCliError(
        `Thread ${record.threadId}'s copy has no current commit`,
        { code: "no_head" },
      );
    }

    const { path, kept } = await host.call(
      "prepareOriginCheckout",
      {
        sourcePath: record.sourcePath,
        threadId: record.threadId,
        head,
        unsaved: synced.unsaved,
      },
      { hostId: record.sourceHostId, timeoutMs: SNAPSHOT_TIMEOUT_MS },
    );

    const prepared = { ...record, originCheckout: path, originBase: head };
    await saveRecord(prepared);

    const reportable =
      error !== null ||
      kept !== null ||
      pull?.pulled === true ||
      (pull?.changes.length ?? 0) > 0;

    return {
      record: prepared,
      path,
      earlier: reportable ? { pull, error, kept } : null,
    };
  }

  async function followTerminal(terminalId: string) {
    const output: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let sinceSeq = 0;
    const deadline = Date.now() + RUN_LIMIT_MS;

    for (;;) {
      const page = await api.sdk.terminals.output({ terminalId, sinceSeq });

      for (const chunk of page.chunks) {
        const data = Buffer.from(chunk.dataBase64, "base64");
        output.push(data);
        bytes += data.length;

        while (bytes > OUTPUT_TAIL_BYTES && output.length > 1) {
          bytes -= output.shift()?.length ?? 0;
          truncated = true;
        }
      }

      sinceSeq = page.nextSeq;

      if (page.status === "exited" || page.status === "disconnected") {
        return {
          finished: page.status === "exited",
          exitCode: page.exitCode,
          output: Buffer.concat(output).toString("utf8"),
          truncated,
        };
      }

      if (Date.now() > deadline) {
        return {
          finished: false,
          exitCode: null,
          output: Buffer.concat(output).toString("utf8"),
          truncated,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
    }
  }

  async function readRecord(threadId: string): Promise<CopyRecord | null> {
    const stored = await api.storage.kv.get<unknown>(copyKey(threadId));

    if (stored === undefined || stored === null) return null;

    const parsed = copyRecordSchema.safeParse(stored);

    if (!parsed.success) {
      api.log.warn(
        `Ignoring an unreadable temporary copy record for ${threadId}: ${parsed.error.message}`,
      );

      return null;
    }

    return parsed.data;
  }

  async function discardUnusedCopy(
    threadId: string,
    hostId: string,
    path: string,
  ): Promise<void> {
    try {
      await host.call(
        "removeCopy",
        { path },
        { hostId, timeoutMs: REMOVE_TIMEOUT_MS },
      );
      await dropRecord(threadId);
    } catch (error) {
      api.log.warn(
        `Could not delete the unused temporary copy ${path} on ${hostId}: ${errorMessage(error)}`,
      );
    }
  }

  async function copyBackQuietly(threadId: string): Promise<void> {
    const record = await readRecord(threadId);

    if (record === null || record.removalConfirmedAt !== undefined) return;

    try {
      await copyBack(record, { recordUnsaved: false });
    } catch (error) {
      api.log.warn(
        `Could not copy ${threadId}'s commits back yet; the next turn end and removal try again: ${errorMessage(error)}`,
      );
    }
  }

  api.experimental_environments.register({
    id: TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID,
    displayName: "Temporary copy",
    description:
      "Run on a free machine in a copy of the project; commits return to the original checkout.",
    icon: "Copy",
    requires: {},
    inputs: temporaryCopyInputsSchema,
    policy: { pathKeys: "per-attempt" },
    async create(context) {
      const { sourceHostId, sourcePath, worktree } = context.inputs;
      const snapshotId = `${context.pathKey}-${context.attempt}`;
      const baseRef = `omnyo-base/${context.thread.id}`;
      let builtPath: string | null = null;

      try {
        context.report.step("Copying the project to this machine…");

        const snapshot = await host.call(
          "createSnapshot",
          { snapshotId, sourcePath, branch: worktree.branch },
          {
            hostId: sourceHostId,
            signal: context.signal,
            timeoutMs: SNAPSHOT_TIMEOUT_MS,
          },
        );

        await relay({
          fromHostId: sourceHostId,
          toHostId: context.host.id,
          snapshotId,
          size: snapshot.size,
          signal: context.signal,
        });

        const { path } = await host.call(
          "materialize",
          {
            snapshotId,
            pathKey: context.pathKey,
            branch: context.suggestedBranchName,
            baseRef,
            baseCommit: snapshot.commit,
            size: snapshot.size,
            sha256: snapshot.sha256,
          },
          {
            hostId: context.host.id,
            signal: context.signal,
            timeoutMs: SNAPSHOT_TIMEOUT_MS,
          },
        );

        builtPath = path;

        const record: CopyRecord = {
          threadId: context.thread.id,
          sourceHostId,
          sourcePath,
          targetHostId: context.host.id,
          path,
          branch: context.suggestedBranchName,
          baseRef,
          baseCommit: snapshot.commit,
        };

        await refreshHostNames();
        await saveRecord(record);

        return {
          status: "created",
          path,
          ownsPath: true,
          mergeBaseBranch: baseRef,
          resource: record,
        };
      } catch (error) {
        if (builtPath !== null) {
          await discardUnusedCopy(
            context.thread.id,
            context.host.id,
            builtPath,
          );
        }

        if (context.signal.aborted) throw error;

        return {
          status: "failed",
          message: `Could not copy the project: ${errorMessage(error)}`,
        };
      } finally {
        await deleteRelays([sourceHostId, context.host.id], snapshotId);
      }
    },
    async remove(context) {
      const parsed = copyRecordSchema.safeParse(context.resource);

      if (!parsed.success && context.resource !== null) {
        return {
          status: "failed",
          message:
            "Kept the temporary copy because its saved details could not be read.",
        };
      }

      if (!parsed.success) {
        if (context.hostId !== null && context.path !== null) {
          await host.call(
            "removeCopy",
            { path: context.path },
            {
              hostId: context.hostId,
              signal: context.signal,
              timeoutMs: REMOVE_TIMEOUT_MS,
            },
          );
        }

        return { status: "removed" };
      }

      const resource = parsed.data;

      return serialized(resource.threadId, () =>
        removeTrackedCopy(resource, context.signal),
      );
    },
  });

  async function removeTrackedCopy(
    resource: CopyRecord,
    signal: AbortSignal,
  ): Promise<PluginEnvironmentProviderRemoveResult> {
    const record = (await readRecord(resource.threadId)) ?? resource;
    let workSafe = record.removalConfirmedAt !== undefined;

    try {
      const { exists } = await host.call(
        "inspectCopy",
        { path: record.path },
        { hostId: record.targetHostId, signal },
      );

      if (exists && !workSafe) {
        const result = await copyBackNow(record, { recordUnsaved: true });

        const { confirmed } = await host.call(
          "confirmCopyBack",
          {
            sourcePath: record.sourcePath,
            threadId: record.threadId,
            baseCommit: record.baseCommit,
            refs: result.refs,
          },
          {
            hostId: record.sourceHostId,
            signal,
            timeoutMs: SNAPSHOT_TIMEOUT_MS,
          },
        );

        if (!confirmed) {
          return {
            status: "failed",
            message:
              "Could not confirm this chat's work on its original machine, so the temporary copy stays.",
          };
        }

        await saveRecord({ ...record, removalConfirmedAt: Date.now() });
        workSafe = true;
      }

      await removeOriginCheckout(record, signal);

      if (exists) {
        await host.call(
          "removeCopy",
          { path: record.path },
          {
            hostId: record.targetHostId,
            signal,
            timeoutMs: REMOVE_TIMEOUT_MS,
          },
        );
      } else if (!workSafe) {
        api.log.warn(
          `The temporary copy of ${record.threadId} was already gone; its last synced work is under refs/omnyo/temporary-copy/${record.threadId}/ in ${record.sourcePath}.`,
        );
      }

      await dropRecord(record.threadId);

      return { status: "removed" };
    } catch (error) {
      if (signal.aborted) throw error;

      return {
        status: "failed",
        message: workSafe
          ? `This chat's work is safe on its original machine, but deleting the temporary copy failed: ${errorMessage(error)}`
          : `Kept the temporary copy until its work is safe: ${errorMessage(error)}`,
      };
    }
  }

  for (const event of ["thread.idle", "thread.failed"] as const) {
    api.events.on(event, async ({ thread }) => {
      await copyBackQuietly(thread.id);
    });
  }

  await refreshHostNames();

  for (const key of await api.storage.kv.list(COPY_KEY_PREFIX)) {
    const record = await readRecord(key.slice(COPY_KEY_PREFIX.length));

    if (record !== null) records.set(record.threadId, record);
  }

  api.agents.contributeInstructions(({ threadId }) => {
    const record = records.get(threadId);

    return record === undefined
      ? null
      : copyInstructions(
          hostNames.get(record.targetHostId) ?? "this machine",
          hostNames.get(record.sourceHostId) ?? "the original machine",
        );
  });

  api.background.service("copy-back-at-start", {
    async start(signal) {
      for (const key of await api.storage.kv.list(COPY_KEY_PREFIX)) {
        if (signal.aborted) return;
        await copyBackQuietly(key.slice(COPY_KEY_PREFIX.length));
      }
    },
  });

  api.cli.register(
    defineCli({
      name: "temporary-copy",
      summary:
        "Work from a temporary copy with its original machine: sync commits, run steps there",
      description:
        "A chat moved to a free machine without the project runs in a temporary copy. Its commits return to the original checkout after every turn and before the copy is deleted; sync does it now. run runs a command on the original machine, such as an Xcode build, git push or a release, and brings back the commits it made; pull brings back commits from a detached run.",
      commands: {
        sync: cliCommand({
          summary: "Copy this chat's commits back to its original checkout now",
          positionals: [
            {
              name: "thread-id",
              description:
                'The chat running in a temporary copy, for example "$OMNYO_THREAD_ID"',
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const threadId = input.positionals["thread-id"];
            const record = await readRecord(threadId);

            if (record === null) {
              throw new PluginCliError(
                `Thread ${threadId} is not running in a temporary copy`,
                { code: "not_a_copy" },
              );
            }

            const result = await copyBack(record, { recordUnsaved: false });

            const summary = result.branchUpdated
              ? `Copied to ${record.branch} in ${record.sourcePath} on the original machine.`
              : `Copied to refs/omnyo/temporary-copy/${threadId}/ in ${record.sourcePath}; ${record.branch} was not moved because it was rewritten or is checked out there.`;

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({
                    sourceHostId: record.sourceHostId,
                    sourcePath: record.sourcePath,
                    branch: record.branch,
                    branchUpdated: result.branchUpdated,
                    sideRefs: result.sideRefs,
                  })
                : summary,
            };
          },
        }),
        run: cliCommand({
          summary:
            "Run a command on the original machine in a checkout of this chat's branch",
          description:
            "Sends this chat's commits and uncommitted changes to the original machine, runs the command there in a checkout of the chat's branch, prints its output and brings back commits it made. Use it for Xcode builds, simulators, git push and releases.",
          positionals: [
            {
              name: "thread-id",
              description:
                'The chat running in a temporary copy, for example "$OMNYO_THREAD_ID"',
              required: true,
            },
          ],
          passthrough: true,
          options: {
            detach: {
              type: "boolean",
              description:
                "Start the command and return its terminal id without waiting",
            },
            json: JSON_OPTION,
          },
          async run(input) {
            const threadId = input.positionals["thread-id"];
            const command = shellCommand(input.passthrough);

            if (command.trim() === "") {
              throw new PluginCliError(
                'Give the command after --, for example: omnyo temporary-copy run "$OMNYO_THREAD_ID" -- xcodebuild -version',
                { code: "no_command" },
              );
            }

            return serialized(threadId, async () => {
              const record = await requireRecord(threadId);
              refuseDuringRemoval(record);
              const prepared = await prepareRun(record);
              const originName = machineName(prepared.record.sourceHostId);

              const before =
                prepared.earlier === null
                  ? null
                  : describeEarlier(prepared.earlier, originName);

              const terminal = await api.sdk.terminals.create({
                cols: 160,
                rows: 48,
                title: `Step for ${threadId}`,
                scope: {
                  kind: "host_path",
                  hostId: prepared.record.sourceHostId,
                  cwd: prepared.path,
                },
                start: {
                  mode: "command",
                  command: originCommand(threadId, command),
                },
              });

              const lines = (parts: ReadonlyArray<string | null>) =>
                parts.filter((line) => line !== null && line !== "").join("\n");

              const follow = `Follow it with \`omnyo terminal output ${terminal.id}\`, then run \`omnyo temporary-copy pull ${threadId}\`.`;

              if (input.options.detach) {
                return {
                  exitCode: 0,
                  stdout: input.options.json
                    ? JSON.stringify({
                        terminalId: terminal.id,
                        path: prepared.path,
                        earlier: prepared.earlier,
                      })
                    : lines([
                        before,
                        `Started on ${originName} in ${prepared.path} as terminal ${terminal.id}. ${follow}`,
                      ]),
                };
              }

              const followed = await followTerminal(terminal.id);

              if (!followed.finished) {
                return {
                  exitCode: 1,
                  stdout: input.options.json
                    ? JSON.stringify({
                        finished: false,
                        terminalId: terminal.id,
                        path: prepared.path,
                        output: followed.output,
                        truncated: followed.truncated,
                        earlier: prepared.earlier,
                      })
                    : lines([
                        before,
                        followed.output,
                        `The command has not finished on ${originName}; it runs as terminal ${terminal.id}. ${follow}`,
                      ]),
                };
              }

              let pulled = NOTHING_PULLED;
              let pullError: string | null = null;

              try {
                pulled = await pullNow(prepared.record);
              } catch (error) {
                pullError = errorMessage(error);
              }

              const exitCode = followed.exitCode ?? 1;

              return {
                exitCode,
                stdout: input.options.json
                  ? JSON.stringify({
                      exitCode,
                      path: prepared.path,
                      output: followed.output,
                      truncated: followed.truncated,
                      earlier: prepared.earlier,
                      pullError,
                      ...pulled,
                    })
                  : lines([
                      before,
                      followed.output,
                      followed.truncated
                        ? "(Output shortened to its last 200 KiB.)"
                        : null,
                      `Ran on ${originName} in ${prepared.path}: exit ${exitCode}.`,
                      pullError === null
                        ? describePull(pulled, originName)
                        : `Could not bring back the commits it made: ${pullError}`,
                    ]),
              };
            });
          },
        }),
        pull: cliCommand({
          summary:
            "Bring back commits a detached run made on the original machine",
          positionals: [
            {
              name: "thread-id",
              description:
                'The chat running in a temporary copy, for example "$OMNYO_THREAD_ID"',
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const threadId = input.positionals["thread-id"];

            const { record, result } = await serialized(threadId, async () => {
              const current = await requireRecord(threadId);
              refuseDuringRemoval(current);

              if (current.originCheckout !== undefined) {
                refuseBusyStep(
                  current,
                  await stepTerminals(current, current.originCheckout),
                );
              }

              try {
                return { record: current, result: await pullNow(current) };
              } catch (error) {
                throw new PluginCliError(
                  `Could not bring back the commits: ${errorMessage(error)}`,
                  { code: "pull_failed" },
                );
              }
            });

            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(result)
                : (describePull(result, machineName(record.sourceHostId)) ??
                  "Nothing new to bring back."),
            };
          },
        }),
      },
    }),
  );
}
