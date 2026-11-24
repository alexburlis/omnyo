import type { PluginApi } from "@omnyo/plugin-sdk";
import type { PredictionSkipReason, PredictionState } from "./contract";

export const READ_TIMEOUT_MS = 10_000;

export class PredictionReadinessError extends Error {
  constructor(subject: string, timedOut: boolean) {
    super(
      timedOut
        ? `Checking ${subject} timed out. Retry the prediction.`
        : `Could not check ${subject}. Retry when Omnyo is available.`,
    );
  }
}

export async function checkRead<T>(
  subject: string,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);

  try {
    return await read(signal);
  } catch (error) {
    throw new PredictionReadinessError(
      subject,
      signal.aborted ||
        (error instanceof Error && error.name === "TimeoutError"),
    );
  }
}

type ListedThread = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["list"]>
>[number];

async function listedThread(
  api: PluginApi,
  threadId: string,
): Promise<ListedThread | undefined> {
  const [thread] = await checkRead("chat work status", (signal) =>
    api.sdk.threads.list({
      threadIds: [threadId],
      includeHidden: true,
      signal,
    }),
  );

  return thread;
}

type WorkOwners = {
  activity: readonly unknown[];
  waits: readonly unknown[];
} | null;

export function ownsNextStep(work: WorkOwners): boolean {
  return (work?.activity.length ?? 0) > 0 || (work?.waits.length ?? 0) > 0;
}

export function omitsRequiredReply(
  state: Pick<PredictionState, "status" | "text">,
  work: WorkOwners,
): boolean {
  return state.status === "ready" && state.text === null && !ownsNextStep(work);
}

function suggestionBlocker(
  thread: ListedThread | undefined,
  background: boolean,
): PredictionSkipReason | null {
  if (!thread || thread.archivedAt !== null || thread.deletedAt !== null)
    return "closed";

  if (thread.status !== "idle" || thread.runtime.displayStatus !== "idle")
    return "busy";

  if (
    thread.hasPendingInteraction ||
    (thread.work?.requiredInput.length ?? 0) > 0
  )
    return "awaiting-answer";

  if (thread.queuedWork !== "none") return "queued";

  if (background && thread.parentThreadId !== null) return "child";

  if (background && thread.visibility !== "visible") return "hidden";

  if (background && ownsNextStep(thread.work)) return "owned-work";

  return null;
}

export async function predictionAdmission(
  api: PluginApi,
  threadId: string,
  background = false,
): Promise<{
  blocker: PredictionSkipReason | null;
  backgroundOnly: boolean;
  work: ListedThread["work"];
}> {
  const thread = await listedThread(api, threadId);
  const blocker = suggestionBlocker(thread, background);

  return {
    blocker,
    backgroundOnly:
      blocker !== null && suggestionBlocker(thread, false) === null,
    work: thread?.work ?? null,
  };
}
