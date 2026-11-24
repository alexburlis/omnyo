import type { ThreadStatus, ThreadTimelinePendingTodos } from "@omnyo/domain";
import type {
  ProjectResponse,
  ThreadListResponse,
  ThreadResponse,
  ThreadTimelineResponse,
  ThreadWithIncludesResponse,
} from "@omnyo/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface StatusGetArgs {
  projectId?: string;
  signal?: AbortSignal;
  threadId?: string;
}

export interface StatusThreadSummary {
  environmentId: string | null;
  id: string;
  parentThreadId: string | null;
  pinnedAt: number | null;
  projectId: string;
  shelvedAt: number | null;
  status: ThreadStatus;
  title: string | null;
}

export type StatusProject = ProjectResponse;

export type StatusSourceThread = ThreadResponse | ThreadWithIncludesResponse;

export type StatusChildThreads = ThreadListResponse;

export type StatusTimeline = ThreadTimelineResponse;

export interface StatusResult {
  childThreads: StatusChildThreads | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  project: StatusProject | null;
  thread: StatusThreadSummary | null;
}

export interface StatusArea {
  get(args?: StatusGetArgs): Promise<StatusResult>;
}

async function fetchSilent<TValue>(
  fn: () => Promise<TValue>,
): Promise<TValue | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function summarizeThread(thread: StatusSourceThread): StatusThreadSummary {
  return {
    environmentId: thread.environmentId ?? null,
    id: thread.id,
    parentThreadId: thread.parentThreadId ?? null,
    pinnedAt: thread.pinnedAt,
    projectId: thread.projectId,
    shelvedAt: thread.shelvedAt,
    status: thread.status,
    title: thread.title ?? null,
  };
}

export function createStatusArea(args: CreateSdkAreaArgs): StatusArea {
  const { transport } = args;

  return {
    async get(input = {}) {
      const projectId = input.projectId;
      const signal = input.signal;
      const threadId = input.threadId;

      const [project, thread] = await Promise.all([
        projectId
          ? fetchSilent(() =>
              transport.readJson(
                transport.api.v1.projects[":id"].$get(
                  {
                    param: { id: projectId },
                  },
                  ...signalRequestArgs(signal),
                ),
              ),
            )
          : Promise.resolve(null),
        threadId
          ? fetchSilent(() =>
              transport.readJson(
                transport.api.v1.threads[":id"].$get(
                  {
                    param: { id: threadId },
                  },
                  ...signalRequestArgs(signal),
                ),
              ),
            )
          : Promise.resolve(null),
      ]);

      const [pendingTodos, childThreads] = await Promise.all([
        thread === null
          ? null
          : fetchSilent(async () => {
              const timeline: StatusTimeline = await transport.readJson(
                transport.api.v1.threads[":id"].timeline.$get(
                  {
                    param: { id: thread.id },
                    query: { summaryOnly: "true" },
                  },
                  ...signalRequestArgs(signal),
                ),
              );

              return timeline.pendingTodos;
            }),
        thread === null
          ? null
          : fetchSilent(() =>
              transport.readJson(
                transport.api.v1.threads.$get(
                  {
                    query: { parentThreadId: thread.id },
                  },
                  ...signalRequestArgs(signal),
                ),
              ),
            ),
      ]);

      return {
        childThreads,
        pendingTodos,
        project,
        thread: thread === null ? null : summarizeThread(thread),
      };
    },
  };
}
